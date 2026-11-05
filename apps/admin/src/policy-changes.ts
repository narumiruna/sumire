import type { Policy, ProviderSettings, Selection } from "./api.js"
import { t } from "./i18n.js"
import type { EditorTarget } from "./navigation.js"

export type PolicyChange = { label: string; targets: EditorTarget[] }

/** Stage one explicit approval without changing chat overrides or other access scopes. */
export function withChatAccess(policy: Policy, id: number, allowed: boolean): Policy {
  if (!Number.isSafeInteger(id) || id === 0) throw new Error(t("policy.invalidTelegramId"))
  const key = id > 0 ? "privateUsers" : "groups"
  return {
    ...policy,
    [key]: allowed
      ? [...new Set([...policy[key], id])]
      : policy[key].filter((value) => value !== id),
  }
}

const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
const differentSelection = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.some((value) => !b.includes(value)) || b.some((value) => !a.includes(value))
    : different(a, b)

const selectionFields = [
  ["tools", "policy.field.tools"],
  ["skills", "policy.field.skills"],
  ["servers", "policy.field.servers"],
  ["models", "policy.field.models"],
  ["model", "policy.field.model"],
  ["thinking", "policy.field.thinking"],
] as const

function selectionChanges(
  saved: Selection | undefined,
  draft: Selection | undefined,
  chat: boolean,
): string[] {
  return selectionFields.flatMap(([key, label]) => {
    if (!differentSelection(saved?.[key] ?? null, draft?.[key] ?? null)) return []
    const value = draft?.[key]
    const source =
      value == null
        ? chat
          ? t("policy.source.inherit")
          : t("policy.source.noDefault")
        : Array.isArray(value) && value.length === 0
          ? chat
            ? t("policy.source.emptyOverride")
            : t("policy.source.emptySelection")
          : chat
            ? t("policy.source.override")
            : t("policy.source.selection")
    return [t("policy.selection", { field: t(label), source })]
  })
}

function providerChanges(saved: ProviderSettings[], draft: ProviderSettings[]): string[] {
  const fields = new Set<string>()
  for (const id of new Set([...saved, ...draft].map((provider) => provider.id))) {
    const before = saved.find((provider) => provider.id === id)
    const after = draft.find((provider) => provider.id === id)
    if (!before) fields.add(t("policy.provider.added"))
    if (!after) fields.add(t("policy.provider.removed"))
    for (const [key, label] of [
      ["enabled", "policy.field.enabled"],
      ["baseUrl", "policy.field.baseUrl"],
      ["api", "policy.field.api"],
    ] as const)
      if (different(before?.[key], after?.[key])) fields.add(t(label))
    if (different(before?.models, after?.models)) {
      const models = new Set([...(before?.models ?? []), ...(after?.models ?? [])].map((m) => m.id))
      const changed = [
        ["id", "policy.field.modelId"],
        ["name", "policy.field.name"],
        ["reasoning", "policy.field.reasoning"],
        ["image", "policy.field.image"],
        ["contextWindow", "policy.field.contextWindow"],
        ["maxTokens", "policy.field.maxTokens"],
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
        .map(([, label]) => t(label))
      if (
        labels.length ||
        different(
          before?.models.map((model) => model.id),
          after?.models.map((model) => model.id),
        )
      ) {
        const detail =
          labels.join(t("policy.listSeparator")) ||
          (before && after ? t("policy.provider.entryOrder") : "")
        fields.add(
          detail
            ? t("policy.provider.modelDetails", { detail })
            : t("policy.provider.modelDefinitions"),
        )
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
    fields.add(t("policy.provider.order"))
  return [...fields]
}

/** Describe policy-only fields and impact without including selection or endpoint values. */
export function policyChangeEntries(saved: Policy, draft: Policy): PolicyChange[] {
  const changes: PolicyChange[] = []
  for (const key of ["privateUsers", "groups"] as const) {
    const label = t(key === "privateUsers" ? "policy.scope.privateUsers" : "policy.scope.groups")
    for (const id of draft[key])
      if (!saved[key].includes(id))
        changes.push({
          label: t("policy.access.approve", { scope: label, id }),
          targets: [
            {
              page: "Chats",
              selector: key === "privateUsers" ? "#access-users-list" : "#access-groups-list",
            },
          ],
        })
    for (const id of saved[key])
      if (!draft[key].includes(id))
        changes.push({
          label: t("policy.access.revoke", { scope: label, id }),
          targets: [
            {
              page: "Chats",
              selector: key === "privateUsers" ? "#access-users-list" : "#access-groups-list",
            },
          ],
        })
  }
  for (const id of new Set([...Object.keys(saved.chats), ...Object.keys(draft.chats)])) {
    const before = saved.chats[id]
    const after = draft.chats[id]
    const fields = selectionChanges(before, after, true)
    if (before?.enabled !== after?.enabled)
      fields.push(t(after ? "policy.field.enabled" : "policy.field.enabledReset"))
    if (fields.length) {
      const message = !before
        ? "policy.chat.added"
        : !after
          ? "policy.chat.removed"
          : "policy.chat.changed"
      const changed = selectionFields.find(([key]) =>
        differentSelection(before?.[key] ?? null, after?.[key] ?? null),
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
        label: t(message, { id, fields: fields.join(t("policy.listSeparator")) }),
        targets: [{ page: "Chats", chat: id, selector }],
      })
    }
  }
  for (const [before, after, action] of [
    [saved.githubNotifications.allowedUsernames, draft.githubNotifications.allowedUsernames, "add"],
    [
      draft.githubNotifications.allowedUsernames,
      saved.githubNotifications.allowedUsernames,
      "remove",
    ],
  ] as const)
    for (const username of after)
      if (!before.includes(username))
        changes.push({
          label: t(action === "add" ? "policy.github.add" : "policy.github.remove", { username }),
          targets: [{ page: "GitHub mentions", selector: "#github-mention-authors" }],
        })
  const defaults = selectionChanges(saved.defaults, draft.defaults, false)
  if (defaults.length)
    changes.push({
      label: t("policy.defaults.changed", { fields: defaults.join(t("policy.listSeparator")) }),
      targets: selectionFields
        .filter(([key]) =>
          differentSelection(saved.defaults[key] ?? null, draft.defaults[key] ?? null),
        )
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
    ["tools", "policy.global.tools"],
    ["skills", "policy.global.skills"],
    ["servers", "policy.global.servers"],
    ["models", "policy.global.models"],
  ] as const)
    if (differentSelection(saved[key], draft[key]))
      changes.push({
        label: t("policy.global.changed", { scope: t(label), key }),
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
      label: t("policy.provider.changed", { fields: providers.join(t("policy.listSeparator")) }),
      targets: [{ page: "Model Providers", selector: "#endpoint-provider-id" }],
    })
  return changes
}

/** Count edited fields and changed list memberships, not grouped review summaries. */
export function policyChangeCount(saved: Policy, draft: Policy): number {
  const listCount = (
    before: readonly (string | number)[] | null | undefined,
    after: readonly (string | number)[] | null | undefined,
  ) => {
    if (!different(before ?? null, after ?? null)) return 0
    if (before == null || after == null) return 1
    return new Set([
      ...before.filter((value) => !after.includes(value)),
      ...after.filter((value) => !before.includes(value)),
    ]).size
  }
  const selectionCount = (before?: Selection, after?: Selection) =>
    selectionFields.reduce(
      (count, [key]) =>
        count +
        (["model", "thinking"].includes(key)
          ? Number(different(before?.[key] ?? null, after?.[key] ?? null))
          : listCount(before?.[key] as string[] | null, after?.[key] as string[] | null)),
      0,
    )
  let count = selectionCount(saved.defaults, draft.defaults)
  count += listCount(
    saved.githubNotifications.allowedUsernames,
    draft.githubNotifications.allowedUsernames,
  )
  for (const key of ["privateUsers", "groups", "tools", "servers", "skills", "models"] as const)
    count += listCount(saved[key], draft[key])
  for (const id of new Set([...Object.keys(saved.chats), ...Object.keys(draft.chats)])) {
    count += selectionCount(saved.chats[id], draft.chats[id])
    count += Number(saved.chats[id]?.enabled !== draft.chats[id]?.enabled)
  }
  for (const id of new Set(
    [...saved.providers, ...draft.providers].map((provider) => provider.id),
  )) {
    const before = saved.providers.find((provider) => provider.id === id)
    const after = draft.providers.find((provider) => provider.id === id)
    if (!before || !after) {
      count++
      continue
    }
    for (const key of ["enabled", "baseUrl", "api"] as const)
      count += Number(different(before[key], after[key]))
    for (const modelId of new Set([...before.models, ...after.models].map((model) => model.id))) {
      const oldModel = before.models.find((model) => model.id === modelId)
      const newModel = after.models.find((model) => model.id === modelId)
      if (!oldModel || !newModel) {
        count++
        continue
      }
      for (const key of ["name", "reasoning", "image", "contextWindow", "maxTokens"] as const)
        count += Number(different(oldModel[key], newModel[key]))
    }
    if (
      before.models.length === after.models.length &&
      before.models.every((model) => after.models.some((item) => item.id === model.id))
    )
      count += Number(
        different(
          before.models.map((model) => model.id),
          after.models.map((model) => model.id),
        ),
      )
  }
  if (
    saved.providers.length === draft.providers.length &&
    saved.providers.every((provider) => draft.providers.some((item) => item.id === provider.id))
  )
    count += Number(
      different(
        saved.providers.map((provider) => provider.id),
        draft.providers.map((provider) => provider.id),
      ),
    )
  return count
}

export function policyChanges(saved: Policy, draft: Policy): string[] {
  return policyChangeEntries(saved, draft).map((change) => change.label)
}
