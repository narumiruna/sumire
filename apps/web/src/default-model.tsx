import { effectivePolicy } from "@narumitw/sumire-policy"
import { AlertDialog, DialogTrigger } from "@react-spectrum/s2/AlertDialog"
import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useContext, useEffect, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { modelIssues } from "./chat-state.js"
import { t } from "./i18n.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { SectionActive } from "./sections.js"
import { Prose, StatusLabel } from "./surfaces.js"

const thinkingKeys = {
  off: "model.thinking.off",
  minimal: "model.thinking.minimal",
  low: "model.thinking.low",
  medium: "model.thinking.medium",
  high: "model.thinking.high",
  xhigh: "model.thinking.xhigh",
  max: "model.thinking.max",
} as const

export function thinkingLabel(level: string): string {
  return Object.hasOwn(thinkingKeys, level)
    ? t(thinkingKeys[level as keyof typeof thinkingKeys])
    : level
}

export function defaultModelOptions(policy: Policy, inventory: Inventory) {
  return inventory.providers
    .filter((provider) => policy.providers.find((p) => p.id === provider.id)?.enabled !== false)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        ref: `${provider.id}/${model.id}`,
        levels: model.thinking,
      })),
    )
    .filter((model) => policy.models.includes(model.ref) && model.levels.length > 0)
}

/** Add only to shared selection; global availability and chat overrides are not edited. */
export function selectDefaultModel(
  selection: Selection,
  ref: string,
  thinking: Selection["thinking"],
): Selection {
  return {
    ...selection,
    model: ref,
    thinking,
    models: [...new Set([...(selection.models ?? []), ref])],
  }
}

export function DefaultModel({
  policy,
  saved = policy.defaults,
  inventory,
  onChange,
  onAvailability,
  onProvider,
}: {
  policy: Policy
  saved?: Selection
  inventory: Inventory
  onChange(value: Selection): void
  onAvailability(): void
  onProvider(provider: string): void
}) {
  const active = useContext(SectionActive)
  const [clearOpen, setClearOpen] = useState(false)
  useEffect(() => {
    if (!active) setClearOpen(false)
  }, [active])
  const value = policy.defaults
  const options = defaultModelOptions(policy, inventory)
  const current = options.find((option) => option.ref === value.model)
  const modelNames = new Map<string, string>(
    inventory.providers.flatMap((provider) =>
      provider.models.map((model) => [`${provider.id}/${model.id}`, model.name] as const),
    ),
  )
  const thinkingValid = !value.model || Boolean(current?.levels.includes(value.thinking ?? "off"))
  const providerId = value.model?.split("/")[0]
  const provider = inventory.providers.find((item) => item.id === providerId)
  const issue = modelIssues(effectivePolicy(policy, 0).model, value.model, inventory)[0]
  return (
    <fieldset className="model-fields">
      <legend className="visually-hidden">{t("model.default")}</legend>
      <div className="grid settings-grid policy-model__controls">
        <label className="form-field" htmlFor="default-model-selection">
          <span>
            {t("model.sharedDefaultModel")}{" "}
            {saved.model !== value.model && (
              <StatusLabel tone="warning">{t("selection.changed")}</StatusLabel>
            )}
          </span>
          <SectionPicker
            value={value.model ?? "none"}
            onValueChange={(ref) => {
              const option = options.find((option) => option.ref === ref)
              if (option)
                onChange(
                  selectDefaultModel(
                    value,
                    ref,
                    (option.levels.includes(value.thinking ?? "off")
                      ? (value.thinking ?? "off")
                      : option.levels[0]) as Selection["thinking"],
                  ),
                )
            }}
            id="default-model-selection"
            aria-label={t("model.sharedDefaultModel")}
            title={value.model ?? t("model.notConfigured")}
          >
            {!value.model && (
              <PickerOption id="none" isDisabled>
                {t("model.notConfigured")}
              </PickerOption>
            )}
            {value.model && !current && (
              <PickerOption id={value.model} isDisabled>
                {t("model.unavailableNamed", { model: value.model })}
              </PickerOption>
            )}
            {options.map((option) => (
              <PickerOption key={option.ref} id={option.ref}>
                {modelNames.get(option.ref) ?? option.ref}
              </PickerOption>
            ))}
          </SectionPicker>
        </label>
        <label className="form-field" htmlFor="default-thinking-selection">
          <span>
            {t("model.sharedThinking")}{" "}
            {saved.thinking !== value.thinking && (
              <StatusLabel tone="warning">{t("selection.changed")}</StatusLabel>
            )}
          </span>
          <SectionPicker
            value={value.thinking ?? "off"}
            disabled={!current}
            onValueChange={(thinking) =>
              onChange({ ...value, thinking: thinking as Selection["thinking"] })
            }
            id="default-thinking-selection"
            aria-label={t("model.sharedThinking")}
          >
            {!thinkingValid && (
              <PickerOption id={value.thinking ?? "off"} isDisabled>
                {t("model.unsupportedThinking", {
                  level: thinkingLabel(value.thinking ?? "off"),
                })}
              </PickerOption>
            )}
            {(current?.levels ?? (thinkingValid ? ["off"] : [])).map((level) => (
              <PickerOption key={level} id={level}>
                {thinkingLabel(level)}
              </PickerOption>
            ))}
          </SectionPicker>
        </label>
      </div>
      {value.model && !current && <Prose color="orange">{t("model.savedUnavailable")}</Prose>}
      {!thinkingValid && <Prose role="alert">{t("model.chooseThinking")}</Prose>}
      <section
        aria-label={t("model.defaultSetup")}
        className="provider-readiness"
        data-attention={Boolean(issue)}
      >
        <div>
          <div
            className={style({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 })}
          >
            <strong>{provider?.name ?? providerId ?? t("model.noProvider")}</strong>
            <StatusLabel tone={issue ? "warning" : "neutral"}>
              {issue?.code === "authentication"
                ? t("model.authenticationRequired")
                : (issue?.label ?? t("model.configuredLocally"))}
            </StatusLabel>
          </div>
          {saved.model !== value.model && <Prose size="2">{t("model.draftSetup")}</Prose>}
          <Prose size="2">{issue?.reason ?? t("model.localUnchecked")}</Prose>
        </div>
        {providerId && (
          <Button variant="secondary" fillStyle="outline" onPress={() => onProvider(providerId)}>
            {t("provider.configure")}
          </Button>
        )}
      </section>
      <div className={style({ display: "flex", flexWrap: "wrap", gap: 8 })}>
        <Button variant="secondary" onPress={onAvailability}>
          {t("model.manageAvailability")}
        </Button>
        {value.model && (
          <DialogTrigger isOpen={clearOpen && active} onOpenChange={setClearOpen}>
            <Button variant="secondary" fillStyle="outline">
              {t("model.clearDefault")}
            </Button>
            <AlertDialog
              variant="destructive"
              title={t("model.clearDefaultTitle")}
              cancelLabel={t("selection.cancel")}
              primaryActionLabel={t("model.clearDraftDefault")}
              autoFocusButton="cancel"
              onPrimaryAction={() => onChange({ ...value, model: null, thinking: null })}
            >
              {t("model.clearDefaultDescription")}
            </AlertDialog>
          </DialogTrigger>
        )}
      </div>
    </fieldset>
  )
}
