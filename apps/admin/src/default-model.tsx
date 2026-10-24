import { effectivePolicy } from "@narumitw/sumire-policy"
import { AlertDialog, Button, Callout, Flex, Grid } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { modelIssues } from "./chat-state.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { Prose, StatusLabel } from "./surfaces.js"

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
      <legend className="visually-hidden">Default model</legend>
      <Grid gap="3" className="grid settings-grid policy-model__controls">
        <label className="form-field" htmlFor="default-model-selection">
          <span>
            Shared default model{" "}
            {saved.model !== value.model && <StatusLabel tone="warning">Changed</StatusLabel>}
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
              aria-label="Shared default model"
              title={value.model ?? "Not configured"}
            />
            <Select.Content>
              {!value.model && (
                <Select.Item value="none" disabled>
                  Not configured
                </Select.Item>
              )}
              {value.model && !current && (
                <Select.Item value={value.model} disabled>
                  {value.model} (unavailable)
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
            Shared default thinking{" "}
            {saved.thinking !== value.thinking && <StatusLabel tone="warning">Changed</StatusLabel>}
          </span>
          <Select.Root
            value={value.thinking ?? "off"}
            disabled={!current}
            onValueChange={(thinking) =>
              onChange({ ...value, thinking: thinking as Selection["thinking"] })
            }
          >
            <Select.Trigger id="default-thinking-selection" aria-label="Shared default thinking" />
            <Select.Content>
              {!thinkingValid && (
                <Select.Item value={value.thinking ?? "off"} disabled>
                  {value.thinking ?? "off"} (unsupported)
                </Select.Item>
              )}
              {(current?.levels ?? (thinkingValid ? ["off"] : [])).map((level) => (
                <Select.Item key={level} value={level}>
                  {level}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
      </Grid>
      {value.model && !current && (
        <Callout.Root color="orange">
          <Callout.Text>
            The saved or draft model is not available in the loaded catalog. Choose an approved
            model or review model availability. No replacement is selected automatically.
          </Callout.Text>
        </Callout.Root>
      )}
      {!thinkingValid && (
        <Prose role="alert">Choose a supported thinking level before saving.</Prose>
      )}
      <section
        aria-label="Shared default model setup"
        className="provider-readiness"
        data-attention={Boolean(issue)}
      >
        <div>
          <Flex gap="2" align="center" wrap="wrap">
            <strong>{provider?.name ?? providerId ?? "No provider selected"}</strong>
            <StatusLabel tone={issue ? "warning" : "neutral"}>
              {issue?.code === "authentication"
                ? "Authentication required"
                : (issue?.label ?? "Configured locally")}
            </StatusLabel>
          </Flex>
          {saved.model !== value.model && (
            <Prose size="2">For the draft selection. Shared defaults are not saved yet.</Prose>
          )}
          <Prose size="2">
            {issue?.reason ?? "Credentials configured locally. Model response not checked."}
          </Prose>
        </div>
        {providerId && (
          <Button variant="outline" onClick={() => onProvider(providerId)}>
            Configure provider
          </Button>
        )}
      </section>
      <Flex gap="2" wrap="wrap">
        <Button variant="soft" onClick={onAvailability}>
          Manage model availability
        </Button>
        {value.model && (
          <AlertDialog.Root open={clearOpen && active} onOpenChange={setClearOpen}>
            <AlertDialog.Trigger>
              <Button variant="ghost">Clear shared default model</Button>
            </AlertDialog.Trigger>
            <AlertDialog.Content
              onCloseAutoFocus={(event) => {
                if (!active) event.preventDefault()
              }}
            >
              <AlertDialog.Title>Clear the shared default model?</AlertDialog.Title>
              <AlertDialog.Description>
                Stage an unconfigured model and thinking default. Allowed models, authentication,
                and chat overrides stay unchanged. Review and save settings to apply this change.
              </AlertDialog.Description>
              <Flex gap="3" mt="4">
                <AlertDialog.Cancel>
                  <Button variant="soft">Cancel</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button onClick={() => onChange({ ...value, model: null, thinking: null })}>
                    Clear default in draft
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
