import { effectivePolicy } from "@narumitw/sumire-policy"
import { Button, Callout, Code, Flex } from "@radix-ui/themes"
import type { Inventory, Policy } from "./api.js"
import { DefaultModel } from "./default-model.js"
import { focusEditor, navigationHref, type Page } from "./navigation.js"
import { List } from "./policy-editors.js"
import { countText } from "./status-text.js"
import { Disclosure, Prose, SettingsSection, StatusLabel, TableToolbar } from "./surfaces.js"
import { toolPermissionGroups } from "./tool-permissions.js"

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
    <Button variant="outline" asChild>
      <a
        href={navigationHref(
          page,
          chat,
          new URL(anchor ? `#${anchor}` : "#", window.location.href),
        )}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return
          event.preventDefault()
          navigate(page, anchor)
        }}
      >
        {label}
      </a>
    </Button>
  )
  const effective = effectivePolicy(policy, 0)
  const groups = toolPermissionGroups(effective.tools, inventory)
  const skills = effective.skills
  return (
    <div className="defaults-layout">
      <SettingsSection
        id="default-model-settings"
        tabIndex={-1}
        title="Model & thinking"
        description="Choose the default model and its thinking level."
      >
        <DefaultModel
          policy={policy}
          saved={saved.defaults}
          inventory={inventory}
          onChange={(defaults) => onChange({ ...policy, defaults })}
          onAvailability={() => navigate("Model Providers", "model-availability")}
          onProvider={onProvider}
        />
        {policy.defaults.model && !policy.defaults.models?.includes(policy.defaults.model) && (
          <Callout.Root color="orange" role="alert">
            <Callout.Text>
              Model "{policy.defaults.model}" is not in Allowed models. Restore its selection or
              choose another default.
            </Callout.Text>
            <Button variant="outline" onClick={() => focusEditor("#default-models-options")}>
              Review allowed models
            </Button>
          </Callout.Root>
        )}
        <Disclosure
          summaryId="default-models-options"
          title={`Allowed models · ${effective.models.length} effective`}
        >
          <Prose size="2">
            Selecting a default model also adds it to this shared selection. Global availability
            still limits the selection.
          </Prose>
          <List
            label="Allowed models"
            options={policy.models}
            value={policy.defaults.models}
            effective={effective.models}
            scope="defaults"
            onChange={(models) => onChange({ ...policy, defaults: { ...policy.defaults, models } })}
          />
        </Disclosure>
      </SettingsSection>
      <SettingsSection
        title="Default tool permissions"
        description="Configured permissions within global limits."
      >
        <TableToolbar>
          <Prose size="2">
            {countText(effective.tools.length, "tool")} · {countText(groups.length, "source")} ·{" "}
            {countText(effective.servers.length, "server gate")}
          </Prose>
          {managementLink(
            "Tool permissions",
            "Manage default tool permissions",
            "default-tool-permissions",
          )}
        </TableToolbar>
        <ul className="summary-rows" aria-label="Default tool summary">
          {effective.tools.slice(0, 4).map((name) => (
            <li key={name}>
              <Code variant="ghost">{name}</Code>
              <StatusLabel>Allowed by policy</StatusLabel>
            </li>
          ))}
        </ul>
        {effective.tools.length === 0 && (
          <Prose size="2" color="gray">
            No tools allowed by default.
          </Prose>
        )}
        {effective.tools.length > 4 && (
          <Button
            variant="ghost"
            onClick={() => navigate("Tool permissions", "default-tool-permissions")}
          >
            View all {effective.tools.length} tools
          </Button>
        )}
      </SettingsSection>
      <SettingsSection title="Default skills" description="Instruction sets, not tool access.">
        <TableToolbar>
          <Prose size="2">{countText(skills.length, "skill")} selected</Prose>
          {managementLink("Skills", "Manage default skills")}
        </TableToolbar>
        <ul className="summary-rows" aria-label="Default skill summary">
          {skills.slice(0, 3).map((name) => (
            <li key={name}>
              <Code variant="ghost">{name}</Code>
              <span className="summary-description">
                {inventory.skills?.find((skill) => skill.name === name)?.description ||
                  "Description not available."}
              </span>
            </li>
          ))}
        </ul>
        {skills.length === 0 && (
          <Prose size="2" color="gray">
            No skills selected by default.
          </Prose>
        )}
        {skills.length > 3 && (
          <Flex>
            <Button variant="ghost" onClick={() => navigate("Skills")}>
              View all {skills.length} skills
            </Button>
          </Flex>
        )}
      </SettingsSection>
    </div>
  )
}
