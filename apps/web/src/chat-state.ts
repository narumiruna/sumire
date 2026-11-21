import { effectivePolicy } from "@narumitw/sumire-policy"
import type { Inventory, Policy, Snapshot } from "./api.js"
import { t } from "./i18n.js"

export type ChatRepair =
  | "access"
  | "enabled"
  | "application"
  | "model"
  | "providers"
  | "tools"
  | "servers"
  | "skills"
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
      label: t("chat.setupRequired"),
      reason: selected ? t("chat.modelExcluded") : t("chat.noEffectiveModel"),
      action: t("chat.configureModel"),
      target: "model",
    })
  else {
    const providerId = model.split("/")[0]
    const provider = inventory?.providers.find((value) => value.id === providerId)
    if (provider && !provider.configured)
      issues.push({
        code: "authentication",
        label: t("chat.setupRequired"),
        reason: t("chat.authenticationMissing"),
        action: t("chat.configureAuthentication"),
        target: "providers",
      })
    if (!provider?.models.some((candidate) => `${provider.id}/${candidate.id}` === model))
      issues.push({
        code: "inventory",
        label: t("chat.statusUnknown"),
        reason: !provider ? t("chat.providerNotLoaded") : t("chat.modelNotLoaded"),
        action: t("chat.reviewAuthentication"),
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
      label: t("chat.accessNotApproved"),
      reason: t("chat.approvalMissing"),
      action: t("chat.reviewApproval"),
      target: "access",
    })
  if (!enabled)
    issues.push({
      code: "disabled",
      label: t("chat.disabled"),
      reason: t("chat.chatDisabledReason"),
      action: t("chat.reviewEnabled"),
      target: "enabled",
    })
  if (application.status === "failed")
    issues.push({
      code: "application-failed",
      label: t("chat.applicationFailed"),
      reason: t("chat.settingsApplyFailed"),
      action: t("chat.reviewApplication"),
      target: "application",
    })
  else if (application.status !== "applied" || application.revision !== application.applied)
    issues.push({
      code: "application-pending",
      label: t("chat.applicationPending"),
      reason: t("chat.settingsWaiting"),
      action: t("chat.reviewApplication"),
      target: "application",
    })
  issues.push(...modelIssues(effective.model, override?.model ?? policy.defaults.model, inventory))
  for (const category of ["tools", "servers", "skills"] as const) {
    const selected = override?.[category] ?? policy.defaults[category] ?? []
    const blocked = selected.filter((name) => !policy[category].includes(name))
    if (blocked.length)
      issues.push({
        code: `global-${category}`,
        label: t("chat.selectionBlocked"),
        reason: t(
          category === "servers"
            ? "chat.serversExcluded"
            : category === "skills"
              ? "chat.skillsExcluded"
              : "chat.toolsExcluded",
          { names: blocked.join(", ") },
        ),
        action: t("chat.reviewPermissions"),
        target: category,
      })
  }
  return {
    approved,
    enabled,
    effective,
    issues,
    primary: issues[0],
    label: issues[0]?.label ?? t("chat.configuredLocally"),
    reason: issues[0]?.reason ?? t("chat.responseUnchecked"),
  }
}
