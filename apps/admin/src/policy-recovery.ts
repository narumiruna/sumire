import type { Policy, Selection } from "./api.js"

export type RecoveryChoice = "saved" | "draft"
export type RecoveryChange = {
  id: string
  label: string
  saved: unknown
  draft: unknown
  state: "draft" | "saved" | "conflict"
}

/** Compare JSON policy values without depending on object property insertion order. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  )
}

const lists = {
  tools: "Global tool availability",
  skills: "Global skill availability",
  servers: "Global MCP availability",
  models: "Global model availability",
  privateUsers: "Private-message access",
  groups: "Group and channel access",
  providers: "Provider configuration and order",
} as const
const defaults = {
  tools: "Authorized tools",
  skills: "Enabled skills",
  servers: "Authorized MCP servers",
  models: "Allowed models",
  model: "Model",
  thinking: "Thinking level",
} satisfies Record<keyof Selection, string>

/** Reapply only non-overlapping edits. Lists and chat records are atomic, never unioned. */
export function recoverPolicy(
  base: Policy,
  draft: Policy,
  latest: Policy,
  choices: Readonly<Record<string, RecoveryChoice>> = {},
  submitted: Policy = draft,
) {
  const changes: RecoveryChange[] = []
  let unresolved = 0
  const choose = <T>(id: string, label: string, before: T, local: T, saved: T, attempted: T): T => {
    // An edit made after submission remains intentional even if it restores the original value.
    if (equal(before, local) && equal(attempted, local)) return structuredClone(saved)
    const state = equal(local, saved) ? "saved" : equal(before, saved) ? "draft" : "conflict"
    changes.push({ id, label, saved: structuredClone(saved), draft: structuredClone(local), state })
    if (state === "saved") return structuredClone(saved)
    if (state === "draft") return structuredClone(local)
    if (!choices[id]) unresolved++
    return structuredClone(choices[id] === "draft" ? local : saved)
  }
  const policy = structuredClone(latest)
  const recoverList = <K extends keyof typeof lists>(key: K) => {
    policy[key] = choose(key, lists[key], base[key], draft[key], latest[key], submitted[key])
  }
  for (const key of Object.keys(lists) as (keyof typeof lists)[]) recoverList(key)
  const recoverDefault = <K extends keyof Selection>(key: K) => {
    policy.defaults[key] = choose(
      `defaults.${key}`,
      `Shared defaults: ${defaults[key]}`,
      base.defaults[key],
      draft.defaults[key],
      latest.defaults[key],
      submitted.defaults[key],
    )
  }
  for (const key of Object.keys(defaults) as (keyof Selection)[]) recoverDefault(key)
  for (const id of new Set([
    ...Object.keys(base.chats),
    ...Object.keys(draft.chats),
    ...Object.keys(submitted.chats),
  ])) {
    const value = choose(
      `chats.${id}`,
      `Chat ${id} settings`,
      base.chats[id],
      draft.chats[id],
      latest.chats[id],
      submitted.chats[id],
    )
    if (value === undefined) delete policy.chats[id]
    else policy.chats[id] = value
  }
  return { policy, changes, unresolved }
}
