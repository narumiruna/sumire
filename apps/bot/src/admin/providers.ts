import type { Api, AuthEvent, AuthPrompt, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Inventory } from "@narumitw/sumire-contracts"
import { effectivePolicy, type Policy, type ProviderSettings } from "@narumitw/sumire-policy"
import { assertPublicUrl, readResponseBytes, safeFetch } from "@narumitw/sumire-url-reader/network"
import { AdminError, type AdminStore, token } from "./store.js"

/** Public endpoint fetch with DNS validation at connect time and no credential-bearing redirects. */
export const providerFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
  const response = await safeFetch(
    request.url,
    {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal,
      redirect: "error",
    },
    { signal },
  )
  if (!response.body) return response
  const reader = response.body.getReader()
  let bytes = 0
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          signal.throwIfAborted()
          const part = await reader.read()
          if (part.done) {
            controller.close()
            return
          }
          bytes += part.value.byteLength
          if (bytes > 16 * 1024 * 1024) throw new Error("Provider response exceeded byte limit")
          controller.enqueue(part.value)
        } catch {
          await reader.cancel().catch(() => {})
          controller.error(new Error("Provider response failed"))
        }
      },
      cancel: () => reader.cancel(),
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  )
}

type LoginState = {
  id: string
  provider: string
  owner: string
  status: "pending" | "completed" | "failed" | "cancelled"
  event?: AuthEvent
  prompt?: Omit<AuthPrompt, "signal">
  answer?: (value: string) => void
  controller: AbortController
  done: Promise<void>
}

export class ProviderAdmin {
  readonly logins = new Map<string, LoginState>()
  constructor(
    readonly runtime: ModelRuntime,
    readonly store: AdminStore,
    private readonly credentialsChanged: (provider: string) => Promise<void> = async () => {},
  ) {}
  async validate(policy: Policy) {
    const resolve = (ref: string): Model<Api> | undefined => {
      const index = ref.indexOf("/")
      if (index < 1) return undefined
      const id = ref.slice(0, index)
      const modelId = ref.slice(index + 1)
      const configured = policy.providers.find((p) => p.id === id)
      if (configured?.baseUrl) {
        const model = configured.models.find((m) => m.id === modelId)
        return model
          ? {
              ...model,
              provider: id,
              api: configured.api ?? "openai-completions",
              baseUrl: configured.baseUrl,
              input: model.image ? ["text", "image"] : ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }
          : undefined
      }
      return this.runtime.getPhysicalModel(id, modelId)
    }
    const endpointSignal = AbortSignal.timeout(5000)
    for (const p of policy.providers) {
      if (p.baseUrl) {
        const parsed = new URL(p.baseUrl)
        if (parsed.search || parsed.hash)
          throw new AdminError(400, "Provider endpoints cannot contain a query or fragment")
        await assertPublicUrl(p.baseUrl, { signal: endpointSignal })
      }
    }
    for (const ref of policy.models)
      if (!resolve(ref)) throw new AdminError(400, "Unknown model reference")
    for (const [chat, selection] of [
      [0, policy.defaults],
      ...Object.entries(policy.chats).map(([id, v]) => [Number(id), v] as const),
    ] as const) {
      const ref = selection.model ?? policy.defaults.model
      const level = selection.thinking ?? policy.defaults.thinking ?? "off"
      if (ref) {
        const model = resolve(ref)
        if (model && !getSupportedThinkingLevels(model).includes(level))
          throw new AdminError(400, `Unsupported thinking level for chat ${chat}`)
      }
    }
  }
  install(providers: ProviderSettings[]) {
    for (const id of this.runtime.getRegisteredProviderIds()) this.runtime.unregisterProvider(id)
    for (const p of providers) {
      if (!p.baseUrl) continue
      this.runtime.registerProvider(p.id, {
        baseUrl: p.baseUrl,
        api: p.api,
        models: p.models.map((m) => ({
          ...m,
          input: m.image ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      })
    }
  }
  inventory(): Inventory["providers"] {
    return this.runtime.getProviders().map((p) => ({
      id: p.id,
      name: p.name,
      apiKey: Boolean(p.auth.apiKey?.login),
      oauth: Boolean(p.auth.oauth),
      configured: this.runtime.hasConfiguredAuth(p.id),
      models: this.runtime
        .getModels(p.id)
        .filter((m) => this.runtime.getPhysicalModel(m.provider, m.id))
        .map((m) => ({
          id: m.id,
          name: m.name,
          thinking: getSupportedThinkingLevels(m),
          reasoning: m.reasoning,
          image: m.input.includes("image"),
        })),
    }))
  }
  assertUnused(id: string) {
    if (this.store.snapshot().policy.models.some((ref) => ref.startsWith(`${id}/`)))
      throw new AdminError(409, "Provider is referenced; replace its models first")
  }
  validateCredential(id: string, key: string | null) {
    if (!this.runtime.getProvider(id)) throw new AdminError(404, "Provider not found")
    if (key === null) {
      this.assertUnused(id)
      return
    }
    if (!key || key.length > 8192 || /^[!$]/.test(key.trimStart()) || /[\r\n]/.test(key))
      throw new AdminError(400, "Invalid literal API key")
    if (!this.runtime.getProvider(id)?.auth.apiKey?.login)
      throw new AdminError(400, "API-key login is not supported")
  }
  async credential(id: string, key: string | null) {
    this.validateCredential(id, key)
    if (key === null) {
      await this.runtime.logout(id)
      return
    }
    await this.runtime.login(id, "api_key", {
      signal: AbortSignal.timeout(30_000),
      prompt: async (p) => {
        if (p.type !== "secret") throw new Error("Provider requires additional setup")
        return key
      },
      notify: () => {},
    })
  }
  async test(id: string) {
    if (!this.runtime.getProvider(id)) throw new AdminError(404, "Provider not found")
    // Availability checks resolve configured authentication; they do not generate model output.
    const auth = await this.runtime.checkAuth(id, { signal: AbortSignal.timeout(10_000) })
    return {
      configured: Boolean(auth),
      models: this.runtime.getModels(id).map((m) => m.id),
      generatedTokens: false,
    }
  }
  async discover(id: string) {
    const p = this.store.snapshot().policy.providers.find((p) => p.id === id)
    if (!p?.baseUrl || !p.api?.startsWith("openai-"))
      throw new AdminError(400, "Discovery requires a custom OpenAI-compatible endpoint")
    const auth = await this.runtime.getAuth(id, { signal: AbortSignal.timeout(10_000) })
    const url = new URL(`${p.baseUrl.replace(/\/$/, "")}/models`)
    const response = await providerFetch(url, {
      headers: auth?.auth.apiKey ? { Authorization: `Bearer ${auth.auth.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("Model discovery failed")
    }
    const parsed: unknown = JSON.parse(
      Buffer.from(await readResponseBytes(response, 1_000_000)).toString(),
    )
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !Array.isArray(parsed.data))
      throw new Error("Invalid model catalog")
    return parsed.data
      .slice(0, 128)
      .flatMap((m: unknown) =>
        m && typeof m === "object" && "id" in m && typeof m.id === "string" && m.id.length <= 192
          ? [m.id]
          : [],
      )
  }
  startLogin(provider: string, owner: string, expiresAt = Date.now() + 300_000) {
    if (!this.runtime.getProvider(provider)?.auth.oauth)
      throw new AdminError(400, "OAuth is not supported")
    if ([...this.logins.values()].some((v) => v.status === "pending"))
      throw new AdminError(409, "Another provider login is pending")
    if (this.logins.size >= 16) this.logins.delete(this.logins.keys().next().value ?? "")
    const controller = new AbortController()
    const id = token()
    const state: LoginState = {
      id,
      provider,
      owner,
      status: "pending",
      controller,
      done: Promise.resolve(),
    }
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, Math.min(300_000, expiresAt - Date.now()))),
    ])
    state.done = this.runtime
      .login(provider, "oauth", {
        signal,
        notify: (event) => {
          state.event = event
        },
        prompt: (prompt) =>
          new Promise((resolve, reject) => {
            const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal
            const abort = () => {
              state.prompt = undefined
              state.answer = undefined
              reject(new Error("Login cancelled"))
            }
            if (promptSignal.aborted) {
              abort()
              return
            }
            promptSignal.addEventListener("abort", abort, { once: true })
            const { signal: _signal, ...safe } = prompt
            state.prompt = safe
            state.answer = (value) => {
              promptSignal.removeEventListener("abort", abort)
              state.prompt = undefined
              state.answer = undefined
              resolve(value)
            }
          }),
      })
      .then(async () => {
        await this.credentialsChanged(provider)
        state.status = "completed"
      })
      .catch(() => {
        state.status = controller.signal.aborted ? "cancelled" : "failed"
      })
      .finally(() => {
        state.event = undefined
        state.prompt = undefined
        state.answer = undefined
      })
    this.logins.set(id, state)
    return id
  }
  loginState(id: string, owner: string) {
    const state = this.logins.get(id)
    if (!state || state.owner !== owner) throw new AdminError(404, "Login not found")
    return state
  }
  async cancelOwner(owner?: string) {
    const states = [...this.logins.values()].filter((s) => !owner || s.owner === owner)
    for (const s of states) s.controller.abort()
    await Promise.all(states.map((s) => s.done))
  }
}

/** Bind private methods to the real runtime; intercept every model request, including resumed work. */
export function chatModelRuntime(
  runtime: ModelRuntime,
  store: AdminStore,
  chatId: number,
): ModelRuntime {
  const assertModel = (model: { provider: string; id: string }, level?: ModelThinkingLevel) => {
    store.assertChat(chatId)
    if (!runtime.getPhysicalModel(model.provider, model.id))
      throw new AdminError(403, "Only physical chat models are supported")
    const policy = effectivePolicy(store.snapshot().policy, chatId)
    if (!policy.models.includes(`${model.provider}/${model.id}`))
      throw new AdminError(403, "Model is not allowed")
    if (
      level &&
      !getSupportedThinkingLevels(
        runtime.getModel(model.provider, model.id) as Parameters<
          typeof getSupportedThinkingLevels
        >[0],
      ).includes(level)
    )
      throw new AdminError(403, "Thinking level is not supported")
  }
  let proxy: ModelRuntime
  proxy = new Proxy(runtime, {
    get(target, property) {
      if (property === "completeSimple")
        return (
          model: Parameters<ModelRuntime["completeSimple"]>[0],
          context: Parameters<ModelRuntime["completeSimple"]>[1],
          options?: Parameters<ModelRuntime["completeSimple"]>[2],
        ) => proxy.streamSimple(model, context, options).result()
      if (
        property === "stream" ||
        property === "complete" ||
        property === "streamDeferred" ||
        property === "fetchDeferred" ||
        property === "generateImages" ||
        property === "classify"
      )
        return () => {
          throw new AdminError(403, "Operation is not available to chat sessions")
        }
      if (property === "streamSimple")
        return (
          model: Parameters<ModelRuntime["streamSimple"]>[0],
          context: Parameters<ModelRuntime["streamSimple"]>[1],
          options?: Parameters<ModelRuntime["streamSimple"]>[2],
        ) => {
          assertModel(model, options?.reasoning)
          const custom = store
            .snapshot()
            .policy.providers.find((p) => p.id === model.provider)?.baseUrl
          return target.streamSimple(
            model,
            context,
            custom ? { ...options, fetch: providerFetch, transport: "sse" } : options,
          )
        }
      if (property === "getAvailable")
        return async () =>
          (await target.getAvailable()).filter((m) =>
            effectivePolicy(store.snapshot().policy, chatId).models.includes(
              `${m.provider}/${m.id}`,
            ),
          )
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return proxy
}
