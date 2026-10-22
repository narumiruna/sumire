import type { effectivePolicy } from "@narumitw/sumire-policy"
import { MagnifyingGlassIcon } from "@radix-ui/react-icons"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Code,
  DataList,
  Flex,
  Grid,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes"
import { useEffect, useId, useState } from "react"
import { type Inventory, type Policy, parseIds, type Selection } from "./api.js"
import { type Chat, chatName } from "./chats.js"
import { pageLabel } from "./navigation.js"
import { SectionSelect as Select } from "./sections.js"
import { countText } from "./status-text.js"
import { Panel, Prose } from "./surfaces.js"

export function Check({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange(value: boolean): void
}) {
  const id = useId()
  return (
    <label className="check" htmlFor={id}>
      <Checkbox
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      {label}
    </label>
  )
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string
  value: string
  onChange(value: string): void
  secret?: boolean
}) {
  const id = useId()
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
export function IdList({
  label,
  values,
  savedValues,
  target,
  chats,
  positive,
  onChange,
  onPending,
}: {
  label: string
  values: number[]
  savedValues: number[]
  target: string
  chats: Chat[]
  positive: boolean
  onChange(values: number[]): void
  onPending(value: boolean): void
}) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const searchId = useId()
  useEffect(() => {
    setQuery(target && Number(target) > 0 === positive ? target : "")
  }, [target, positive])
  const metadata = new Map(chats.map((chat) => [chat.id, chat]))
  const names = new Map(chats.map((chat) => [chat.id, chat.name]))
  const matches = (id: number) =>
    `${names.get(id) ?? ""} ${id}`.toLowerCase().includes(query.toLowerCase())
  const visible = values.filter(matches)
  const revoked = savedValues.filter((id) => !values.includes(id))
  return (
    <Panel as="fieldset" className="access-list">
      <legend>{label}</legend>
      <Flex direction="column" gap="2" className="access-list__header">
        <label className="form-field access-list__search" htmlFor={searchId}>
          {`Search ${label.toLowerCase()}`}
          <TextField.Root
            id={searchId}
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon aria-hidden="true" />
            </TextField.Slot>
          </TextField.Root>
        </label>
        <Prose size="2" color="gray" className="access-list__summary">
          {visible.length} matching of {countText(values.length, "draft approval")} ·{" "}
          {savedValues.length} saved · {countText(revoked.length, "pending revocation")}.{" "}
          <a href="#save-status">Review pending changes</a>
        </Prose>
      </Flex>
      {!!values.length && !visible.length && (
        <Prose size="2" className="empty-state">
          No matching access entries.
        </Prose>
      )}
      <Table.Root size="1" className="access-table">
        <VisuallyHidden.Root asChild>
          <caption>{label}</caption>
        </VisuallyHidden.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell scope="col">Chat / ID</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">Approval</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">Action</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {visible.map((id) => (
            <Table.Row key={id}>
              <Table.Cell>
                <Prose weight="medium">
                  {chatName(
                    metadata.get(id) ?? {
                      id,
                      name: "",
                      type: id > 0 ? "private" : "group or channel",
                    },
                  )}
                </Prose>
                <Code size="2" variant="ghost" className="access-id">
                  {id}
                </Code>
              </Table.Cell>
              <Table.Cell>
                {!savedValues.includes(id) ? (
                  <Badge color="orange">Pending approval</Badge>
                ) : (
                  <Badge color="green" variant="soft">
                    Approved
                  </Badge>
                )}
              </Table.Cell>
              <Table.Cell>
                <Button
                  variant="ghost"
                  color="red"
                  aria-label={`Revoke access for ID ${id}`}
                  onClick={() => onChange(values.filter((v) => v !== id))}
                >
                  Revoke access
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
          {revoked.filter(matches).map((id) => (
            <Table.Row key={id} className="access-row--revoked">
              <Table.Cell>
                <Prose weight="medium">
                  {chatName(
                    metadata.get(id) ?? {
                      id,
                      name: "",
                      type: id > 0 ? "private" : "group or channel",
                    },
                  )}
                </Prose>
                <Code size="2" variant="ghost" className="access-id">
                  {id}
                </Code>
              </Table.Cell>
              <Table.Cell>
                <Badge color="orange">Pending revocation</Badge>
              </Table.Cell>
              <Table.Cell>
                <Button variant="soft" onClick={() => onChange([...values, id])}>
                  Undo revocation for {id}
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {!values.length && (
        <Prose size="2" className="empty-state">
          No access approved in the policy draft.
        </Prose>
      )}
      <Flex gap="3" align="end" wrap="wrap" className="access-list__add">
        <Field
          label={positive ? "Private user ID to add" : "Group or channel ID to add"}
          value={draft}
          onChange={(v) => {
            setDraft(v)
            onPending(Boolean(v))
          }}
        />
        <Button
          variant="soft"
          disabled={!draft}
          onClick={() => {
            try {
              const ids = parseIds(draft, positive)
              if (ids.length !== 1) throw new Error("Enter one ID")
              onChange([...new Set([...values, ...ids])])
              setDraft("")
              onPending(false)
              setError("")
            } catch {
              setError(
                positive
                  ? "Enter one positive whole-number Telegram user ID."
                  : "Enter one negative whole-number Telegram group or channel ID.",
              )
            }
          }}
        >
          Add ID to pending settings
        </Button>
      </Flex>
      {draft && (
        <Prose size="2" className="access-list__feedback">
          Not added yet. Add this ID before saving settings.
        </Prose>
      )}
      {error && (
        <Text color="red" role="alert" size="2" className="access-list__feedback">
          {error}
        </Text>
      )}
    </Panel>
  )
}
export function List({
  label,
  options,
  value,
  onChange,
  inheritable = false,
  effective,
}: {
  label: string
  options: string[]
  value: string[] | null
  onChange(value: string[] | null): void
  inheritable?: boolean
  effective?: string[]
}) {
  const displayed = [...new Set([...options, ...(value ?? [])])]
  return (
    <Panel as="fieldset" className="policy-list">
      <legend>{label}</legend>
      {inheritable && (
        <Check
          label="Inherit default"
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
                label={options.includes(name) ? name : `${name} (no longer available)`}
                checked={value.includes(name)}
                onChange={(checked) =>
                  onChange(checked ? [...value, name] : value.filter((v) => v !== name))
                }
              />
            ))
          ) : (
            <Text size="2" color="gray" className="empty-state">
              No approved options.
            </Text>
          ))}
      </Flex>
      {value === null && !inheritable && <Prose size="2">None selected.</Prose>}
      {value?.length === 0 && (
        <Prose size="2">None allowed. This does not inherit the default.</Prose>
      )}
      {inheritable && (
        <Flex direction="column" align="start" gap="2" className="policy-list__status">
          <Badge color={value === null ? "gray" : "orange"}>
            {value === null ? "Inherited" : "Customized"}
          </Badge>
          <Prose size="2" color="gray">
            Effective: {effective?.join(", ") || "None"}
          </Prose>
        </Flex>
      )}
      {inheritable && value !== null && (
        <Button variant="soft" onClick={() => onChange(null)}>
          Reset {label.toLowerCase()} to default
        </Button>
      )}
    </Panel>
  )
}
export function ModelAvailability({
  value,
  onChange,
}: {
  value: string[]
  onChange(value: string[]): void
}) {
  // Keep removed rows until this saved revision changes, so an unchecked model can be restored.
  const [approved] = useState(value)
  return (
    <List
      label="Globally available models"
      options={[...new Set([...approved, ...value])]}
      value={value}
      onChange={(v) => onChange(v ?? [])}
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
      <Grid gap="4" className="grid settings-grid policy-choice-lists">
        {(defaults
          ? (["models"] as const)
          : (["tools", "servers", "skills", "models"] as const)
        ).map((key) => (
          <List
            key={key}
            label={
              {
                tools: "Authorized tools",
                servers: "Authorized MCP servers",
                skills: "Enabled skills",
                models: "Allowed models",
              }[key]
            }
            options={policy[key] ?? []}
            value={value[key] ?? null}
            onChange={(v) => onChange({ ...value, [key]: v })}
            inheritable={!defaults}
            effective={effective[key]}
          />
        ))}
      </Grid>
      {!defaults && (
        <Flex gap="3" wrap="wrap">
          <Button variant="ghost" onClick={() => navigate("Tool permissions")}>
            Manage global and default tool permissions
          </Button>
          <Button variant="ghost" onClick={() => navigate("Skills")}>
            Manage global and default skills
          </Button>
        </Flex>
      )}
      {value.model && !(value.models ?? policy.defaults.models ?? []).includes(value.model) && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            Model "{value.model}" is not in Allowed models
            {value.models === null ? " inherited from Defaults" : ""}. Add it above
            {value.models === null ? " by editing Defaults or clearing Inherit default" : ""}, or
            change the{" "}
            {defaults ? `default model in ${pageLabel("Model Providers")}` : "chat model override"}.
          </Callout.Text>
        </Callout.Root>
      )}
      {defaults ? (
        <Panel as="fieldset" className="policy-model">
          <legend>Default model</legend>
          <DataList.Root size="2" className="data-list">
            <DataList.Item className="data-row">
              <DataList.Label>Model</DataList.Label>
              <DataList.Value>
                <Code variant="ghost">{policy.defaults.model ?? "Not configured"}</Code>
              </DataList.Value>
            </DataList.Item>
            <DataList.Item className="data-row">
              <DataList.Label>Thinking</DataList.Label>
              <DataList.Value>{policy.defaults.thinking ?? "off"}</DataList.Value>
            </DataList.Item>
          </DataList.Root>
          <Prose size="2" color="gray" className="section-copy">
            Allowed models limit what chats can use. The default model selects one for chats without
            an override.
          </Prose>
          <Button variant="soft" onClick={() => navigate("Model Providers")}>
            Edit default model in {pageLabel("Model Providers")}
          </Button>
        </Panel>
      ) : (
        <Panel as="fieldset" className="policy-model">
          <legend>Model and thinking</legend>
          <Grid gap="3" className="grid settings-grid policy-model__controls">
            <label className="form-field" htmlFor="model-selection">
              Chat model override
              <Select.Root
                value={value.model ?? "inherit"}
                onValueChange={(v) =>
                  onChange({ ...value, model: v === "inherit" ? null : v, thinking: null })
                }
              >
                <Select.Trigger
                  id="model-selection"
                  aria-label="Chat model override"
                  placeholder="Choose model"
                />
                <Select.Content>
                  <Select.Item value="inherit">
                    {defaults ? "Not configured" : "Inherit default"}
                  </Select.Item>
                  {[
                    ...new Set([
                      ...(value.models ?? policy.defaults.models ?? []),
                      ...(value.model ? [value.model] : []),
                    ]),
                  ].map((ref) => (
                    <Select.Item key={ref} value={ref}>
                      {ref}
                      {!(value.models ?? policy.defaults.models ?? []).includes(ref)
                        ? " (not allowed)"
                        : ""}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </label>
            <label className="form-field" htmlFor="thinking-selection">
              Thinking level
              <Select.Root
                value={value.thinking ?? "inherit"}
                onValueChange={(v) =>
                  onChange({
                    ...value,
                    thinking: v === "inherit" ? null : (v as Selection["thinking"]),
                  })
                }
              >
                <Select.Trigger id="thinking-selection" aria-label="Thinking level" />
                <Select.Content>
                  <Select.Item value="inherit">
                    {defaults ? "Off (default)" : "Inherit default"}
                  </Select.Item>
                  {levels.map((level) => (
                    <Select.Item key={level} value={level}>
                      {level}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </label>
          </Grid>
          <Prose size="2" color="gray" className="section-copy">
            {value.model === null ? "Inherited" : "Customized"} model:{" "}
            {effective.model ?? "No allowed model"} ·{" "}
            {value.thinking === null ? "Inherited" : "Customized"} thinking: {effective.thinking}
          </Prose>
          {(value.model !== null || value.thinking !== null) && (
            <Button
              variant="soft"
              onClick={() => onChange({ ...value, model: null, thinking: null })}
            >
              Reset model and thinking to default
            </Button>
          )}
        </Panel>
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
      <legend>MCP secret replacement</legend>
      <Prose size="2">Enter only values to replace in the masked field, not the JSON editor.</Prose>
      <label htmlFor="secret-scope">
        Field map
        <Select.Root value={scope} onValueChange={(v) => setScope(v as "env" | "headers")}>
          <Select.Trigger id="secret-scope" aria-label="Field map" />
          <Select.Content>
            <Select.Item value="env">Environment</Select.Item>
            <Select.Item value="headers">Headers</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      <Field
        label="Secret field name"
        value={name}
        onChange={(v) => {
          setName(v)
          onPending(Boolean(v || value))
        }}
      />
      <Field
        secret
        label="New secret value"
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
        Set pending secret replacement
      </Button>
    </Panel>
  )
}
