import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { z } from "zod"
import { type AdminConfig, PasskeyAdminLogin } from "./auth.js"
import type { McpAdmin } from "./mcp.js"
import { effectivePolicy, policySchema } from "./policy.js"
import type { ProviderAdmin } from "./providers.js"
import { AdminError, type AdminStore, digest } from "./store.js"

interface AdminServices {
  store: AdminStore
  providers: ProviderAdmin
  mcp: McpAdmin
  apply(): Promise<void>
  tools(): string[]
}
const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`
const readCookie = (req: IncomingMessage, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? ""
const offset = (url: URL) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .parse(url.searchParams.get("offset") ?? 0)

async function body(req: IncomingMessage, limit = 262144) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new AdminError(415, "JSON is required")
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new AdminError(413, "Request is too large")
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown
  } catch {
    throw new AdminError(400, "Invalid JSON")
  }
}
const reply = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(value))
}

export function createAdminServer(config: AdminConfig, services: AdminServices) {
  const { store, providers, mcp } = services
  const login = new PasskeyAdminLogin(config, store)
  const buckets = new Map<string, { start: number; count: number }>()
  const limited = (key: string, max: number) => {
    const now = Date.now()
    for (const [k, v] of buckets) if (v.start < now - 60_000) buckets.delete(k)
    const bucket = buckets.get(key) ?? { start: now, count: 0 }
    if (buckets.size >= 1024 && !buckets.has(key)) throw new AdminError(429, "Too many requests")
    bucket.count++
    buckets.set(key, bucket)
    if (bucket.count > max) throw new AdminError(429, "Too many requests")
  }
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 15_000, headersTimeout: 10_000 },
    (req, res) => {
      res.setHeader("cache-control", "no-store")
      res.setHeader("x-content-type-options", "nosniff")
      res.setHeader("referrer-policy", "no-referrer")
      if (new URL(config.origin).protocol === "https:")
        res.setHeader("strict-transport-security", "max-age=31536000")
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()")
      void handle(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const status =
          error instanceof AdminError ? error.status : error instanceof z.ZodError ? 400 : 500
        if (status === 429) res.setHeader("retry-after", "60")
        reply(res, status, {
          error:
            error instanceof AdminError
              ? error.message
              : status === 400
                ? "Invalid request"
                : "Operation failed",
        })
      })
    },
  )
  let stopping = false
  let closing: Promise<void> | undefined
  server.keepAliveTimeout = 5000
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (stopping) throw new AdminError(503, "Server is stopping")
    const url = new URL(req.url ?? "/", config.origin)
    const method = req.method ?? "GET"
    if (url.origin !== config.origin || req.headers.host !== new URL(config.origin).host)
      throw new AdminError(400, "Invalid host")
    if (!["GET", "POST", "PUT", "DELETE"].includes(method))
      throw new AdminError(405, "Method not allowed")
    limited(`all:${req.socket.remoteAddress}`, 240)
    if (url.pathname === "/healthz" && method === "GET") {
      reply(res, 200, { ok: true })
      return
    }
    const passkeyRoute = /^\/auth\/passkey\/(register|authenticate)\/(options|verify)$/.exec(
      url.pathname,
    )
    if (passkeyRoute) {
      if (method !== "POST") throw new AdminError(405, "Method not allowed")
      if (req.headers.origin !== config.origin || req.headers["sec-fetch-site"] === "cross-site")
        throw new AdminError(403, "Request verification failed")
      const starting = passkeyRoute[2] === "options"
      limited(`${starting ? "login" : "verify"}:${req.socket.remoteAddress}`, starting ? 10 : 20)
      const input = await body(req, 32768)
      const registering = passkeyRoute[1] === "register"
      if (starting) {
        if (!registering) z.object({}).strict().parse(input)
        const start = registering
          ? await login.beginRegistration(
              z
                .object({ setup: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
                .strict()
                .parse(input).setup,
            )
          : await login.beginAuthentication()
        res.setHeader("set-cookie", cookie("__Host-sumire-passkey", start.browser, 300))
        reply(res, 200, start.options)
        return
      }
      const response = z
        .object({ response: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(input).response
      const browser = readCookie(req, "__Host-sumire-passkey")
      const actor = registering
        ? await login.finishRegistration(
            browser,
            response as unknown as import("@simplewebauthn/server").RegistrationResponseJSON,
          )
        : await login.finishAuthentication(
            browser,
            response as unknown as import("@simplewebauthn/server").AuthenticationResponseJSON,
          )
      const old = readCookie(req, "__Host-sumire-session")
      store.revoke(old)
      await providers.cancelOwner(digest(old))
      const session = store.createSession(actor)
      store.audit(actor, "admin.login", store.snapshot().revision, "completed", "administrator")
      res.setHeader("set-cookie", [
        cookie("__Host-sumire-session", session.value, 8 * 3600),
        cookie("__Host-sumire-passkey", "", 0),
      ])
      reply(res, 200, { csrf: session.csrf, actor })
      return
    }
    if (!url.pathname.startsWith("/api/")) {
      if (method !== "GET") throw new AdminError(405, "Method not allowed")
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
      if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css|svg))$/.test(name))
        throw new AdminError(404, "Not found")
      const file = path.join(config.assets, name)
      const metadata = await stat(file).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          throw new AdminError(404, "Not found")
        throw error
      })
      if (metadata.size > 4 * 1024 * 1024) throw new AdminError(500, "Asset exceeds limit")
      const data = await readFile(file)
      res.writeHead(200, {
        "content-type": name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html; charset=utf-8",
      })
      res.end(data)
      return
    }
    const sessionToken = readCookie(req, "__Host-sumire-session")
    const session = store.session(sessionToken)
    if (!session) {
      await providers.cancelOwner(digest(sessionToken))
      throw new AdminError(401, "Sign in with a passkey")
    }
    const owner = digest(sessionToken)
    if (method !== "GET") {
      if (req.headers.origin !== config.origin || req.headers["x-csrf-token"] !== session.csrf)
        throw new AdminError(403, "Request verification failed")
      limited(`write:${owner}`, 60)
    }
    if (url.pathname === "/api/session" && method === "GET") {
      reply(res, 200, { csrf: session.csrf, actor: session.actor })
      return
    }
    if (url.pathname === "/api/logout" && method === "POST") {
      store.revoke(sessionToken)
      store.audit(
        session.actor,
        "admin.logout",
        store.snapshot().revision,
        "revoked",
        "administrator",
      )
      await providers.cancelOwner(owner)
      res.setHeader("set-cookie", cookie("__Host-sumire-session", "", 0))
      reply(res, 200, { ok: true })
      return
    }
    if (url.pathname === "/api/settings" && method === "GET") {
      reply(res, 200, store.snapshot())
      return
    }
    if (url.pathname === "/api/settings" && method === "PUT") {
      const input = z
        .object({ revision: z.number().int().positive(), policy: z.unknown() })
        .strict()
        .parse(await body(req))
      const policy = policySchema.parse(input.policy)
      const previous = store.snapshot().policy
      if (
        [...providers.logins.values()].some((state) => state.status === "pending") &&
        JSON.stringify(previous.providers) !== JSON.stringify(policy.providers)
      )
        throw new AdminError(409, "Cancel the pending provider login before editing providers")
      for (const p of previous.providers)
        if (
          (!policy.providers.some((next) => next.id === p.id) ||
            (p.baseUrl && !policy.providers.find((next) => next.id === p.id)?.baseUrl)) &&
          policy.models.some((ref) => ref.startsWith(`${p.id}/`))
        )
          throw new AdminError(409, "Provider or custom endpoint is still referenced")
      await providers.validate(policy)
      store.save(policy, input.revision, session.actor)
      await services.apply()
      reply(res, 200, store.snapshot())
      return
    }
    if (url.pathname === "/api/apply" && method === "POST") {
      await services.apply()
      reply(res, 200, store.snapshot())
      return
    }
    if (url.pathname === "/api/chats" && method === "GET") {
      reply(
        res,
        200,
        store.listChats(offset(url)).map((c) => ({
          ...c,
          effective: effectivePolicy(store.snapshot().policy, Number(c.id)),
        })),
      )
      return
    }
    if (url.pathname === "/api/audit" && method === "GET") {
      reply(res, 200, store.listAudit(offset(url)))
      return
    }
    if (url.pathname === "/api/inventory" && method === "GET") {
      reply(res, 200, {
        tools: [
          ...new Set([...services.tools(), ...mcp.inventory().flatMap((entry) => entry.tools)]),
        ],
        providers: providers.inventory(),
        mcp: mcp.inventory(),
      })
      return
    }
    if (url.pathname === "/api/imports" && method === "GET") {
      reply(
        res,
        200,
        store.db
          .prepare("SELECT name,report FROM imports ORDER BY name")
          .all()
          .map((row) => ({ name: row.name, report: JSON.parse(String(row.report)) })),
      )
      return
    }
    const discoveryRoute = /^\/api\/mcp\/([A-Za-z0-9_-]{1,64})\/discover$/.exec(url.pathname)
    if (discoveryRoute && method === "POST") {
      reply(res, 200, await mcp.discover(discoveryRoute[1] as string))
      return
    }
    const mcpRoute = /^\/api\/mcp\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (mcpRoute && method === "DELETE") {
      const input = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(await body(req))
      mcp.remove(mcpRoute[1] as string, input.revision, session.actor)
      await services.apply()
      reply(res, 200, { ok: true })
      return
    }
    if (mcpRoute && method === "PUT") {
      const input = z
        .object({ revision: z.number().int().positive(), config: z.unknown() })
        .strict()
        .parse(await body(req))
      mcp.save(mcpRoute[1] as string, input.config, input.revision, session.actor)
      await services.apply()
      reply(res, 200, { ok: true })
      return
    }
    const providerRoute =
      /^\/api\/providers\/([a-z][a-z0-9-]{0,63})\/(credential|test|discover|oauth)$/.exec(
        url.pathname,
      )
    if (providerRoute && method === "POST") {
      const id = providerRoute[1] as string
      const action = providerRoute[2]
      if (action === "credential") {
        if (
          [...providers.logins.values()].some(
            (state) => state.status === "pending" && state.provider === id,
          )
        )
          throw new AdminError(409, "Cancel the pending OAuth login first")
        const input = z
          .object({ key: z.string().max(8192).nullable(), revision: z.number().int().positive() })
          .strict()
          .parse(await body(req))
        providers.validateCredential(id, input.key)
        const revision = store.save(
          store.snapshot().policy,
          input.revision,
          session.actor,
          "provider.credential",
          `provider:${id}`,
        ).revision
        try {
          await providers.credential(id, input.key)
          await services.apply()
        } catch {
          store.applied(revision, false)
          throw new AdminError(500, "Provider credential change or application failed")
        }
        reply(res, 200, { ok: true })
        return
      }
      if (action === "test") {
        reply(res, 200, await providers.test(id))
        return
      }
      if (action === "discover") {
        reply(res, 200, await providers.discover(id))
        return
      }
      const input = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(await body(req))
      if (input.revision !== store.snapshot().revision)
        throw new AdminError(409, "Settings changed; reload before login")
      reply(res, 200, {
        id: providers.startLogin(
          id,
          owner,
          Math.min(session.created + 8 * 3600_000, Date.now() + 30 * 60_000),
        ),
      })
      return
    }
    const oauthRoute = /^\/api\/oauth\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)
    if (oauthRoute) {
      const state = providers.loginState(oauthRoute[1] as string, owner)
      if (method === "GET") {
        reply(res, 200, { status: state.status, event: state.event, prompt: state.prompt })
        return
      }
      if (method === "POST") {
        const input = z
          .object({ answer: z.string().max(8192).optional(), cancel: z.boolean().optional() })
          .strict()
          .parse(await body(req))
        if (input.cancel) state.controller.abort()
        else if (state.answer && input.answer !== undefined) state.answer(input.answer)
        else throw new AdminError(409, "No pending prompt")
        reply(res, 200, { ok: true })
        return
      }
    }
    throw new AdminError(404, "Not found")
  }
  return {
    server,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(config.port, config.host, () => {
          server.off("error", reject)
          resolve()
        })
      })
    },
    stop() {
      closing ??= (async () => {
        stopping = true
        const drained = new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeIdleConnections()
        })
        await Promise.all([providers.cancelOwner(), mcp.close(), drained])
      })()
      return closing
    },
  }
}
