import { AlertDialog, Badge, Button, Callout, Flex, Grid } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { Panel, Prose } from "./surfaces.js"

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
  inventory,
  onChange,
  onAvailability,
}: {
  policy: Policy
  inventory: Inventory
  onChange(value: Selection): void
  onAvailability(): void
}) {
  const active = useContext(SectionActive)
  const [clearOpen, setClearOpen] = useState(false)
  useEffect(() => {
    if (!active) setClearOpen(false)
  }, [active])
  const value = policy.defaults
  const options = defaultModelOptions(policy, inventory)
  const current = options.find((option) => option.ref === value.model)
  const thinkingValid = !value.model || Boolean(current?.levels.includes(value.thinking ?? "off"))
  return (
    <Panel as="fieldset" className="policy-model">
      <legend>Default model</legend>
      <Badge color="gray">Shared defaults</Badge>
      <Grid gap="3" className="grid settings-grid policy-model__controls">
        <label className="form-field" htmlFor="default-model-selection">
          Shared default model
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
            <Select.Trigger id="default-model-selection" aria-label="Shared default model" />
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
                <Select.Item key={option.ref} value={option.ref}>
                  {option.ref}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
        <label className="form-field" htmlFor="default-thinking-selection">
          Shared default thinking
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
      <Prose size="2">
        Globally allowed models → Shared defaults → Chat overrides. Shared changes affect only
        inherited fields, within each chat's allowed models. Selecting a model also adds it to
        shared Allowed models if needed.
      </Prose>
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
    </Panel>
  )
}
