import { effectivePolicy, type Policy } from "@narumitw/sumire-policy"

export type ChatKind = "privateUsers" | "groups"

export const listFor = (id: number): ChatKind => (id > 0 ? "privateUsers" : "groups")

export function isApproved(policy: Policy, id: number) {
  return policy[listFor(id)].includes(id)
}

/** Same transition as v1: approval adds the ID to its list, revocation removes it. */
export function withChatAccess(policy: Policy, id: number, allowed: boolean): Policy {
  if (!Number.isSafeInteger(id) || id === 0) throw new Error("Enter a valid, non-zero Telegram ID")
  const key = listFor(id)
  return {
    ...policy,
    [key]: allowed
      ? [...new Set([...policy[key], id])]
      : policy[key].filter((value) => value !== id),
  }
}

/** Parse one non-zero Telegram ID; positive for a person, negative for a group or channel. */
export function parseChatId(value: string) {
  const text = value.trim()
  if (!/^-?[1-9]\d*$/.test(text)) return undefined
  const id = Number(text)
  return Number.isSafeInteger(id) ? id : undefined
}

/** Why a chat can or cannot talk to the bot, in the operator's words. */
export function accessState(policy: Policy, id: number) {
  const effective = effectivePolicy(policy, id)
  if (effective.enabled) return { allowed: true, label: "Approved" } as const
  if (isApproved(policy, id)) return { allowed: false, label: "Approved, chat disabled" } as const
  return { allowed: false, label: "Not approved" } as const
}
