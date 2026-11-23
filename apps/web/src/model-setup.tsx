import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import type { Inventory } from "./api.js"
import { modelIssues } from "./chat-state.js"
import { t } from "./i18n.js"
import { Prose, StatusLabel } from "./surfaces.js"

/** A scoped local setup summary. Never a claim about successful remote execution. */
export function ModelSetup({
  scope,
  model,
  selected,
  inventory,
  onModel,
  onProvider,
  providerAction,
}: {
  scope: string
  model: string | null
  selected: string | null
  inventory: Inventory
  onModel(): void
  onProvider(provider: string): void
  providerAction?: string
}) {
  const issue = modelIssues(model, selected, inventory)[0]
  return (
    <section aria-label={scope} className="model-setup">
      <div className={style({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 })}>
        <strong>{scope}</strong>
        <code>{selected ?? t("model.notConfigured")}</code>
        <StatusLabel tone={issue ? "warning" : "neutral"}>
          {issue?.code === "authentication"
            ? t("model.authenticationRequired")
            : (issue?.label ?? t("model.configuredLocally"))}
        </StatusLabel>
      </div>
      <Prose size="2">{issue?.reason ?? t("model.responseUnchecked")}</Prose>
      {issue && (
        <Button
          variant="secondary"
          onPress={() =>
            issue.target === "model"
              ? onModel()
              : onProvider((model ?? selected ?? "").split("/")[0] ?? "")
          }
        >
          {issue.target === "providers" ? (providerAction ?? issue.action) : issue.action}
        </Button>
      )}
    </section>
  )
}
