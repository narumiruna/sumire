import type { effectivePolicy } from "@narumitw/sumire-policy"
import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useId, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { Check } from "./check.js"
import { DefaultModel, thinkingLabel } from "./default-model.js"
import { t } from "./i18n.js"
import { focusEditor } from "./navigation.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { Panel, Prose, StatusLabel } from "./surfaces.js"
import { permissionResult } from "./tool-permissions.js"
import "./spectrum-policy.css"

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
      <input
        className={`policy-field ${style({
          color: "body",
          backgroundColor: "layer-2",
          borderColor: "gray-700",
          borderRadius: "default",
          font: "ui-lg",
        })}`}
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
      <StatusLabel tone={scope === "chat" && value !== null ? "warning" : "neutral"}>
        {source}
      </StatusLabel>
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
      <div
        className={`policy-list__options ${style({ display: "flex", flexDirection: "column", gap: 8 })}`}
      >
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
            <Prose size="2" color="gray" className="empty-state">
              {t("selection.noApproved")}
            </Prose>
          ))}
      </div>
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
            <Button variant="secondary" fillStyle="outline" onPress={onRepair}>
              {t("selection.reviewGlobal")}
            </Button>
          )}
        </div>
      )}
      {scope !== "global" && (
        <div
          className={`policy-list__status ${style({ display: "flex", flexDirection: "column", alignItems: "start", gap: 8 })}`}
        >
          <Prose size="2" color="gray">
            {t("selection.effective", { names: effective?.join(", ") || t("selection.none") })}
          </Prose>
        </div>
      )}
      {inheritable && value !== null && (
        <Button variant="secondary" fillStyle="outline" onPress={() => onChange(null)}>
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
  const matches = (ref: string) => !provider || ref.startsWith(`${provider}/`)
  const options = [...new Set([...approved, ...value])].filter(matches)
  const selected = value.filter(matches)
  return (
    <Panel as="fieldset" className="policy-list">
      <legend>{t("selection.globallyAvailableModels")}</legend>
      {options.length === 0 ? (
        <Prose size="2" color="gray" className="empty-state">
          {t("selection.noGlobalOptions")}
        </Prose>
      ) : (
        <div
          className={`policy-list__options ${style({ display: "flex", flexDirection: "column", gap: 8 })}`}
        >
          {options.map((ref) => (
            <Check
              key={ref}
              label={ref}
              checked={selected.includes(ref)}
              onChange={(checked) =>
                onChange(
                  withProviderModelSelection(
                    value,
                    checked ? [...selected, ref] : selected.filter((name) => name !== ref),
                    provider,
                  ),
                )
              }
            />
          ))}
        </div>
      )}
    </Panel>
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
    <div
      className={`settings-stack policy-choices ${style({ display: "flex", flexDirection: "column", gap: 16 })}`}
    >
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
          <div className="grid settings-grid policy-model__controls">
            <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
              <label className="form-field" htmlFor="model-selection">
                {t("model.chatModelOverride")}
                <SectionPicker
                  value={value.model ?? "inherit"}
                  onValueChange={(v) =>
                    onChange({ ...value, model: v === "inherit" ? null : v, thinking: null })
                  }
                  id="model-selection"
                  aria-label={t("model.chatModelOverride")}
                  aria-describedby="model-selection-source"
                  placeholder={t("model.choose")}
                >
                  <PickerOption id="inherit">
                    {defaults ? t("model.notConfigured") : t("selection.inheritDefault")}
                  </PickerOption>
                  {[
                    ...new Set([
                      ...(value.models ?? policy.defaults.models ?? []),
                      ...(value.model ? [value.model] : []),
                    ]),
                  ].map((ref) => (
                    <PickerOption key={ref} id={ref}>
                      {(value.models ?? policy.defaults.models ?? []).includes(ref)
                        ? ref
                        : t("model.notAllowedNamed", { model: ref })}
                    </PickerOption>
                  ))}
                </SectionPicker>
              </label>
              <Prose id="model-selection-source" size="2" color="gray">
                {t(value.model === null ? "model.inheritedSource" : "model.overrideSource", {
                  model: effective.model ?? t("model.noAllowed"),
                })}
              </Prose>
            </div>
            <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
              <label className="form-field" htmlFor="thinking-selection">
                {t("model.thinkingLevel")}
                <SectionPicker
                  value={value.thinking ?? "inherit"}
                  onValueChange={(v) =>
                    onChange({
                      ...value,
                      thinking: v === "inherit" ? null : (v as Selection["thinking"]),
                    })
                  }
                  id="thinking-selection"
                  aria-label={t("model.thinkingLevel")}
                  aria-describedby="thinking-selection-source"
                >
                  <PickerOption id="inherit">
                    {defaults ? t("model.offDefault") : t("selection.inheritDefault")}
                  </PickerOption>
                  {levels.map((level) => (
                    <PickerOption key={level} id={level}>
                      {thinkingLabel(level)}
                    </PickerOption>
                  ))}
                </SectionPicker>
              </label>
              <Prose id="thinking-selection-source" size="2" color="gray">
                {t(value.thinking === null ? "model.inheritedThinking" : "model.overrideThinking", {
                  level: thinkingLabel(effective.thinking ?? "off"),
                })}
              </Prose>
            </div>
          </div>
          {(value.model !== null || value.thinking !== null) && (
            <Button
              variant="secondary"
              fillStyle="outline"
              onPress={() => onChange({ ...value, model: null, thinking: null })}
            >
              {t("model.resetDefault")}
            </Button>
          )}
        </Panel>
      )}
      {value.model && !(value.models ?? policy.defaults.models ?? []).includes(value.model) && (
        <InlineAlert variant="negative">
          <Content>
            {t(
              defaults
                ? "model.defaultConflict"
                : value.models === null
                  ? "model.inheritedConflict"
                  : "model.chatConflict",
              { model: value.model },
            )}
          </Content>
          <Button
            variant="secondary"
            fillStyle="outline"
            onPress={() => focusEditor(`#${defaults ? "default" : "chat"}-models-options`)}
          >
            {t("model.reviewAllowed")}
          </Button>
        </InlineAlert>
      )}
      {!defaults && (
        <>
          <section
            className={style({
              padding: 12,
              borderRadius: "default",
              backgroundColor: "notice-subtle",
              color: "notice-1000",
            })}
            aria-label={t("selection.chatAuthorization")}
          >
            {t("selection.authorizationHelp")}
          </section>
          <section aria-label={t("selection.chatToolResults")}>
            <Prose size="2" weight="medium">
              {t(value.tools === null ? "selection.toolInherited" : "selection.toolOverride")}
            </Prose>
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
                        <Prose size="2">
                          {t("selection.blockingSource", { source: result.blockingLabel ?? "" })}
                        </Prose>
                        <Button
                          variant="secondary"
                          fillStyle="outline"
                          onPress={() => navigate("Tool permissions")}
                        >
                          {t("selection.reviewBlocking", { name })}
                        </Button>
                      </>
                    )}
                    {availability?.available === false && (
                      <Prose size="2">
                        {t("selection.capabilityUnavailable", { reason: availability.reason })}
                      </Prose>
                    )}
                  </li>
                )
              })}
            </ul>
            {!(value.tools ?? policy.defaults.tools ?? []).length && (
              <Prose size="2">{t("selection.noChatTools")}</Prose>
            )}
          </section>
        </>
      )}
      <div className="grid settings-grid policy-choice-lists">
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
      </div>
      {!defaults && (
        <div className={style({ display: "flex", flexWrap: "wrap", gap: 12 })}>
          <Button
            variant="secondary"
            fillStyle="outline"
            onPress={() => navigate("Tool permissions")}
          >
            {t("selection.manageTools")}
          </Button>
          <Button variant="secondary" fillStyle="outline" onPress={() => navigate("Skills")}>
            {t("skill.manageGlobalDefaults")}
          </Button>
        </div>
      )}
    </div>
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
        <SectionPicker
          value={scope}
          onValueChange={(v) => setScope(v as "env" | "headers")}
          id="secret-scope"
          aria-label={t("selection.fieldMap")}
        >
          <PickerOption id="env">{t("selection.environment")}</PickerOption>
          <PickerOption id="headers">{t("selection.headers")}</PickerOption>
        </SectionPicker>
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
        variant="secondary"
        fillStyle="outline"
        isDisabled={!name || !value}
        onPress={() => {
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
          variant="secondary"
          fillStyle="outline"
          onPress={() => {
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
