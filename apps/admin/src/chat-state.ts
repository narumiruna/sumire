import { effectivePolicy } from "@narumitw/sumire-policy"
import type { Inventory, Policy, Snapshot } from "./api.js"

export type ChatRepair = "access" | "enabled" | "application" | "model" | "providers"
export type ChatIssue = {
  code: string
  label: string
  reason: string
  action: string
  target: ChatRepair
}

/** Inventory describes local configuration, not model execution. */
export function modelIssues(
  model: string | null,
  selected: string | null,
  inventory?: Inventory,
): ChatIssue[] {
  const issues: ChatIssue[] = []
  if (!model)
    issues.push({
      code: "model",
      label: "Setup required",
      reason: selected
        ? "Selected model is excluded by model availability rules."
        : "No effective model configured.",
      action: "Configure model",
      target: "model",
    })
  else {
    const providerId = model.split("/")[0]
    const provider = inventory?.providers.find((value) => value.id === providerId)
    if (provider && !provider.configured)
      issues.push({
        code: "authentication",
        label: "Setup required",
        reason: "Model authentication is not configured.",
        action: "Configure authentication",
        target: "providers",
      })
    if (!provider?.models.some((candidate) => `${provider.id}/${candidate.id}` === model))
      issues.push({
        code: "inventory",
        label: "Status unknown",
        reason: !provider
          ? "Provider configuration is not in the loaded inventory."
          : "Selected model is not in the loaded inventory.",
        action: "Review authentication configuration",
        target: "providers",
      })
  }
  return issues
}

/** Describe saved configuration, not model execution or an unsaved policy preview. */
export function chatState(
  chatId: number,
  policy: Policy,
  inventory: Inventory | undefined,
  application: Pick<Snapshot, "revision" | "applied" | "status">,
) {
  const effective = effectivePolicy(policy, chatId)
  const override = policy.chats[String(chatId)]
  const approved = policy[chatId > 0 ? "privateUsers" : "groups"].includes(chatId)
  const enabled = override?.enabled !== false
  const issues: ChatIssue[] = []
  if (!approved)
    issues.push({
      code: "approval",
      label: "Access not approved",
      reason: "Access approval is missing.",
      action: "Review access approval",
      target: "access",
    })
  if (!enabled)
    issues.push({
      code: "disabled",
      label: "Disabled",
      reason: "The chat is disabled.",
      action: "Review chat enabled switch",
      target: "enabled",
    })
  if (application.status === "failed")
    issues.push({
      code: "application-failed",
      label: "Application failed",
      reason: "Saved settings could not be applied.",
      action: "Review application status",
      target: "application",
    })
  else if (application.status !== "applied" || application.revision !== application.applied)
    issues.push({
      code: "application-pending",
      label: "Application pending",
      reason: "Saved settings are waiting to apply.",
      action: "Review application status",
      target: "application",
    })
  issues.push(...modelIssues(effective.model, override?.model ?? policy.defaults.model, inventory))
  return {
    approved,
    enabled,
    effective,
    issues,
    primary: issues[0],
    label: issues[0]?.label ?? "Configured locally",
    reason: issues[0]?.reason ?? "Model response not checked.",
  }
}
