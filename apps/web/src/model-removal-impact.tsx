import type { Policy, Selection } from "./api.js"
import { thinkingLabel } from "./default-model.js"
import { t } from "./i18n.js"
import { modelRemovalImpact } from "./provider-policy.js"
import { Prose } from "./surfaces.js"

const list = (value: string[] | null) =>
  value === null ? t("selection.inherit") : value.join(", ") || t("model.emptyList")
const selection = (
  value: Pick<Selection, "models" | "model" | "thinking"> | null,
  shared: boolean,
) =>
  value
    ? t("model.selectionDetails", {
        models: value.models === null && shared ? t("model.nullSelection") : list(value.models),
        model: value.model ?? t(shared ? "model.notConfigured" : "selection.inherit"),
        thinking:
          value.thinking === null
            ? t(shared ? "model.noSharedThinking" : "selection.inherit")
            : thinkingLabel(value.thinking),
      })
    : t("model.noExplicitEntry")

/** Read-only review of the actual staged policy; no directory or remote requests. */
export function ModelRemovalImpact({ before, after }: { before: Policy; after: Policy }) {
  const impact = modelRemovalImpact(before, after)
  if (!impact.removed.length && !impact.sharedChanged && !impact.chats.length) return null
  const rows = [...(impact.sharedChanged ? [impact.shared] : []), ...impact.chats]
  return (
    <section aria-label={t("model.removalImpact")} className="settings-stack">
      <strong>{t("model.configurationImpact")}</strong>
      {impact.removed.length > 0 && (
        <Prose>{t("model.removedAvailability", { models: impact.removed.join(", ") })}</Prose>
      )}
      <Prose>
        {t("model.globalTransition", {
          before: list(impact.global.before),
          after: list(impact.global.after),
        })}
      </Prose>
      {rows.map((row) => (
        <div key={row.scope} className="provider-impact-row">
          <strong>
            {"id" in row
              ? t(row.enabled ? "selection.chatNamed" : "model.disabledChat", { id: row.id })
              : t("selection.shared")}
          </strong>
          <Prose>
            {t("model.beforeSelection", { selection: selection(row.before, !("id" in row)) })}
          </Prose>
          <Prose>
            {t("model.afterSelection", { selection: selection(row.after, !("id" in row)) })}
          </Prose>
          <Prose>
            {t("model.allowedTransition", {
              before: list(row.effectiveBefore.models),
              after: list(row.effectiveAfter.models),
            })}
          </Prose>
          <Prose>
            {t("model.effectiveTransition", {
              before: row.effectiveBefore.model ?? t("model.notConfigured"),
              after: row.effectiveAfter.model ?? t("model.notConfigured"),
            })}{" "}
            {"id" in row && row.after?.model === null ? t("model.resultInherits") : ""}{" "}
            {t("model.thinkingTransition", {
              before: thinkingLabel(row.effectiveBefore.thinking ?? "off"),
              after: thinkingLabel(row.effectiveAfter.thinking ?? "off"),
            })}
          </Prose>
        </div>
      ))}
      <Prose>{t("model.impactPopulation")}</Prose>
      <Prose>{t("model.restorationHelp")}</Prose>
      <Prose>
        {t("model.githubImpact", {
          before: impact.shared.effectiveBefore.model ?? t("model.notConfigured"),
          after: impact.shared.effectiveAfter.model ?? t("model.notConfigured"),
        })}
      </Prose>
    </section>
  )
}
