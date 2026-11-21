import { effectivePolicy } from "@narumitw/sumire-policy"
import type { Inventory, Policy, Selection } from "./api.js"

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

type ModelSelection = Pick<Selection, "models" | "model" | "thinking">
const modelSelection = ({ models, model, thinking }: ModelSelection): ModelSelection => ({
  models,
  model,
  thinking,
})
const effectiveModelSelection = (policy: Policy, id: number) =>
  modelSelection(effectivePolicy(policy, id))

/** Compare the complete policy, not the visible chat directory or provider catalog.
 * Arrays use the same removal transformation as the availability editor. A policy
 * argument compares the actual staged result, including removal followed by restore.
 */
export function modelRemovalImpact(before: Policy, value: string[] | Policy) {
  const after = Array.isArray(value) ? withModelAvailability(before, value) : value
  const shared = {
    scope: "Shared defaults",
    before: modelSelection(before.defaults),
    after: modelSelection(after.defaults),
    effectiveBefore: effectiveModelSelection(before, 0),
    effectiveAfter: effectiveModelSelection(after, 0),
  }
  const chats = [...new Set([...Object.keys(before.chats), ...Object.keys(after.chats)])]
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => ({
      scope: `Chat ${id}`,
      id,
      enabled: after.chats[id]?.enabled ?? true,
      before: before.chats[id] ? modelSelection(before.chats[id]) : null,
      after: after.chats[id] ? modelSelection(after.chats[id]) : null,
      effectiveBefore: effectiveModelSelection(before, Number(id)),
      effectiveAfter: effectiveModelSelection(after, Number(id)),
    }))
    .filter(
      (row) =>
        JSON.stringify(row.before) !== JSON.stringify(row.after) ||
        JSON.stringify(row.effectiveBefore) !== JSON.stringify(row.effectiveAfter),
    )
  return {
    after,
    removed: before.models.filter((ref) => !after.models.includes(ref)),
    global: { before: before.models, after: after.models },
    shared,
    sharedChanged:
      JSON.stringify(shared.before) !== JSON.stringify(shared.after) ||
      JSON.stringify(shared.effectiveBefore) !== JSON.stringify(shared.effectiveAfter),
    chats,
  }
}

/** Policy references, not observations of running chats. Disabled entries count. */
export function providerReferences(policy: Policy, provider: string) {
  const matches = (ref: string) => ref.startsWith(`${provider}/`)
  return {
    available: policy.models.filter(matches),
    sharedModel:
      policy.defaults.model && matches(policy.defaults.model) ? policy.defaults.model : null,
    sharedAllowed: policy.defaults.models?.filter(matches) ?? [],
    chats: Object.entries(policy.chats)
      .filter(
        ([, selection]) =>
          Boolean(selection.model && matches(selection.model)) || selection.models?.some(matches),
      )
      .map(([id, selection]) => ({ id, ...modelSelection(selection), enabled: selection.enabled })),
  }
}

/** Only configured or policy-referenced providers belong in the main list. */
export function configuredProviders(policy: Policy, inventory: Inventory) {
  const ids = new Set(policy.providers.map((provider) => provider.id))
  for (const provider of inventory.providers) if (provider.configured) ids.add(provider.id)
  for (const selection of [policy.defaults, ...Object.values(policy.chats)]) {
    for (const ref of [...(selection.models ?? []), ...(selection.model ? [selection.model] : [])])
      if (ref.includes("/")) ids.add(ref.slice(0, ref.indexOf("/")))
  }
  for (const ref of policy.models) if (ref.includes("/")) ids.add(ref.slice(0, ref.indexOf("/")))
  return [...ids].sort().map((id) => ({
    id,
    name: inventory.providers.find((provider) => provider.id === id)?.name ?? id,
    configured: inventory.providers.find((provider) => provider.id === id)?.configured ?? null,
    references: providerReferences(policy, id),
  }))
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
