import type { Policy, Selection } from "./api.js"

export function savedProviderSelection(policy: Policy) {
  const chatChoices = Object.values(policy.chats).filter((chat) => chat.model !== null)
  const models = [...new Set(chatChoices.map((chat) => chat.model as string))]
  const ref = policy.defaults.model ?? (models.length === 1 ? models[0] : undefined)
  const providerIds = [...new Set(models.map((model) => model.slice(0, model.indexOf("/"))))]
  const levels = [
    ...new Set(chatChoices.map((chat) => chat.thinking ?? policy.defaults.thinking ?? "off")),
  ]
  const split = ref?.indexOf("/") ?? -1
  return {
    provider:
      ref && split > 0
        ? ref.slice(0, split)
        : providerIds.length === 1
          ? (providerIds[0] ?? "")
          : "",
    model: ref && split > 0 ? ref.slice(split + 1) : "",
    thinking: policy.defaults.model
      ? (policy.defaults.thinking ?? "off")
      : levels.length === 1
        ? (levels[0] ?? null)
        : null,
  }
}

/** Add one explicit model. Do not grant its provider's full catalog or alter chat overrides. */
export function withProviderModel(policy: Policy, ref: string): Policy {
  return { ...policy, models: [...new Set([...policy.models, ref])] }
}

/** Remove dependent selections only for models explicitly removed from global availability. */
export function withModelAvailability(policy: Policy, models: string[]): Policy {
  const removed = new Set(policy.models.filter((ref) => !models.includes(ref)))
  if (removed.size === 0) return { ...policy, models }
  const clean = <T extends Selection>(selection: T): T => ({
    ...selection,
    models: selection.models?.filter((ref) => !removed.has(ref)) ?? null,
    ...(selection.model && removed.has(selection.model) ? { model: null, thinking: null } : {}),
  })
  return {
    ...policy,
    models,
    defaults: clean(policy.defaults),
    chats: Object.fromEntries(Object.entries(policy.chats).map(([id, chat]) => [id, clean(chat)])),
  }
}

/** Provider login URLs are untrusted data. Never render executable URL schemes. */
export function loginUrl(value?: string): string | undefined {
  if (!value) return
  try {
    const url = new URL(value)
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href
  } catch {
    return
  }
}
