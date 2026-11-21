import type { effectivePolicy } from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Checkbox, Flex, Grid, Text, TextField } from "@radix-ui/themes"
import { useId, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { DefaultModel, thinkingLabel } from "./default-model.js"
import { t } from "./i18n.js"
import { focusEditor } from "./navigation.js"
import { SectionSelect as Select } from "./sections.js"
import { Panel, Prose } from "./surfaces.js"
import { permissionResult } from "./tool-permissions.js"

export function Check({
  id: providedId,
  label,
  checked,
  onChange,
  disabled = false,
  visibleLabel,
}: {
  id?: string
  label: string
  visibleLabel?: string
  checked: boolean
  disabled?: boolean
  onChange(value: boolean): void
}) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  return (
    <label className="check" htmlFor={id}>
      <Checkbox
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      {visibleLabel ?? label}
    </label>
  )
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
  id: providedId,
}: {
  id?: string
  label: string
  value: string
  onChange(value: string): void
  secret?: boolean
}) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  return (
    <label className="form-field" htmlFor={id}>
      {label}
      <TextField.Root
        id={id}
        type={secret ? "password" : "text"}
        value={value}
        autoComplete={secret ? "new-password" : "off"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
export function List({
  label,
  options,
  value,
  onChange,
  inheritable = false,
  effective,
  scope,
  sharedDefault,
  onRepair,
}: {
  label: string
  options: string[]
  value: string[] | null
  onChange(value: string[] | null): void
  inheritable?: boolean
  effective?: string[]
  scope: "global" | "defaults" | "chat"
  sharedDefault?: string[] | null
  onRepair?(): void
}) {
  const displayed = [...new Set([...options, ...(value ?? [])])]
  const blocked = (value ?? (scope === "chat" ? sharedDefault : null) ?? []).filter(
    (name) => !options.includes(name),
  )
  const source =
    scope === "global"
      ? t("selection.global")
      : scope === "defaults"
        ? t("selection.shared")
        : value === null
          ? t("selection.fromShared")
          : t("selection.chatOverride")
  return (
    <Panel as="fieldset" className="policy-list">
      <legend>{label}</legend>
      <Badge color={scope === "chat" && value !== null ? "orange" : "gray"}>{source}</Badge>
      <Prose size="2" color="gray">
        {scope === "global"
          ? t("selection.globalHelp")
          : scope === "defaults"
            ? t("selection.sharedHelp")
            : value === null
              ? t("selection.inheritedHelp")
              : t("selection.overrideHelp")}
      </Prose>
      <Prose size="2">
        {value === null
          ? t(scope === "chat" ? "selection.configuredInherit" : "selection.configuredNone")
          : value.length
            ? t("selection.configuredAllow", { names: value.join(", ") })
            : t("selection.configuredDeny")}
      </Prose>
      {inheritable && (
        <Check
          label={t("selection.inheritDefault")}
          checked={value === null}
          onChange={(v) => onChange(v ? null : [])}
        />
      )}
      <Flex direction="column" gap="2" className="policy-list__options">
        {value !== null &&
          (displayed.length ? (
            displayed.map((name) => (
              <Check
                key={name}
                label={options.includes(name) ? name : t("selection.noLongerAvailable", { name })}
                checked={value.includes(name)}
                onChange={(checked) =>
                  onChange(checked ? [...value, name] : value.filter((v) => v !== name))
                }
              />
            ))
          ) : (
            <Text size="2" color="gray" className="empty-state">
              {t("selection.noApproved")}
            </Text>
          ))}
      </Flex>
      {value === null && !inheritable && (
        <Prose size="2">{t("selection.noDefaultSelection")}</Prose>
      )}
      {value?.length === 0 && (
        <Prose size="2">
          {scope === "global"
            ? t("selection.noGlobalOptions")
            : scope === "defaults"
              ? t("selection.noInheritedOptions")
              : t("selection.denyNoInherit")}
        </Prose>
      )}
      {blocked.length > 0 && (
        <div className="policy-selection-conflict">
          <Prose size="2" color="orange">
            {t("selection.blockedRetained", { names: blocked.join(", ") })}
          </Prose>
          {onRepair && (
            <Button variant="ghost" onClick={onRepair}>
              {t("selection.reviewGlobal")}
            </Button>
          )}
        </div>
      )}
      {scope !== "global" && (
        <Flex direction="column" align="start" gap="2" className="policy-list__status">
          <Prose size="2" color="gray">
            {t("selection.effective", { names: effective?.join(", ") || t("selection.none") })}
          </Prose>
        </Flex>
      )}
      {inheritable && value !== null && (
        <Button variant="soft" onClick={() => onChange(null)}>
          {t("selection.reset", { label: label.toLowerCase() })}
        </Button>
      )}
    </Panel>
  )
}
export function withProviderModelSelection(value: string[], selected: string[], provider?: string) {
  if (!provider) return selected
  const chosen = new Set(selected.filter((ref) => ref.startsWith(`${provider}/`)))
  return [
    ...value.filter((ref) => !ref.startsWith(`${provider}/`) || chosen.has(ref)),
    ...[...chosen].filter((ref) => !value.includes(ref)),
  ]
}

export function ModelAvailability({
  value,
  onChange,
  provider,
}: {
  value: string[]
  onChange(value: string[]): void
  provider?: string
}) {
  // Keep removed rows until this saved revision changes, so an unchecked model can be restored.
  const [approved] = useState(value)
  return (
    <List
      label={t("selection.globallyAvailableModels")}
      scope="global"
      options={[...new Set([...approved, ...value])].filter(
        (ref) => !provider || ref.startsWith(`${provider}/`),
      )}
      value={value.filter((ref) => !provider || ref.startsWith(`${provider}/`))}
      onChange={(v) => onChange(withProviderModelSelection(value, v ?? [], provider))}
    />
  )
}
export function Choices({
  value,
  policy,
  effective,
  inventory,
  onChange,
  defaults = false,
  navigate,
}: {
  value: Selection
  policy: Policy
  effective: ReturnType<typeof effectivePolicy>
  inventory: Inventory
  onChange(value: Selection): void
  defaults?: boolean
  navigate(page: "Tool permissions" | "Skills" | "Model Providers"): void
}) {
  const model = value.model ?? policy.defaults.model
  const levels = inventory.providers
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.id}`, levels: m.thinking })))
    .find((m) => m.ref === model)?.levels ?? ["off"]
  return (
    <Flex direction="column" gap="4" className="settings-stack policy-choices">
      {defaults ? (
        <DefaultModel
          policy={policy}
          inventory={inventory}
          onChange={onChange}
          onAvailability={() => navigate("Model Providers")}
          onProvider={() => navigate("Model Providers")}
        />
      ) : (
        <Panel as="fieldset" className="policy-model">
          <legend>{t("model.thinkingTitle")}</legend>
          <Grid gap="3" className="grid settings-grid policy-model__controls">
            <Flex direction="column" gap="2">
              <label className="form-field" htmlFor="model-selection">
                {t("model.chatModelOverride")}
                <Select.Root
                  value={value.model ?? "inherit"}
                  onValueChange={(v) =>
                    onChange({ ...value, model: v === "inherit" ? null : v, thinking: null })
                  }
                >
                  <Select.Trigger
                    id="model-selection"
                    aria-label={t("model.chatModelOverride")}
                    aria-describedby="model-selection-source"
                    placeholder={t("model.choose")}
                  />
                  <Select.Content>
                    <Select.Item value="inherit">
                      {defaults ? t("model.notConfigured") : t("selection.inheritDefault")}
                    </Select.Item>
                    {[
                      ...new Set([
                        ...(value.models ?? policy.defaults.models ?? []),
                        ...(value.model ? [value.model] : []),
                      ]),
                    ].map((ref) => (
                      <Select.Item key={ref} value={ref}>
                        {(value.models ?? policy.defaults.models ?? []).includes(ref)
                          ? ref
                          : t("model.notAllowedNamed", { model: ref })}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </label>
              <Prose id="model-selection-source" size="2" color="gray">
                {t(value.model === null ? "model.inheritedSource" : "model.overrideSource", {
                  model: effective.model ?? t("model.noAllowed"),
                })}
              </Prose>
            </Flex>
            <Flex direction="column" gap="2">
              <label className="form-field" htmlFor="thinking-selection">
                {t("model.thinkingLevel")}
                <Select.Root
                  value={value.thinking ?? "inherit"}
                  onValueChange={(v) =>
                    onChange({
                      ...value,
                      thinking: v === "inherit" ? null : (v as Selection["thinking"]),
                    })
                  }
                >
                  <Select.Trigger
                    id="thinking-selection"
                    aria-label={t("model.thinkingLevel")}
                    aria-describedby="thinking-selection-source"
                  />
                  <Select.Content>
                    <Select.Item value="inherit">
                      {defaults ? t("model.offDefault") : t("selection.inheritDefault")}
                    </Select.Item>
                    {levels.map((level) => (
                      <Select.Item key={level} value={level}>
                        {thinkingLabel(level)}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </label>
              <Prose id="thinking-selection-source" size="2" color="gray">
                {t(value.thinking === null ? "model.inheritedThinking" : "model.overrideThinking", {
                  level: thinkingLabel(effective.thinking ?? "off"),
                })}
              </Prose>
            </Flex>
          </Grid>
          {(value.model !== null || value.thinking !== null) && (
            <Button
              variant="soft"
              onClick={() => onChange({ ...value, model: null, thinking: null })}
            >
              {t("model.resetDefault")}
            </Button>
          )}
        </Panel>
      )}
      {value.model && !(value.models ?? policy.defaults.models ?? []).includes(value.model) && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            {t(
              defaults
                ? "model.defaultConflict"
                : value.models === null
                  ? "model.inheritedConflict"
                  : "model.chatConflict",
              { model: value.model },
            )}
          </Callout.Text>
          <Button
            variant="soft"
            onClick={() => focusEditor(`#${defaults ? "default" : "chat"}-models-options`)}
          >
            {t("model.reviewAllowed")}
          </Button>
        </Callout.Root>
      )}
      {!defaults && (
        <>
          <Callout.Root color="amber" aria-label={t("selection.chatAuthorization")}>
            <Callout.Text>{t("selection.authorizationHelp")}</Callout.Text>
          </Callout.Root>
          <section aria-label={t("selection.chatToolResults")}>
            <Text as="p" size="2" weight="medium">
              {t(value.tools === null ? "selection.toolInherited" : "selection.toolOverride")}
            </Text>
            <ul>
              {[...new Set(value.tools ?? policy.defaults.tools ?? [])].map((name) => {
                const result = permissionResult("tools", name, policy, inventory, {
                  selection: value,
                  effective,
                })
                const availability = inventory.toolAvailability?.[name]
                return (
                  <li key={name}>
                    <strong>{name}</strong> ·{" "}
                    {t("selection.toolResult", {
                      source: result.sourceLabel,
                      status: result.statusLabel,
                    })}
                    {result.blocking && (
                      <>
                        <Text as="p" size="2">
                          {t("selection.blockingSource", { source: result.blockingLabel ?? "" })}
                        </Text>
                        <Button variant="ghost" onClick={() => navigate("Tool permissions")}>
                          {t("selection.reviewBlocking", { name })}
                        </Button>
                      </>
                    )}
                    {availability?.available === false && (
                      <Text as="p" size="2">
                        {t("selection.capabilityUnavailable", { reason: availability.reason })}
                      </Text>
                    )}
                  </li>
                )
              })}
            </ul>
            {!(value.tools ?? policy.defaults.tools ?? []).length && (
              <Text as="p" size="2">
                {t("selection.noChatTools")}
              </Text>
            )}
          </section>
        </>
      )}
      <Grid gap="4" className="grid settings-grid policy-choice-lists">
        {(defaults
          ? (["models"] as const)
          : (["tools", "servers", "skills", "models"] as const)
        ).map((key) => {
          const label = {
            tools: t("selection.authorizedTools"),
            servers: t("selection.authorizedServers"),
            skills: t("selection.enabledSkills"),
            models: t("selection.allowedModels"),
          }[key]
          return (
            <details key={key} className="policy-options">
              <summary id={`${defaults ? "default" : "chat"}-${key}-options`}>
                {t(value[key] == null ? "selection.inheritedSummary" : "selection.customSummary", {
                  label,
                  count: effective[key].length,
                })}
              </summary>
              <List
                label={label}
                options={policy[key] ?? []}
                value={value[key] ?? null}
                onChange={(v) => onChange({ ...value, [key]: v })}
                inheritable={!defaults}
                effective={effective[key]}
                scope={defaults ? "defaults" : "chat"}
                sharedDefault={policy.defaults[key]}
                onRepair={() =>
                  navigate(
                    key === "skills"
                      ? "Skills"
                      : key === "models"
                        ? "Model Providers"
                        : "Tool permissions",
                  )
                }
              />
            </details>
          )
        })}
      </Grid>
      {!defaults && (
        <Flex gap="3" wrap="wrap">
          <Button variant="ghost" onClick={() => navigate("Tool permissions")}>
            {t("selection.manageTools")}
          </Button>
          <Button variant="ghost" onClick={() => navigate("Skills")}>
            {t("skill.manageGlobalDefaults")}
          </Button>
        </Flex>
      )}
    </Flex>
  )
}
export function SecretFields({
  onChange,
  onPending,
}: {
  onPending(value: boolean): void
  onChange(value: { scope: "env" | "headers"; name: string; value: string }): void
}) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [scope, setScope] = useState<"env" | "headers">("env")
  return (
    <Panel as="fieldset">
      <legend>{t("selection.secretReplacement")}</legend>
      <Prose size="2">{t("selection.secretHelp")}</Prose>
      <label htmlFor="secret-scope">
        {t("selection.fieldMap")}
        <Select.Root value={scope} onValueChange={(v) => setScope(v as "env" | "headers")}>
          <Select.Trigger id="secret-scope" aria-label={t("selection.fieldMap")} />
          <Select.Content>
            <Select.Item value="env">{t("selection.environment")}</Select.Item>
            <Select.Item value="headers">{t("selection.headers")}</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      <Field
        id="secret-name"
        label={t("selection.secretName")}
        value={name}
        onChange={(v) => {
          setName(v)
          onPending(Boolean(v || value))
        }}
      />
      <Field
        secret
        label={t("selection.secretValue")}
        value={value}
        onChange={(v) => {
          setValue(v)
          onPending(Boolean(v || name))
        }}
      />
      <Button
        variant="soft"
        disabled={!name || !value}
        onClick={() => {
          onChange({ scope, name, value })
          onPending(false)
          setName("")
          setValue("")
        }}
      >
        {t("selection.stageSecret")}
      </Button>
      {(name || value) && (
        <Button
          variant="soft"
          onClick={() => {
            setName("")
            setValue("")
            onPending(false)
          }}
        >
          {t("selection.clearSecret")}
        </Button>
      )}
    </Panel>
  )
}
