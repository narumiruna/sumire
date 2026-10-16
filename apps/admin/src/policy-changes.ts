import type { Policy } from "./api.js"

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

/** Describe policy-only changes without including credentials or endpoint values. */
export function policyChanges(saved: Policy, draft: Policy): string[] {
  const changes: string[] = []
  const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
  for (const key of ["privateUsers", "groups"] as const) {
    const label = key === "privateUsers" ? "Private-message access" : "Group/channel access"
    for (const id of draft[key])
      if (!saved[key].includes(id)) changes.push(`${label}: approve ${id}`)
    for (const id of saved[key])
      if (!draft[key].includes(id)) changes.push(`${label}: revoke ${id}`)
  }
  for (const id of new Set([...Object.keys(saved.chats), ...Object.keys(draft.chats)])) {
    if (different(saved.chats[id], draft.chats[id]))
      changes.push(`Chat ${id}: overrides or enabled switch`)
  }
  for (const [key, label] of [
    ["defaults", "Shared defaults"],
    ["tools", "Global tool availability"],
    ["servers", "Global MCP availability"],
    ["models", "Global model availability"],
    ["providers", "Provider configuration"],
  ] as const)
    if (different(saved[key], draft[key])) changes.push(label)
  return changes
}
