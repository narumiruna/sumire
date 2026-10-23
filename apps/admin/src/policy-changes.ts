import type { Policy, ProviderSettings, Selection } from "./api.js"
import type { EditorTarget } from "./navigation.js"

export type PolicyChange = { label: string; targets: EditorTarget[] }

/** Stage one explicit approval without changing chat overrides or other access scopes. */
export function withChatAccess(policy: Policy, id: number, allowed: boolean): Policy {
  if (!Number.isSafeInteger(id) || id === 0) throw new Error("Enter a valid, non-zero Telegram ID")
  const key = id > 0 ? "privateUsers" : "groups"
  return {
    ...policy,
    [key]: allowed
      ? [...new Set([...policy[key], id])]
      : policy[key].filter((value) => value !== id),
  }
}

const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)

const selectionFields = [
  ["tools", "Authorized tools"],
  ["skills", "Enabled skills"],
  ["servers", "Authorized MCP servers"],
  ["models", "Allowed models"],
  ["model", "Model"],
  ["thinking", "Thinking level"],
] as const

function selectionChanges(
  saved: Selection | undefined,
  draft: Selection | undefined,
  chat: boolean,
): string[] {
  return selectionFields.flatMap(([key, label]) => {
    if (!different(saved?.[key] ?? null, draft?.[key] ?? null)) return []
    const value = draft?.[key]
    const source =
      value == null
        ? chat
          ? "inherit shared defaults"
          : "no shared default"
        : Array.isArray(value) && value.length === 0
          ? chat
            ? "explicit empty override"
            : "explicit empty selection"
          : chat
            ? "explicit override"
            : "explicit selection"
    return [`${label} (${source})`]
  })
}

function providerChanges(saved: ProviderSettings[], draft: ProviderSettings[]): string[] {
  const fields = new Set<string>()
  for (const id of new Set([...saved, ...draft].map((provider) => provider.id))) {
    const before = saved.find((provider) => provider.id === id)
    const after = draft.find((provider) => provider.id === id)
    if (!before) fields.add("Added provider settings")
    if (!after) fields.add("Removed provider settings")
    for (const [key, label] of [
      ["enabled", "Enabled switch"],
      ["baseUrl", "Endpoint URL"],
      ["api", "API protocol"],
    ] as const)
      if (different(before?.[key], after?.[key])) fields.add(label)
    if (different(before?.models, after?.models)) {
      const models = new Set([...(before?.models ?? []), ...(after?.models ?? [])].map((m) => m.id))
      const changed = [
        ["id", "Model ID"],
        ["name", "Display name"],
        ["reasoning", "Reasoning support"],
        ["image", "Image support"],
        ["contextWindow", "Context window"],
        ["maxTokens", "Maximum output tokens"],
      ] as const
      const labels = changed
        .filter(([key]) =>
          [...models].some((model) =>
            different(
              before?.models.find((m) => m.id === model)?.[key],
              after?.models.find((m) => m.id === model)?.[key],
            ),
          ),
        )
        .map(([, label]) => label)
      if (
        labels.length ||
        different(
          before?.models.map((model) => model.id),
          after?.models.map((model) => model.id),
        )
      ) {
        const detail = labels.join(", ") || (before && after ? "entry order" : "")
        fields.add(`Model definitions${detail ? ` (${detail})` : ""}`)
      }
    }
  }
  if (
    saved.length === draft.length &&
    saved.every((provider) => draft.some((p) => p.id === provider.id)) &&
    different(
      saved.map((provider) => provider.id),
      draft.map((provider) => provider.id),
    )
  )
    fields.add("Provider order")
  return [...fields]
}

/** Describe policy-only fields and impact without including selection or endpoint values. */
export function policyChangeEntries(saved: Policy, draft: Policy): PolicyChange[] {
  const changes: PolicyChange[] = []
  for (const key of ["privateUsers", "groups"] as const) {
    const label = key === "privateUsers" ? "Private-message access" : "Group/channel access"
    for (const id of draft[key])
      if (!saved[key].includes(id))
        changes.push({
          label: `${label}: approve ${id}`,
          targets: [
            {
              page: "Access",
              selector: key === "privateUsers" ? "#access-user-input" : "#access-group-input",
            },
          ],
        })
    for (const id of saved[key])
      if (!draft[key].includes(id))
        changes.push({
          label: `${label}: revoke ${id}`,
          targets: [
            {
              page: "Access",
              selector: key === "privateUsers" ? "#access-user-input" : "#access-group-input",
            },
          ],
        })
  }
  for (const id of new Set([...Object.keys(saved.chats), ...Object.keys(draft.chats)])) {
    const before = saved.chats[id]
    const after = draft.chats[id]
    const fields = selectionChanges(before, after, true)
    if (before?.enabled !== after?.enabled)
      fields.push(after ? "Enabled switch" : "Enabled switch (reset)")
    if (fields.length) {
      const action = !before ? "added settings; " : !after ? "removed settings; " : ""
      const changed = selectionFields.find(([key]) =>
        different(before?.[key] ?? null, after?.[key] ?? null),
      )?.[0]
      const selector =
        changed === "tools" || changed === "servers" || changed === "skills" || changed === "models"
          ? `#chat-${changed}-options`
          : changed === "thinking"
            ? "#thinking-selection"
            : changed === "model"
              ? "#model-selection"
              : "#chat-policy-enabled"
      changes.push({
        label: `Chat ${id}: ${action}${fields.join(", ")} — this chat only; shared defaults and access approval unchanged.`,
        targets: [{ page: "Chats", chat: id, selector }],
      })
    }
  }
  const defaults = selectionChanges(saved.defaults, draft.defaults, false)
  if (defaults.length)
    changes.push({
      label: `Shared defaults: ${defaults.join(", ")} — affects chats inheriting each changed field; explicit overrides unchanged; does not grant access.`,
      targets: selectionFields
        .filter(([key]) => different(saved.defaults[key] ?? null, draft.defaults[key] ?? null))
        .map(
          ([key]): EditorTarget =>
            key === "tools" || key === "servers"
              ? { page: "Tool permissions", selector: "#default-tool-permissions" }
              : key === "skills"
                ? { page: "Skills", selector: "#skill-search" }
                : { page: "Defaults", selector: "#default-model-settings" },
        ),
    })
  for (const [key, label] of [
    ["tools", "Global tool availability"],
    ["skills", "Global skill availability"],
    ["servers", "Global MCP availability"],
    ["models", "Global model availability"],
  ] as const)
    if (different(saved[key], draft[key]))
      changes.push({
        label: `${label} (${key}): limits shared defaults and all chat selections, including explicit overrides; does not grant access.`,
        targets: [
          key === "skills"
            ? { page: "Skills", selector: "#skill-search" }
            : key === "models"
              ? { page: "Model Providers", selector: "#model-availability" }
              : { page: "Tool permissions", selector: "#default-tool-permissions" },
        ],
      })
  const providers = providerChanges(saved.providers, draft.providers)
  if (providers.length)
    changes.push({
      label: `Provider configuration: ${providers.join(", ")} — global provider settings; may affect chats using these providers, including explicit overrides.`,
      targets: [{ page: "Model Providers", selector: "#endpoint-provider-id" }],
    })
  return changes
}

export function policyChanges(saved: Policy, draft: Policy): string[] {
  return policyChangeEntries(saved, draft).map((change) => change.label)
}
