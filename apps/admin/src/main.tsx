import { ExitIcon, GearIcon, ReloadIcon } from "@radix-ui/react-icons"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Flex,
  Heading,
  Select,
  Text,
  TextArea,
  TextField,
  Theme,
} from "@radix-ui/themes"
import { useCallback, useEffect, useId, useState } from "react"
import { createRoot } from "react-dom/client"
import "@radix-ui/themes/styles.css"
import "./styles.css"
import { AccessApproval } from "./access.js"
import { captureAccessLink, clearAccessLink, tabStorage } from "./access-link.js"
import { Activity, type AuditEntry, ImportHistory, type ImportReport } from "./activity.js"
import {
  ApiError,
  type Inventory,
  type Policy,
  type ProviderSettings,
  parseIds,
  request,
  type Selection,
  type Snapshot,
} from "./api.js"
import { captureSetupLink, signInWithPasskey } from "./passkey.js"
import { Providers, SearchChoice } from "./providers.js"

const accessStorage = tabStorage(window)
const initialAccess = captureAccessLink(window.location, window.history, accessStorage)
const initialSetup = captureSetupLink(window.location, window.history)
const inherit: Selection = { tools: null, servers: null, models: null, model: null, thinking: null }
const pages = ["Chats", "Access", "Defaults", "Tools / MCP", "Model Providers", "Audit"] as const
const emptyInventory: Inventory = { tools: [], providers: [], mcp: [] }
function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(value: boolean): void
}) {
  const id = useId()
  return (
    <label className="check" htmlFor={id}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  )
}
function Field({
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
    <label htmlFor={id}>
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
function IdList({
  label,
  values,
  chats,
  positive,
  onChange,
  onPending,
}: {
  label: string
  values: number[]
  chats: { id: number; name: string }[]
  positive: boolean
  onChange(values: number[]): void
  onPending(value: boolean): void
}) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const names = new Map(chats.map((chat) => [chat.id, chat.name]))
  return (
    <fieldset>
      <legend>{label}</legend>
      <ul className="id-list">
        {values.map((id) => (
          <li key={id}>
            <code>{id}</code>
            {names.get(id) && names.get(id) !== String(id) && <Text>{names.get(id)}</Text>}
            <Button
              variant="ghost"
              color="red"
              aria-label={`Remove ID ${id}`}
              onClick={() => onChange(values.filter((v) => v !== id))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {!values.length && <Text as="p">No access approved.</Text>}
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
      {draft && (
        <Text as="p" size="2">
          Not added yet. Add this ID before saving settings.
        </Text>
      )}
      {error && (
        <Text color="red" role="alert">
          {error}
        </Text>
      )}
    </fieldset>
  )
}
function List({
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
    <fieldset>
      <legend>{label}</legend>
      {inheritable && (
        <Check
          label="Inherit default"
          checked={value === null}
          onChange={(v) => onChange(v ? null : [])}
        />
      )}
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
          <Text>No approved options.</Text>
        ))}
      {value === null && !inheritable && (
        <Text as="p" size="2">
          None selected.
        </Text>
      )}
      {value?.length === 0 && (
        <Text as="p" size="2">
          None allowed. This does not inherit the default.
        </Text>
      )}
      {inheritable && (
        <Text as="p" size="2">
          {value === null ? "Inherited" : "Customized"} · Effective:{" "}
          {effective?.join(", ") || "None"}
        </Text>
      )}
      {inheritable && value !== null && (
        <Button variant="soft" onClick={() => onChange(null)}>
          Reset {label.toLowerCase()} to default
        </Button>
      )}
    </fieldset>
  )
}
function ModelAvailability({
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
function Choices({
  value,
  policy,
  inventory,
  onChange,
  defaults = false,
  navigate,
}: {
  value: Selection
  policy: Policy
  inventory: Inventory
  onChange(value: Selection): void
  defaults?: boolean
  navigate(page: "Tools / MCP" | "Model Providers"): void
}) {
  const model = value.model ?? policy.defaults.model
  const levels = inventory.providers
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.id}`, levels: m.thinking })))
    .find((m) => m.ref === model)?.levels ?? ["off"]
  return (
    <>
      <div className="grid">
        {(["tools", "servers", "models"] as const).map((key) => (
          <List
            key={key}
            label={
              {
                tools: "Authorized tools",
                servers: "Authorized MCP servers",
                models: "Allowed models",
              }[key]
            }
            options={policy[key]}
            value={value[key]}
            onChange={(v) => onChange({ ...value, [key]: v })}
            inheritable={!defaults}
            effective={(value[key] ?? policy.defaults[key] ?? []).filter(
              (name) =>
                policy[key].includes(name) &&
                (key !== "models" ||
                  policy.providers.find((p) => p.id === name.split("/")[0])?.enabled !== false),
            )}
          />
        ))}
      </div>
      {(!policy.tools.length || !policy.servers.length) && (
        <Button variant="ghost" onClick={() => navigate("Tools / MCP")}>
          Configure tools and MCP servers
        </Button>
      )}
      {defaults ? (
        <Card>
          <Heading size="3">Default model</Heading>
          <Text as="p">
            {policy.defaults.model ?? "Not configured"} · Thinking:{" "}
            {policy.defaults.thinking ?? "off"}
          </Text>
          <Text as="p" size="2">
            Allowed models limit what chats can use. The default model selects one for chats without
            an override.
          </Text>
          <Button variant="soft" onClick={() => navigate("Model Providers")}>
            Edit default model in Model Providers
          </Button>
        </Card>
      ) : (
        <>
          <label htmlFor="model-selection">
            Chat model override
            <Select.Root
              value={value.model ?? "inherit"}
              onValueChange={(v) =>
                onChange({ ...value, model: v === "inherit" ? null : v, thinking: null })
              }
            >
              <Select.Trigger id="model-selection" placeholder="Choose model" />
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
          <label htmlFor="thinking-selection">
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
              <Select.Trigger id="thinking-selection" />
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
          <Text as="p" size="2">
            {value.model === null ? "Inherited" : "Customized"} model:{" "}
            {(value.models ?? policy.defaults.models ?? []).includes(model ?? "") &&
            policy.models.includes(model ?? "") &&
            policy.providers.find((p) => p.id === model?.split("/")[0])?.enabled !== false
              ? model
              : "No allowed model"}{" "}
            · {value.thinking === null ? "Inherited" : "Customized"} thinking:{" "}
            {value.thinking ?? policy.defaults.thinking ?? "off"}
          </Text>
          {(value.model !== null || value.thinking !== null) && (
            <Button
              variant="soft"
              onClick={() => onChange({ ...value, model: null, thinking: null })}
            >
              Reset model and thinking to default
            </Button>
          )}
        </>
      )}
    </>
  )
}
function SecretFields({
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
    <fieldset>
      <legend>MCP secret replacement</legend>
      <Text as="p" size="2">
        Stage a replacement here, then save the MCP connection separately.
      </Text>
      <label htmlFor="secret-scope">
        Field map
        <Select.Root value={scope} onValueChange={(v) => setScope(v as "env" | "headers")}>
          <Select.Trigger id="secret-scope" />
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
    </fieldset>
  )
}
function ProviderEditor({
  onAdd,
  initial,
  onPending,
  onDiscard,
}: {
  onDiscard(): void
  onPending(value: boolean): void
  onAdd(provider: ProviderSettings): void
  initial?: ProviderSettings
}) {
  const [id, setId] = useState(initial?.id ?? "")
  const [url, setUrl] = useState(initial?.baseUrl ?? "")
  const [api, setApi] = useState<ProviderSettings["api"]>(initial?.api ?? "openai-completions")
  const [models, setModels] = useState<ProviderSettings["models"]>(initial?.models ?? [])
  const [model, setModel] = useState("")
  const [name, setName] = useState("")
  const [reasoning, setReasoning] = useState(false)
  const [image, setImage] = useState(false)
  const [context, setContext] = useState("128000")
  const [output, setOutput] = useState("8192")
  const workingModels = () =>
    model
      ? [
          ...models.filter((m) => m.id !== model),
          {
            id: model,
            name: name || model,
            reasoning,
            image,
            contextWindow: Number(context),
            maxTokens: Number(output),
          },
        ]
      : models
  return (
    <fieldset onChangeCapture={() => onPending(true)}>
      <legend>{initial ? "Edit provider configuration" : "Add provider configuration"}</legend>
      <Field label="Provider ID" value={id} onChange={setId} />
      <Field label="API base URL" value={url} onChange={setUrl} />
      <details className="provider-advanced">
        <summary>Advanced protocol</summary>
        <label htmlFor="provider-api">
          API
          <Select.Root
            value={api}
            onValueChange={(v) => {
              onPending(true)
              setApi(v as ProviderSettings["api"])
            }}
          >
            <Select.Trigger id="provider-api" />
            <Select.Content>
              {[
                "openai-completions",
                "openai-responses",
                "anthropic-messages",
                "google-generative-ai",
              ].map((v) => (
                <Select.Item key={v} value={v}>
                  {v}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
      </details>
      {models.map((m) => (
        <Card key={m.id}>
          <Text>
            {m.name} · {m.id} · context {m.contextWindow}
          </Text>
          <Flex gap="2">
            <Button
              variant="soft"
              onClick={() => {
                setModel(m.id)
                setName(m.name)
                setReasoning(m.reasoning)
                setImage(m.image)
                setContext(String(m.contextWindow))
                setOutput(String(m.maxTokens))
              }}
            >
              Edit model {m.id}
            </Button>
            <Button
              variant="soft"
              color="red"
              onClick={() => {
                onPending(true)
                setModels(models.filter((row) => row.id !== m.id))
                if (model === m.id) {
                  setModel("")
                  setName("")
                }
              }}
            >
              Remove model {m.id}
            </Button>
          </Flex>
        </Card>
      ))}
      <Field label="Model ID (required for custom endpoint)" value={model} onChange={setModel} />
      <details className="provider-advanced">
        <summary>Advanced model metadata</summary>
        <Field label="Model display name" value={name} onChange={setName} />
        <Check
          label="Reasoning supported"
          checked={reasoning}
          onChange={(v) => {
            onPending(true)
            setReasoning(v)
          }}
        />
        <Check
          label="Image input supported"
          checked={image}
          onChange={(v) => {
            onPending(true)
            setImage(v)
          }}
        />
        <Field label="Context window tokens" value={context} onChange={setContext} />
        <Field label="Maximum output tokens" value={output} onChange={setOutput} />
      </details>
      <Flex gap="2" wrap="wrap">
        <Button
          variant="soft"
          disabled={!model}
          onClick={() => {
            onPending(true)
            setModels(workingModels())
            setModel("")
            setName("")
          }}
        >
          Add / update model
        </Button>
        <Button
          disabled={!id}
          onClick={() =>
            onAdd({
              id,
              enabled: initial?.enabled ?? true,
              ...(url ? { baseUrl: url, api } : {}),
              models: workingModels(),
            })
          }
        >
          Set provider configuration
        </Button>
        <Button variant="soft" onClick={onDiscard}>
          Discard custom endpoint draft
        </Button>
      </Flex>
      <Text as="p" size="2">
        This stages policy edits only. Use Save settings before authentication. This replaces the
        custom model list. Custom model costs are unknown, not verified zero-cost.
      </Text>
    </fieldset>
  )
}
function App() {
  const [session, setSession] = useState<{ csrf: string; actor: string } | null | undefined>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [inventory, setInventory] = useState<Inventory>(emptyInventory)
  const [page, setPage] = useState<(typeof pages)[number]>("Chats")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [chats, setChats] = useState<
    { id: number; name: string; type: string; effective: unknown }[]
  >([])
  const [chat, setChat] = useState("")
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [imports, setImports] = useState<ImportReport[]>([])
  const [mcpDirty, setMcpDirty] = useState(false)
  const [mcpEditorVersion, setMcpEditorVersion] = useState(0)
  const [providerPending, setProviderPending] = useState(false)
  const [editorPending, setEditorPending] = useState<Record<string, boolean>>({})
  const localPending = Object.values(editorPending).some(Boolean)
  const markPending = (key: string, value: boolean) =>
    setEditorPending((previous) => ({ ...previous, [key]: value }))
  const pending = dirty || mcpDirty || providerPending || localPending
  const confirmDiscard = () => !pending || window.confirm("Discard pending changes and leave?")
  const [auditOffset, setAuditOffset] = useState(0)
  const [chatOffset, setChatOffset] = useState(0)
  const [editingProvider, setEditingProvider] = useState<ProviderSettings>()
  const [endpointEditorVersion, setEndpointEditorVersion] = useState(0)
  const [toolName, setToolName] = useState("")
  const [setup, setSetup] = useState(initialSetup)
  const [accessToken, setAccessToken] = useState(initialAccess)
  const clearAccess = useCallback(() => {
    clearAccessLink(accessStorage)
    setAccessToken("")
  }, [])
  const [mcpName, setMcpName] = useState("")
  const [mcpSecrets, setMcpSecrets] = useState<{
    env: Record<string, string>
    headers: Record<string, string>
  }>({ env: {}, headers: {} })
  const [mcpConfig, setMcpConfig] = useState(
    '{\n  "command": "",\n  "args": [],\n  "enabled": true,\n  "exposure": "codemode"\n}',
  )
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSession(null)
        setMcpSecrets({ env: {}, headers: {} })
        setMcpConfig("{}")
        setMcpDirty(false)
        setProviderPending(false)
        setEditorPending({})
        setDirty(false)
        setSnapshot(undefined)
      }
      setError(e instanceof Error ? e.message : "Operation failed")
    } finally {
      setBusy(false)
    }
  }, [])
  const load = useCallback(async () => {
    const [s, i, c, a, reports] = await Promise.all([
      request<Snapshot>("settings"),
      request<Inventory>("inventory"),
      request<typeof chats>(`chats?offset=${chatOffset}`),
      request<AuditEntry[]>(`audit?offset=${auditOffset}`),
      request<ImportReport[]>("imports"),
    ])
    setSnapshot(s)
    setInventory(i)
    setChats(c)
    setAudit(a)
    setImports(Array.isArray(reports) ? reports : [])
    setDirty(false)
  }, [chatOffset, auditOffset])
  useEffect(() => {
    const capture = () => {
      const params = new URLSearchParams(window.location.hash.slice(1))
      if (params.has("allow")) {
        setAccessToken(captureAccessLink(window.location, window.history, accessStorage))
        setSetup("")
      } else if (params.has("setup")) {
        setSetup(captureSetupLink(window.location, window.history))
      }
    }
    window.addEventListener("hashchange", capture)
    return () => window.removeEventListener("hashchange", capture)
  }, [])
  useEffect(() => {
    void request<{ csrf: string; actor: string }>("session").then(setSession, (e) => {
      setSession(null)
      if (!(e instanceof ApiError && e.status === 401))
        setError("Could not load administrator session")
    })
  }, [])
  useEffect(() => {
    if (session) void run(load)
  }, [session, run, load])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [pending])
  const update = (policy: Policy) => {
    if (snapshot) {
      setSnapshot({ ...snapshot, policy })
      setDirty(true)
    }
  }
  if (session === undefined)
    return (
      <main>
        <Text>Loading administrator session…</Text>
      </main>
    )
  if (!session)
    return (
      <main>
        <Card>
          <Heading>Sumire administration</Heading>
          <Text as="p">
            {setup
              ? "Register your administrator passkey with your device."
              : "Use your administrator passkey to sign in."}
          </Text>
          {!setup && (
            <Text as="p">
              First visit? Send /admin in a private chat with Sumire to get a setup link.
            </Text>
          )}
          {error && (
            <Text role="alert" color="red">
              {error}
            </Text>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await signInWithPasskey(setup)
                setSetup("")
                setSession(next)
              })
            }
          >
            {setup ? "Register passkey" : "Sign in with passkey"}
          </Button>
        </Card>
      </main>
    )
  if (!snapshot)
    return (
      <main>
        <Text>{error || "Loading settings…"}</Text>
        <Button onClick={() => void run(load)}>Retry</Button>
      </main>
    )
  const policy = snapshot.policy
  const selected = policy.chats[chat]
  return (
    <main aria-busy={busy}>
      <Flex justify="between" align="center" wrap="wrap" gap="3">
        <Heading>
          <GearIcon aria-hidden /> Sumire
        </Heading>
        <Flex gap="2">
          <Button
            variant="soft"
            disabled={busy || dirty || localPending}
            onClick={() => void run(load)}
          >
            <ReloadIcon />
            Reload
          </Button>
          <Button
            variant="soft"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!confirmDiscard()) return
                clearAccess()
                await request("logout", session.csrf)
                setMcpSecrets({ env: {}, headers: {} })
                setMcpConfig("{}")
                setMcpDirty(false)
                setProviderPending(false)
                setEditorPending({})
                setDirty(false)
                setSnapshot(undefined)
                setSession(null)
              })
            }
          >
            <ExitIcon />
            Sign out
          </Button>
        </Flex>
      </Flex>
      <Text size="2">Administrator {session.actor}</Text>
      <nav aria-label="Administration sections">
        {pages.map((p) => (
          <Button
            key={p}
            aria-current={page === p ? "page" : undefined}
            variant={page === p ? "solid" : "soft"}
            onClick={() => setPage(p)}
          >
            {p}
          </Button>
        ))}
      </nav>
      {error && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            {error} Review the input and retry. If settings were saved but application failed,
            reload the saved state to check it; discard policy edits only when you no longer need
            them.
          </Callout.Text>
        </Callout.Root>
      )}
      <Flex gap="3" align="center" wrap="wrap">
        <Badge role="status" color={snapshot.status === "applied" ? "green" : "orange"}>
          {busy
            ? "Saving or checking…"
            : snapshot.status === "applied" && snapshot.revision === snapshot.applied
              ? "All changes applied."
              : snapshot.status === "failed"
                ? "Saved, but application failed. Retry application."
                : "Saved changes are waiting to apply."}
        </Badge>
        <details>
          <summary>Revision details</summary>Saved {snapshot.revision} · Applied {snapshot.applied}{" "}
          · {snapshot.status}
        </details>
        {dirty && <Badge color="orange">Unsaved changes</Badge>}
        {mcpDirty && <Badge color="orange">Pending MCP configuration</Badge>}
        {providerPending && (
          <Badge color="orange">Pending provider selection or authentication</Badge>
        )}
        <AlertDialog.Root>
          <AlertDialog.Trigger>
            <Button disabled={busy || !dirty || localPending}>Save settings</Button>
          </AlertDialog.Trigger>
          <AlertDialog.Content>
            <AlertDialog.Title>Apply configuration changes?</AlertDialog.Title>
            <AlertDialog.Description>
              Save all pending chat, access, shared default, global availability, and custom
              endpoint policy changes across sections. MCP connection edits and authentication are
              separate. Active work will be cancelled. Revoked permissions cannot undo completed
              external actions.
            </AlertDialog.Description>
            <Flex gap="3" mt="4">
              <AlertDialog.Cancel>
                <Button variant="soft">Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button
                  onClick={() =>
                    void run(async () => {
                      await request(
                        "settings",
                        session.csrf,
                        { revision: snapshot.revision, policy },
                        "PUT",
                      )
                      await load()
                    })
                  }
                >
                  Save and apply
                </Button>
              </AlertDialog.Action>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>
        {snapshot.status !== "applied" && (
          <Button
            disabled={busy || dirty || localPending}
            onClick={() =>
              void run(async () => {
                await request("apply", session.csrf)
                await load()
              })
            }
          >
            Retry application
          </Button>
        )}
        {dirty && (
          <Button
            variant="soft"
            disabled={busy || localPending}
            onClick={() => {
              if (
                window.confirm("Discard pending policy edits? Other editor drafts stay unchanged.")
              )
                void run(load)
            }}
          >
            Discard edits and reload
          </Button>
        )}
      </Flex>
      {localPending && (
        <Text as="p" role="status">
          An editor has unfinished input. Add, stage, or clear it before saving settings. It is not
          included in policy changes yet.
        </Text>
      )}
      <Text as="p" size="2">
        Save settings submits policy edits from all sections. MCP connections, model selection, and
        authentication use separate actions. Switching sections keeps drafts.
      </Text>
      <Text as="p" size="2">
        Global allowed capabilities → shared defaults → chat overrides. Availability limits
        selection; authorization also requires chat access and tool permission. Defaults do not
        grant chat access.
      </Text>
      {accessToken && (
        <AccessApproval
          key={accessToken}
          token={accessToken}
          clear={clearAccess}
          csrf={session.csrf}
          snapshot={snapshot}
          disabled={busy || pending}
          run={run}
          refresh={load}
        />
      )}
      <Heading size="5" mt="5">
        {page}
      </Heading>
      <fieldset disabled={busy} className="editor-panel" aria-label="Configuration editors">
        <section hidden={page !== "Chats"} aria-label="Chat settings">
          <SearchChoice
            label="Known chat"
            value={chat}
            options={chats.map((c) => ({
              id: String(c.id),
              label: c.name && c.name !== String(c.id) ? c.name : `Unnamed ${c.type}`,
              detail: `${c.type} · ${c.id}`,
            }))}
            onChange={setChat}
          />
          <Text as="p" size="2">
            Search covers this page of observed chats. Use Next chats for more.
          </Text>
          {!chat && (
            <Text as="p">
              Select a chat to review inherited settings and set overrides. Access approval remains
              separate.
            </Text>
          )}
          <Flex gap="2">
            <Button
              variant="soft"
              disabled={busy || chatOffset === 0 || pending}
              onClick={() => setChatOffset(Math.max(0, chatOffset - 100))}
            >
              Previous chats
            </Button>
            <Button
              variant="soft"
              disabled={busy || chats.length < 100 || pending}
              onClick={() => setChatOffset(chatOffset + 100)}
            >
              Next chats
            </Button>
          </Flex>
          <details>
            <summary>Configure a chat before its first message</summary>
            <Text as="p" size="2">
              Enter its Telegram ID. This creates settings, not access approval.
            </Text>
            <Field
              label="Chat ID (can configure before first message)"
              value={chat}
              onChange={setChat}
            />
          </details>
          {chat && (
            <div>
              <Heading size="4">
                {chats.find((c) => String(c.id) === chat)?.name === chat
                  ? "Unnamed chat"
                  : chats.find((c) => String(c.id) === chat)?.name || "Chat configuration"}
              </Heading>
              <Text as="p" size="2">
                {chats.find((c) => String(c.id) === chat)?.type ?? "Not yet observed"} · {chat}
              </Text>
            </div>
          )}
          {chat && /^-?[1-9]\d*$/.test(chat) && (
            <Card>
              <Check
                label="Chat enabled"
                checked={selected?.enabled !== false}
                onChange={(v) =>
                  update({
                    ...policy,
                    chats: { ...policy.chats, [chat]: { ...inherit, ...selected, enabled: v } },
                  })
                }
              />
              <Choices
                navigate={setPage}
                value={selected ?? inherit}
                policy={policy}
                inventory={inventory}
                onChange={(v) =>
                  update({
                    ...policy,
                    chats: {
                      ...policy.chats,
                      [chat]: { ...v, enabled: selected?.enabled ?? true },
                    },
                  })
                }
              />
              <Text as="p">
                Chat switch: {selected ? "Customized" : "Default"} ·{" "}
                {selected?.enabled === false ? "Disabled" : "Enabled"}. Access in current settings:{" "}
                {(Number(chat) > 0 ? policy.privateUsers : policy.groups).includes(Number(chat))
                  ? "Approved"
                  : "Not approved"}
                . Manage approval on Access. Capability selections do not grant access.
              </Text>
              <details>
                <summary>Saved effective settings (before pending edits)</summary>
                <pre>
                  {JSON.stringify(
                    chats.find((c) => String(c.id) === chat)?.effective ??
                      "Available after saving and reload",
                    null,
                    2,
                  )}
                </pre>
              </details>
            </Card>
          )}
          {!chats.length && (
            <Text>No chats observed. You can configure a Telegram ID directly.</Text>
          )}
        </section>
        <section hidden={page !== "Access"} aria-label="Access settings">
          <Text as="p">
            {policy.privateUsers.length} private users · {policy.groups.length} groups or channels
            approved in current settings. Changes remain pending until Save settings.
          </Text>
          <Text as="p">
            Private-message approval does not grant access in any group. Import history never grants
            access or reverses a revocation.
          </Text>
          <details>
            <summary>Imported IDs and review history</summary>
            <Text as="p">
              Read-only history is available in Audit. Review current access below; no imported ID
              is approved automatically.
            </Text>
            <Button variant="soft" onClick={() => setPage("Audit")}>
              Open import history in Audit
            </Button>
          </details>
          <IdList
            key={`${snapshot.revision}:users`}
            onPending={(v) => markPending("users", v)}
            label="Private-message access"
            values={policy.privateUsers}
            chats={chats}
            positive
            onChange={(values) => update({ ...policy, privateUsers: values })}
          />
          <IdList
            key={`${snapshot.revision}:groups`}
            onPending={(v) => markPending("groups", v)}
            label="Group and channel access"
            values={policy.groups}
            chats={chats}
            positive={false}
            onChange={(values) => update({ ...policy, groups: values })}
          />
        </section>
        <section hidden={page !== "Defaults"} aria-label="Shared defaults">
          <Text as="p">
            Shared defaults apply to chats that have no override. They cannot exceed global
            availability and do not approve access.
          </Text>
          <Choices
            navigate={setPage}
            defaults
            value={policy.defaults}
            policy={policy}
            inventory={inventory}
            onChange={(v) => update({ ...policy, defaults: v })}
          />
        </section>
        <section hidden={page !== "Tools / MCP"} aria-label="Tools and MCP settings">
          <Callout.Root color="orange">
            <Callout.Text>
              Shell and file tools are trusted capabilities, not a sandbox. They can access
              process-readable credentials. New tools are denied until explicitly approved.
            </Callout.Text>
          </Callout.Root>
          <Heading size="3" mt="3">
            Tool authorization — saved with settings
          </Heading>
          <div className="grid">
            <List
              label="Globally available tools"
              options={[...new Set([...inventory.tools, ...policy.tools])]}
              value={policy.tools}
              onChange={(v) => update({ ...policy, tools: v ?? [] })}
            />
            <List
              label="Globally available MCP servers"
              options={inventory.mcp.map((m) => m.name)}
              value={policy.servers}
              onChange={(v) => update({ ...policy, servers: v ?? [] })}
            />
          </div>
          <Text as="p">
            MCP tool names must be approved individually. Exposure does not grant execution
            permission.
          </Text>
          <Field
            label="Additional approved tool name"
            value={toolName}
            onChange={(v) => {
              setToolName(v)
              markPending("tool", Boolean(v))
            }}
          />
          <Button
            disabled={!toolName}
            onClick={() => {
              update({ ...policy, tools: [...new Set([...policy.tools, toolName])] })
              setToolName("")
              markPending("tool", false)
            }}
          >
            Add tool to pending approval
          </Button>
          <Heading size="3" mt="4">
            MCP connections — saved separately
          </Heading>
          {!inventory.mcp.length && (
            <Text as="p">
              No MCP connections configured. Add a server below, then test it and approve its tools
              separately.
            </Text>
          )}
          {inventory.mcp.map((m) => (
            <Card key={m.name}>
              <Text>
                {m.name} · Configured · {m.enabled === false ? "Disabled" : "Enabled"} · Exposure:{" "}
                {m.exposure ?? "codemode"}
              </Text>
              <Text as="p">
                Connection test: {m.connection} · {m.tools.length} discovered tools ·{" "}
                {policy.servers.includes(m.name) ? "Globally available" : "Not globally available"}{" "}
                · {m.tools.filter((name) => policy.tools.includes(name)).length} globally authorized
                tools
              </Text>
              <Text as="p" size="2">
                Connection state is not an execution grant. Defaults and chat selections can
                restrict these tools further.
              </Text>
              <details>
                <summary>Discovered tool names</summary>
                <pre>{m.tools?.join("\n") || "No tools discovered."}</pre>
              </details>
              <Button
                variant="soft"
                disabled={busy || dirty || localPending}
                onClick={() =>
                  void run(async () => {
                    await request(`mcp/${m.name}/discover`, session.csrf)
                    await load()
                  })
                }
              >
                Test and discover {m.name}
              </Button>
              <Button
                variant="soft"
                disabled={busy || dirty || localPending}
                onClick={() => {
                  if (
                    mcpDirty &&
                    !window.confirm("Discard the current MCP draft and edit this server?")
                  )
                    return
                  setMcpName(m.name)
                  setMcpConfig("{}")
                  setMcpSecrets({ env: {}, headers: {} })
                  setMcpDirty(true)
                  document
                    .getElementById("mcp-config")
                    ?.closest("details")
                    ?.setAttribute("open", "")
                  document.getElementById("mcp-config")?.focus()
                }}
              >
                Edit fields for {m.name}
              </Button>
              <AlertDialog.Root>
                <AlertDialog.Trigger>
                  <Button color="red" variant="ghost" disabled={busy || dirty || localPending}>
                    Delete {m.name}
                  </Button>
                </AlertDialog.Trigger>
                <AlertDialog.Content>
                  <AlertDialog.Title>Delete MCP server {m.name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    This deletes its configuration and stored secrets. Remove it from global,
                    default, and chat selections first. Application cancels active work and retains
                    transcripts.
                  </AlertDialog.Description>
                  <Flex gap="3" justify="end" mt="4">
                    <AlertDialog.Cancel>
                      <Button variant="soft">Cancel</Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button
                        color="red"
                        onClick={() =>
                          void run(async () => {
                            await request(
                              `mcp/${encodeURIComponent(m.name)}`,
                              session.csrf,
                              { revision: snapshot.revision },
                              "DELETE",
                            )
                            if (mcpName === m.name) {
                              setMcpName("")
                              setMcpConfig("{}")
                              setMcpSecrets({ env: {}, headers: {} })
                              setMcpDirty(false)
                            }
                            await load()
                          })
                        }
                      >
                        Delete server and apply
                      </Button>
                    </AlertDialog.Action>
                  </Flex>
                </AlertDialog.Content>
              </AlertDialog.Root>
              <Text as="p" size="2">
                Secret fields:{" "}
                {[...Object.keys(m.env), ...Object.keys(m.headers)].join(", ") || "none"}
              </Text>
            </Card>
          ))}
          <Field
            label="MCP server name"
            value={mcpName}
            onChange={(name) => {
              if (
                (Object.keys(mcpSecrets.env).length ||
                  Object.keys(mcpSecrets.headers).length ||
                  editorPending.secret) &&
                !window.confirm(
                  "Changing the server name discards staged secret replacements. Continue?",
                )
              )
                return
              markPending("secret", false)
              setMcpDirty(true)
              setMcpName(name)
              setMcpSecrets({ env: {}, headers: {} })
            }}
          />
          <Text as="p" size="2">
            To update an existing server, use its Edit fields button above to start an empty JSON
            update. Enter only the fields to change. Typing a name keeps the current JSON draft. The
            API does not return editable connection configuration. Reload checks saved settings and
            application status. It keeps this MCP draft and staged secrets. A failed request can
            still have saved its changes.
          </Text>
          <details className="provider-advanced">
            <summary>Advanced server configuration JSON</summary>
            <label htmlFor="mcp-config">
              Server configuration JSON
              <TextArea
                id="mcp-config"
                value={mcpConfig}
                onChange={(e) => {
                  setMcpDirty(true)
                  setMcpConfig(e.target.value)
                }}
                rows={12}
              />
            </label>
          </details>
          <SecretFields
            key={`${mcpName}:${mcpEditorVersion}`}
            onPending={(v) => markPending("secret", v)}
            onChange={({ scope, name, value }) => {
              setMcpDirty(true)
              setMcpSecrets({ ...mcpSecrets, [scope]: { ...mcpSecrets[scope], [name]: value } })
            }}
          />
          <Text as="p">
            Pending secret fields:{" "}
            {[...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(", ") ||
              "none"}
            . Enter new secret values only in the masked field, not the JSON editor.
          </Text>
          <Text as="p">
            Omit env or headers to preserve that map. A map in JSON replaces the whole map: include
            every key to retain with null. Omitted keys are removed. An empty object clears the map.
            Masked replacements preserve existing keys when JSON omits that map. Do not put secrets
            in commands, arguments, descriptions, or URLs.
          </Text>
          <Button
            disabled={busy || dirty || localPending || !mcpName}
            onClick={() =>
              void run(async () => {
                await request(
                  `mcp/${encodeURIComponent(mcpName)}`,
                  session.csrf,
                  {
                    revision: snapshot.revision,
                    config: (() => {
                      const config = JSON.parse(mcpConfig)
                      const previous = inventory.mcp.find((m) => m.name === mcpName)
                      for (const scope of ["env", "headers"] as const) {
                        if (
                          config[scope] &&
                          Object.values(config[scope]).some((value) => value !== null)
                        )
                          throw new Error("Use the masked field for secret replacements")
                        if (Object.keys(mcpSecrets[scope]).length)
                          config[scope] = {
                            ...(config[scope] ?? previous?.[scope] ?? {}),
                            ...mcpSecrets[scope],
                          }
                      }
                      return config
                    })(),
                  },
                  "PUT",
                )
                setMcpConfig("{}")
                setMcpSecrets({ env: {}, headers: {} })
                setMcpDirty(false)
                await load()
              })
            }
          >
            Save MCP configuration and apply
          </Button>
          {(mcpDirty || editorPending.secret) && (
            <Button
              variant="soft"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Discard pending MCP configuration and secrets?")) {
                  setMcpName("")
                  setMcpConfig("{}")
                  setMcpSecrets({ env: {}, headers: {} })
                  setMcpDirty(false)
                  setMcpEditorVersion((version) => version + 1)
                  markPending("secret", false)
                }
              }}
            >
              Discard MCP draft
            </Button>
          )}
        </section>
        <section hidden={page !== "Model Providers"}>
          <Providers
            snapshot={snapshot}
            inventory={inventory}
            csrf={session.csrf}
            dirty={dirty || mcpDirty || localPending}
            busy={busy}
            run={run}
            refresh={load}
            error={error}
            onPending={setProviderPending}
          />
          <details className="provider-advanced">
            <summary>Custom endpoint</summary>
            <Text as="p" size="2">
              Use this only for a compatible endpoint that is not in the provider catalog. Save its
              configuration above before authentication. Costs are unknown, not verified zero-cost.
            </Text>
            {policy.providers.map((p) => (
              <Card key={p.id}>
                <Check
                  label={`${p.id} enabled`}
                  checked={p.enabled}
                  onChange={(v) =>
                    update({
                      ...policy,
                      providers: policy.providers.map((row) =>
                        row.id === p.id ? { ...row, enabled: v } : row,
                      ),
                    })
                  }
                />
                <Flex gap="2" wrap="wrap">
                  <Button
                    variant="soft"
                    onClick={() => {
                      if (
                        !editorPending.endpoint ||
                        window.confirm("Discard unfinished custom endpoint edits?")
                      ) {
                        setEditingProvider(p)
                        markPending("endpoint", false)
                      }
                    }}
                  >
                    Edit configuration {p.id}
                  </Button>
                  <Button
                    variant="soft"
                    color="red"
                    onClick={() =>
                      update({
                        ...policy,
                        providers: policy.providers.filter((row) => row.id !== p.id),
                      })
                    }
                  >
                    Remove configuration
                  </Button>
                </Flex>
              </Card>
            ))}
            <ProviderEditor
              key={`${JSON.stringify(editingProvider) ?? "new"}:${endpointEditorVersion}`}
              initial={editingProvider}
              onDiscard={() => {
                setEndpointEditorVersion((version) => version + 1)
                markPending("endpoint", false)
              }}
              onPending={(v) => markPending("endpoint", v)}
              onAdd={(p) => {
                update({
                  ...policy,
                  providers: [...policy.providers.filter((row) => row.id !== p.id), p],
                })
                setEditingProvider(undefined)
                markPending("endpoint", false)
              }}
            />
          </details>
          <details className="provider-advanced">
            <summary>Manage model availability</summary>
            <Text as="p" size="2">
              Add models with the provider flow above. Remove references from defaults and chats
              before removing a model. Selecting a provider never grants its full catalog.
            </Text>
            <ModelAvailability
              key={snapshot.revision}
              value={policy.models}
              onChange={(models) => update({ ...policy, models })}
            />
          </details>
        </section>
        <section hidden={page !== "Audit"} aria-label="Audit history">
          <Text as="p">
            Latest configuration operations. Secret values and conversation contents are excluded.
          </Text>
          <Heading size="3">Import reports</Heading>
          <ImportHistory reports={imports} />
          <Heading size="3">Configuration activity</Heading>
          <Text as="p" size="2">
            Showing records {audit.length ? auditOffset + 1 : 0}–{auditOffset + audit.length}. Older
            records may be available; the server retains up to 10,000 records.
          </Text>
          <Activity entries={audit} />
          <Flex gap="2">
            <Button
              disabled={busy || auditOffset === 0 || pending}
              onClick={() => setAuditOffset(Math.max(0, auditOffset - 100))}
            >
              Newer
            </Button>
            <Button
              disabled={busy || audit.length < 100 || pending}
              onClick={() => setAuditOffset(auditOffset + 100)}
            >
              Older
            </Button>
          </Flex>
        </section>
      </fieldset>
      <VisuallyHidden.Root>
        <span role="status">
          {busy
            ? "Operation in progress"
            : error
              ? "Operation failed. Review the error and retry."
              : pending
                ? "Pending changes. Submit each editor separately."
                : "Ready"}
        </span>
      </VisuallyHidden.Root>
    </main>
  )
}
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <Theme accentColor="teal" grayColor="slate" radius="medium">
      <App />
    </Theme>,
  )
