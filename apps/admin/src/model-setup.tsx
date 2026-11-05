import { Badge, Button, Code, Flex } from "@radix-ui/themes"
import type { Inventory } from "./api.js"
import { modelIssues } from "./chat-state.js"
import { t } from "./i18n.js"
import { Prose } from "./surfaces.js"

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
      <Flex gap="2" align="center" wrap="wrap">
        <strong>{scope}</strong>
        <Code variant="ghost">{selected ?? t("model.notConfigured")}</Code>
        <Badge color={issue ? "orange" : "gray"}>
          {issue?.code === "authentication"
            ? t("model.authenticationRequired")
            : (issue?.label ?? t("model.configuredLocally"))}
        </Badge>
      </Flex>
      <Prose size="2">{issue?.reason ?? t("model.responseUnchecked")}</Prose>
      {issue && (
        <Button
          variant="soft"
          onClick={() =>
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
