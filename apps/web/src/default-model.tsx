import { effectivePolicy } from "@narumitw/sumire-policy"
import { AlertDialog, Button, Callout, Flex, Grid } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { modelIssues } from "./chat-state.js"
import { t } from "./i18n.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
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
      <Grid gap="3" className="grid settings-grid policy-model__controls">
        <label className="form-field" htmlFor="default-model-selection">
          <span>
            {t("model.sharedDefaultModel")}{" "}
            {saved.model !== value.model && (
              <StatusLabel tone="warning">{t("selection.changed")}</StatusLabel>
            )}
          </span>
          <Select.Root
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
          >
            <Select.Trigger
              id="default-model-selection"
              aria-label={t("model.sharedDefaultModel")}
              title={value.model ?? t("model.notConfigured")}
            />
            <Select.Content>
              {!value.model && (
                <Select.Item value="none" disabled>
                  {t("model.notConfigured")}
                </Select.Item>
              )}
              {value.model && !current && (
                <Select.Item value={value.model} disabled>
                  {t("model.unavailableNamed", { model: value.model })}
                </Select.Item>
              )}
              {options.map((option) => (
                <Select.Item key={option.ref} value={option.ref} title={option.ref}>
                  {modelNames.get(option.ref) ?? option.ref}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
        <label className="form-field" htmlFor="default-thinking-selection">
          <span>
            {t("model.sharedThinking")}{" "}
            {saved.thinking !== value.thinking && (
              <StatusLabel tone="warning">{t("selection.changed")}</StatusLabel>
            )}
          </span>
          <Select.Root
            value={value.thinking ?? "off"}
            disabled={!current}
            onValueChange={(thinking) =>
              onChange({ ...value, thinking: thinking as Selection["thinking"] })
            }
          >
            <Select.Trigger
              id="default-thinking-selection"
              aria-label={t("model.sharedThinking")}
            />
            <Select.Content>
              {!thinkingValid && (
                <Select.Item value={value.thinking ?? "off"} disabled>
                  {t("model.unsupportedThinking", {
                    level: thinkingLabel(value.thinking ?? "off"),
                  })}
                </Select.Item>
              )}
              {(current?.levels ?? (thinkingValid ? ["off"] : [])).map((level) => (
                <Select.Item key={level} value={level}>
                  {thinkingLabel(level)}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
      </Grid>
      {value.model && !current && (
        <Callout.Root color="orange">
          <Callout.Text>{t("model.savedUnavailable")}</Callout.Text>
        </Callout.Root>
      )}
      {!thinkingValid && <Prose role="alert">{t("model.chooseThinking")}</Prose>}
      <section
        aria-label={t("model.defaultSetup")}
        className="provider-readiness"
        data-attention={Boolean(issue)}
      >
        <div>
          <Flex gap="2" align="center" wrap="wrap">
            <strong>{provider?.name ?? providerId ?? t("model.noProvider")}</strong>
            <StatusLabel tone={issue ? "warning" : "neutral"}>
              {issue?.code === "authentication"
                ? t("model.authenticationRequired")
                : (issue?.label ?? t("model.configuredLocally"))}
            </StatusLabel>
          </Flex>
          {saved.model !== value.model && <Prose size="2">{t("model.draftSetup")}</Prose>}
          <Prose size="2">{issue?.reason ?? t("model.localUnchecked")}</Prose>
        </div>
        {providerId && (
          <Button variant="outline" onClick={() => onProvider(providerId)}>
            {t("provider.configure")}
          </Button>
        )}
      </section>
      <Flex gap="2" wrap="wrap">
        <Button variant="soft" onClick={onAvailability}>
          {t("model.manageAvailability")}
        </Button>
        {value.model && (
          <AlertDialog.Root open={clearOpen && active} onOpenChange={setClearOpen}>
            <AlertDialog.Trigger>
              <Button variant="ghost">{t("model.clearDefault")}</Button>
            </AlertDialog.Trigger>
            <AlertDialog.Content
              onCloseAutoFocus={(event) => {
                if (!active) event.preventDefault()
              }}
            >
              <AlertDialog.Title>{t("model.clearDefaultTitle")}</AlertDialog.Title>
              <AlertDialog.Description>
                {t("model.clearDefaultDescription")}
              </AlertDialog.Description>
              <Flex gap="3" mt="4">
                <AlertDialog.Cancel>
                  <Button variant="soft">{t("selection.cancel")}</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button onClick={() => onChange({ ...value, model: null, thinking: null })}>
                    {t("model.clearDraftDefault")}
                  </Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        )}
      </Flex>
    </fieldset>
  )
}
