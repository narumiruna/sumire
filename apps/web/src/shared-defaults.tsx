import { effectivePolicy } from "@narumitw/sumire-policy"
import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import type { Inventory, Policy } from "./api.js"
import { DefaultModel } from "./default-model.js"
import { t } from "./i18n.js"
import { focusEditor, navigationHref, type Page } from "./navigation.js"
import { List } from "./policy-editors.js"
import { countText } from "./status-text.js"
import { Disclosure, Prose, SettingsSection, TableToolbar } from "./surfaces.js"

export function SharedDefaults({
  policy,
  saved,
  chat,
  inventory,
  onChange,
  navigate,
  onProvider,
}: {
  policy: Policy
  saved: Policy
  chat: string
  inventory: Inventory
  onChange(policy: Policy): void
  navigate(page: Page, anchor?: string): void
  onProvider(provider: string): void
}) {
  const managementLink = (page: Page, label: string, anchor = "") => (
    <a
      className={style({
        font: "ui-lg",
        color: "accent",
        display: "inline-flex",
        alignItems: "center",
        minHeight: 44,
      })}
      href={navigationHref(page, chat, new URL(anchor ? `#${anchor}` : "#", window.location.href))}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        event.preventDefault()
        navigate(page, anchor)
      }}
    >
      {label}
    </a>
  )
  const effective = effectivePolicy(policy, 0)
  return (
    <div className="defaults-layout">
      <SettingsSection id="default-model-settings" tabIndex={-1} title={t("model.thinkingTitle")}>
        <DefaultModel
          policy={policy}
          saved={saved.defaults}
          inventory={inventory}
          onChange={(defaults) => onChange({ ...policy, defaults })}
          onAvailability={() => navigate("Model Providers", "model-availability")}
          onProvider={onProvider}
        />
        {policy.defaults.model && !policy.defaults.models?.includes(policy.defaults.model) && (
          <InlineAlert variant="notice">
            <Content>
              <p>{t("model.defaultNotAllowed", { model: policy.defaults.model })}</p>
              <Button
                variant="secondary"
                fillStyle="outline"
                onPress={() => focusEditor("#default-models-options")}
              >
                {t("model.reviewAllowed")}
              </Button>
            </Content>
          </InlineAlert>
        )}
        <Disclosure
          summaryId="default-models-options"
          title={t("selection.allowedEffective", { count: effective.models.length })}
        >
          <Prose size="2">{t("model.defaultSelectionHelp")}</Prose>
          <List
            label={t("selection.allowedModels")}
            options={policy.models}
            value={policy.defaults.models}
            effective={effective.models}
            scope="defaults"
            onChange={(models) => onChange({ ...policy, defaults: { ...policy.defaults, models } })}
          />
        </Disclosure>
      </SettingsSection>
      <SettingsSection className="defaults-summary" title={t("selection.toolsTitle")}>
        <TableToolbar>
          <Prose size="2">{countText(effective.tools.length, "tool")}</Prose>
          {managementLink(
            "Tool permissions",
            t("selection.manageDefaultTools"),
            "default-tool-permissions",
          )}
        </TableToolbar>
      </SettingsSection>
      <SettingsSection className="defaults-summary" title={t("skill.title")}>
        <TableToolbar>
          <Prose size="2">{countText(effective.skills.length, "skill")}</Prose>
          {managementLink("Skills", t("skill.manageDefaults"), "default-skills")}
        </TableToolbar>
      </SettingsSection>
      <SettingsSection className="defaults-summary" title={t("selection.serversTitle")}>
        <TableToolbar>
          <Prose size="2">{countText(effective.servers.length, "server gate")}</Prose>
          {managementLink(
            "Tool permissions",
            t("selection.manageDefaultGates"),
            "default-tool-permissions",
          )}
          {managementLink("MCP connections", t("selection.manageServers"))}
        </TableToolbar>
      </SettingsSection>
    </div>
  )
}
