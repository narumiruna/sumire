import { effectivePolicy, inherited as inherit } from "@narumitw/sumire-policy"
import { ExitIcon, ReloadIcon } from "@radix-ui/react-icons"
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
import { type AuditEntry, ImportHistory, type ImportReport } from "./activity.js"
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
import { AuditHistory } from "./audit.js"
import { ChatSelector, useChatDirectory } from "./chat-directory.js"
import { type Chat, ChatWorkspace, chatName } from "./chats.js"
import { DurableInspector } from "./durable-inspector.js"
import { McpGuidedEditor, mcpChangePreview, mcpSavePatch } from "./mcp-editor.js"
import { navigationHref, pageLabel, SideNavigation, useNavigation } from "./navigation.js"
import { captureSetupLink, signInWithPasskey } from "./passkey.js"
import { policyChanges } from "./policy-changes.js"
import { Providers } from "./providers.js"
import { EditorSection, SectionSelect as Select } from "./sections.js"
import { defaultPermissionSummary, ToolPermissions } from "./tool-permissions.js"

const accessStorage = tabStorage(window)
const initialAccess = captureAccessLink(window.location, window.history, accessStorage)
const initialSetup = captureSetupLink(window.location, window.history)
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
      <Checkbox
        id={id}
        aria-label={label}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
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
    <fieldset>
      <legend>{label}</legend>
      <Text as="p" size="2">
        Review approvals, then use Apply policy changes. Private and group access are separate.
      </Text>
      <Text as="p" size="2">
        Search all entries in this access list by ID or loaded chat name. Names for chats on other
        pages may not be loaded.
      </Text>
      <Field label={`Search ${label.toLowerCase()}`} value={query} onChange={setQuery} />
      {!!values.length && !visible.length && <Text as="p">No matching access entries.</Text>}
      <Text as="p" size="2">
        {visible.length} matching of {values.length} draft approvals · {savedValues.length} saved ·{" "}
        {revoked.length} pending revocations. <a href="#save-status">Review pending changes</a>
      </Text>
      <table className="access-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Chat / ID</th>
            <th scope="col">Approval</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((id) => (
            <tr key={id}>
              <td>
                <Text as="p" weight="medium">
                  {chatName(
                    metadata.get(id) ?? {
                      id,
                      name: "",
                      type: id > 0 ? "private" : "group or channel",
                    },
                  )}
                </Text>
                <Text size="2">
                  <code>{id}</code>
                </Text>
              </td>
              <td>
                {!savedValues.includes(id) ? (
                  <Badge color="orange">Pending approval</Badge>
                ) : (
                  "Approved"
                )}
              </td>
              <td>
                <Button
                  variant="ghost"
                  color="red"
                  aria-label={`Revoke access for ID ${id}`}
                  onClick={() => onChange(values.filter((v) => v !== id))}
                >
                  Revoke access
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {revoked.filter(matches).map((id) => (
        <Flex key={id} gap="2" align="center" wrap="wrap">
          <Text>
            {chatName(
              metadata.get(id) ?? { id, name: "", type: id > 0 ? "private" : "group or channel" },
            )}{" "}
            · {id}
          </Text>
          <Badge color="orange">Pending revocation</Badge>
          <Button variant="soft" onClick={() => onChange([...values, id])}>
            Undo revocation for {id}
          </Button>
        </Flex>
      ))}
      {!values.length && <Text as="p">No access approved in the policy draft.</Text>}
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
  navigate(page: "Tool permissions" | "Model Providers"): void
}) {
  const model = value.model ?? policy.defaults.model
  const levels = inventory.providers
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.id}`, levels: m.thinking })))
    .find((m) => m.ref === model)?.levels ?? ["off"]
  return (
    <>
      <div className="grid">
        {(defaults ? (["models"] as const) : (["tools", "servers", "models"] as const)).map(
          (key) => (
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
              effective={effective[key]}
            />
          ),
        )}
      </div>
      {!defaults && (
        <Button variant="ghost" onClick={() => navigate("Tool permissions")}>
          Manage global and default tool permissions
        </Button>
      )}
      {value.model && !(value.models ?? policy.defaults.models ?? []).includes(value.model) && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            Model "{value.model}" is not in Allowed models
            {value.models === null ? " inherited from Defaults" : ""}. Add it above
            {value.models === null ? " by editing Defaults or clearing Inherit default" : ""}, or
            change the {defaults ? "default model in Model Providers" : "chat model override"}.
          </Callout.Text>
        </Callout.Root>
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
          <Text as="p" size="2">
            {value.model === null ? "Inherited" : "Customized"} model:{" "}
            {effective.model ?? "No allowed model"} ·{" "}
            {value.thinking === null ? "Inherited" : "Customized"} thinking: {effective.thinking}
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
            <Select.Trigger id="provider-api" aria-label="API" />
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
        This stages policy edits only. Apply policy changes before authentication. This replaces the
        custom model list. Custom model costs are unknown, not verified zero-cost.
      </Text>
    </fieldset>
  )
}
function App() {
  const [session, setSession] = useState<{ csrf: string; actor: string } | null | undefined>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [savedPolicy, setSavedPolicy] = useState<Policy>()
  const [inventory, setInventory] = useState<Inventory>(emptyInventory)
  const { page, setPage, chat, setChat } = useNavigation()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const savedRevision = snapshot?.revision
  useEffect(() => {
    if (savedRevision === undefined) return
    const bar = document.getElementById("save-status")
    if (!bar) return
    const resize = () =>
      document.documentElement.style.setProperty(
        "--save-status-height",
        `${bar.getBoundingClientRect().height + 20}px`,
      )
    const observer = new ResizeObserver(resize)
    observer.observe(bar)
    resize()
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty("--save-status-height")
    }
  }, [savedRevision])
  const [dirty, setDirty] = useState(false)
  const [accessTarget, setAccessTarget] = useState("")
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
  const expireSession = useCallback(() => {
    setSession(null)
    setMcpSecrets({ env: {}, headers: {} })
    setMcpConfig("{}")
    setMcpDirty(false)
    setProviderPending(false)
    setEditorPending({})
    setDirty(false)
    setSnapshot(undefined)
    setSavedPolicy(undefined)
  }, [])
  const expireInspectorSession = useCallback(() => {
    expireSession()
    setError("Administrator session expired. Sign in again.")
  }, [expireSession])
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true)
      setError("")
      try {
        await action()
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) expireSession()
        setError(e instanceof Error ? e.message : "Operation failed")
      } finally {
        setBusy(false)
      }
    },
    [expireSession],
  )
  const load = useCallback(async () => {
    const [s, i, a, reports] = await Promise.all([
      request<Snapshot>("settings"),
      request<Inventory>("inventory"),
      request<AuditEntry[]>("audit?offset=0"),
      request<ImportReport[]>("imports"),
    ])
    setSnapshot(s)
    setSavedPolicy(s.policy)
    setInventory(i)
    setAudit(a)
    setImports(Array.isArray(reports) ? reports : [])
    setDirty(false)
  }, [])
  const directory = useChatDirectory(Boolean(session), chat, expireInspectorSession)
  const { knownChats } = directory
  const refreshChats = directory.refresh
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
      setDirty(policyChanges(savedPolicy ?? policy, policy).length > 0)
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
  const changes = policyChanges(savedPolicy ?? policy, policy)
  let mcpPreview: string[] = []
  let mcpValidation = ""
  try {
    const previous = inventory.mcp.find((m) => m.name === mcpName)
    mcpPreview = mcpChangePreview(mcpSavePatch(mcpConfig, previous, mcpSecrets), previous)
  } catch (error) {
    mcpValidation = error instanceof Error ? error.message : "Invalid configuration"
  }
  return (
    <div className="admin-shell">
      <SideNavigation page={page} chat={chat} actor={session.actor} onNavigate={setPage} />
      <main aria-busy={busy}>
        <header className="workspace-header">
          <Text size="2" color="gray">
            Administration / {pageLabel(page)}
          </Text>
          <Flex gap="2">
            <Button
              variant="soft"
              disabled={busy || dirty || localPending}
              onClick={() => {
                refreshChats()
                void run(load)
              }}
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
                  expireSession()
                })
              }
            >
              <ExitIcon />
              Sign out
            </Button>
          </Flex>
        </header>
        {error && (
          <Callout.Root color="red" role="alert">
            <Callout.Text>
              {error} Review the input and retry. If settings were saved but application failed,
              reload the saved state to check it; discard policy edits only when you no longer need
              them.
            </Callout.Text>
          </Callout.Root>
        )}
        <details className="save-help">
          <summary>How saving works</summary>
          <Text as="p" size="2">
            Apply policy changes saves chat overrides, access lists, defaults, global availability,
            and custom endpoint policy edits across sections. MCP connections, provider model
            selection, and authentication use separate actions. Switching sections keeps drafts.
            Defaults do not grant access.
          </Text>
        </details>
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
        <Flex
          id="save-status"
          role="region"
          className={`save-status ${dirty ? "pending-bar" : "saved-state"}`}
          hidden={
            page === "Durable" &&
            !pending &&
            !busy &&
            snapshot.status === "applied" &&
            snapshot.revision === snapshot.applied
          }
          data-pending={dirty}
          gap="3"
          align="center"
          wrap="wrap"
          aria-label="Save status and pending changes"
        >
          <Badge
            role="status"
            data-saved={snapshot.status === "applied" && snapshot.revision === snapshot.applied}
            color={snapshot.status === "applied" ? "green" : "orange"}
          >
            {busy
              ? "Saving or checking…"
              : snapshot.status === "applied" && snapshot.revision === snapshot.applied
                ? "Saved revision applied."
                : snapshot.status === "failed"
                  ? "Saved, but application failed. Retry application."
                  : "Saved changes are waiting to apply."}
          </Badge>
          <details>
            <summary>Revision details</summary>Saved {snapshot.revision} · Applied{" "}
            {snapshot.applied} · {snapshot.status}
          </details>
          {dirty && (
            <Badge color="orange" role="status">
              {changes.length} pending policy changes
            </Badge>
          )}
          {dirty && (
            <details>
              <summary>Review pending policy changes</summary>
              <ul>
                {changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <Text as="p" size="2">
                Applying saves all policy changes listed here, not MCP connection or authentication
                drafts.
              </Text>
            </details>
          )}
          <Button variant="ghost" onClick={() => setPage("Access")}>
            Policy: {dirty ? `${changes.length} changes` : "No changes"}
          </Button>
          {localPending && (
            <Text size="1" color="gray">
              Unstaged editor input
            </Text>
          )}
          <Button variant="ghost" onClick={() => setPage("MCP connections")}>
            {mcpDirty ? "MCP: Unsaved configuration" : "MCP: No browser edits"}
          </Button>
          <Button variant="ghost" onClick={() => setPage("Model Providers")}>
            {providerPending
              ? "Provider: Unsaved selection or authentication"
              : "Provider: No browser edits"}
          </Button>
          {dirty && (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button disabled={busy || !dirty || localPending}>Apply policy changes</Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content>
                <AlertDialog.Title>Apply configuration changes?</AlertDialog.Title>
                <AlertDialog.Description>
                  Save all pending chat, access, shared default, global availability, and custom
                  endpoint policy changes across sections. MCP connection edits and authentication
                  are separate. Active work will be cancelled. Revoked permissions cannot undo
                  completed external actions.
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
          )}
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
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Discard pending policy edits? Other editor drafts stay unchanged.",
                  )
                ) {
                  setSnapshot({ ...snapshot, policy: savedPolicy ?? policy })
                  setDirty(false)
                }
              }}
            >
              Discard policy changes
            </Button>
          )}
          {localPending && (
            <Text size="2">Save unavailable: finish or clear unstaged editor input.</Text>
          )}
        </Flex>
        <Heading size="6" id="current-section-heading" tabIndex={-1} mb="3">
          {pageLabel(page)}
        </Heading>
        <fieldset disabled={busy} className="editor-panel" aria-label="Configuration editors">
          <EditorSection active={page === "Chats"} aria-label="Chat settings">
            <ChatWorkspace
              directory={directory}
              chat={chat}
              onSelect={setChat}
              policy={policy}
              savedPolicy={savedPolicy ?? policy}
              application={
                snapshot.status === "applied" && snapshot.revision === snapshot.applied
                  ? "Applied"
                  : snapshot.status === "failed"
                    ? "Failed"
                    : "Pending"
              }
              inventory={inventory}
              audit={audit}
              onPolicyChange={update}
              onAudit={() => setPage("Audit")}
              onAccess={() => {
                setAccessTarget(chat)
                setPage("Access")
              }}
              onProviders={() => setPage("Model Providers")}
              onTools={() => setPage("Tool permissions")}
              onDurable={() => setPage("Durable")}
            >
              <Card>
                <Check
                  label="Chat enabled"
                  checked={selected?.enabled !== false}
                  onChange={(enabled) =>
                    update({
                      ...policy,
                      chats: { ...policy.chats, [chat]: { ...inherit, ...selected, enabled } },
                    })
                  }
                />
                <Choices
                  navigate={setPage}
                  value={selected ?? inherit}
                  policy={policy}
                  effective={effectivePolicy(policy, Number(chat))}
                  inventory={inventory}
                  onChange={(value) =>
                    update({
                      ...policy,
                      chats: {
                        ...policy.chats,
                        [chat]: { ...value, enabled: selected?.enabled ?? true },
                      },
                    })
                  }
                />
              </Card>
            </ChatWorkspace>
          </EditorSection>
          {page === "Durable" && (
            <>
              <section className="durable-chat-selector" aria-label="Find a chat">
                <details open={!chat}>
                  <summary>Find or switch chat</summary>
                  <ChatSelector directory={directory} chat={chat} onSelect={setChat} />
                </details>
              </section>
              <DurableInspector
                key={chat}
                chat={chat}
                metadata={directory.selected.chat}
                metadataLoading={directory.selected.loading}
                metadataError={directory.selected.error}
                onMetadataRetry={directory.refresh}
                onChats={() => setPage("Chats")}
                onSessionExpired={expireInspectorSession}
              />
            </>
          )}
          <EditorSection active={page === "Access"} aria-label="Access settings">
            {accessTarget && (
              <Card>
                <Heading size="3">Access for chat {accessTarget}</Heading>
                <Text as="p">
                  Review its access entry below. If approval is missing, add this ID to the
                  appropriate list. Approval requires Apply policy changes.
                </Text>
                <Button variant="soft" onClick={() => setPage("Chats")}>
                  Back to chat details
                </Button>
                <Button variant="ghost" onClick={() => setAccessTarget("")}>
                  Show all access entries
                </Button>
              </Card>
            )}
            <Text as="p">
              {policy.privateUsers.length} private users · {policy.groups.length} groups or channels
              approved in the policy draft. Changes remain pending until Apply policy changes.
            </Text>
            <Text as="p">
              Private-message approval does not grant access in any group. Import history never
              grants access or reverses a revocation.
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
              chats={knownChats}
              savedValues={savedPolicy?.privateUsers ?? policy.privateUsers}
              target={accessTarget}
              positive
              onChange={(values) => update({ ...policy, privateUsers: values })}
            />
            <IdList
              key={`${snapshot.revision}:groups`}
              onPending={(v) => markPending("groups", v)}
              label="Group and channel access"
              values={policy.groups}
              chats={knownChats}
              savedValues={savedPolicy?.groups ?? policy.groups}
              target={accessTarget}
              positive={false}
              onChange={(values) => update({ ...policy, groups: values })}
            />
          </EditorSection>
          <EditorSection active={page === "Defaults"} aria-label="Shared defaults">
            <Text as="p">
              Review shared defaults below. Chat overrides take priority within global availability;
              defaults do not approve access.
            </Text>
            <Text as="p" size="2">
              Reset is unavailable when all chats already inherit defaults. During a save,
              configuration controls are unavailable.
            </Text>
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button
                  variant="soft"
                  disabled={
                    !Object.values(policy.chats).some((choice) =>
                      Object.keys(inherit).some((key) => choice[key as keyof Selection] !== null),
                    )
                  }
                >
                  Reset all chats to inherit defaults
                </Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content>
                <AlertDialog.Title>Reset all chat overrides to inherit defaults?</AlertDialog.Title>
                <AlertDialog.Description>
                  {
                    Object.values(policy.chats).filter((choice) =>
                      Object.keys(inherit).some((key) => choice[key as keyof Selection] !== null),
                    ).length
                  }{" "}
                  chats have explicit overrides in the policy draft. Clear tool, MCP server, allowed
                  model, model, and thinking overrides for all chats, including chats outside the
                  current page. Explicit empty lists will also inherit Defaults. Chat access and
                  enabled switches stay unchanged. Future chats already inherit Defaults. This
                  stages edits only; use Apply policy changes to apply them.
                </AlertDialog.Description>
                <Flex gap="3" mt="4">
                  <AlertDialog.Cancel>
                    <Button variant="soft">Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action>
                    <Button
                      onClick={() =>
                        update({
                          ...policy,
                          chats: Object.fromEntries(
                            Object.entries(policy.chats).map(([id, choice]) => [
                              id,
                              { ...inherit, enabled: choice.enabled },
                            ]),
                          ),
                        })
                      }
                    >
                      Stage reset of all chat overrides
                    </Button>
                  </AlertDialog.Action>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
            <Card>
              <Heading size="3">Default tool permissions</Heading>
              <Text as="p">
                Applies to chats without a tool or MCP-server permission override. Explicit
                overrides are not changed.
              </Text>
              <Text as="p">Saved defaults: {defaultPermissionSummary(savedPolicy ?? policy)}.</Text>
              {dirty && (
                <Text as="p">Policy draft defaults: {defaultPermissionSummary(policy)}.</Text>
              )}
              <Button variant="soft" asChild>
                <a
                  href={navigationHref(
                    "Tool permissions",
                    chat,
                    new URL("#default-tool-permissions", window.location.href),
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
                    setPage("Tool permissions", "default-tool-permissions")
                  }}
                >
                  Manage default tool permissions
                </a>
              </Button>
            </Card>
            <Text as="p" size="2">
              Saved model: {savedPolicy?.defaults.model ?? "Not configured"} · Thinking:{" "}
              {savedPolicy?.defaults.thinking ?? "off"} · Allowed models:{" "}
              {savedPolicy?.defaults.models?.join(", ") || "None"}
            </Text>
            <Text as="p" size="2">
              Policy draft model: {policy.defaults.model ?? "Not configured"} · Thinking:{" "}
              {policy.defaults.thinking ?? "off"} · Allowed models:{" "}
              {policy.defaults.models?.join(", ") || "None"}
            </Text>
            <Choices
              navigate={setPage}
              defaults
              value={policy.defaults}
              policy={policy}
              effective={effectivePolicy(policy, 0)}
              inventory={inventory}
              onChange={(v) => update({ ...policy, defaults: v })}
            />
          </EditorSection>
          <EditorSection active={page === "Tool permissions"} aria-label="Tool permissions">
            <Callout.Root color="orange">
              <Callout.Text>
                Shell and file tools are trusted capabilities, not a sandbox. They can access
                process-readable credentials. New tools are enabled in global and default
                permissions when first registered or discovered. Explicit chat overrides and MCP
                server gates still apply.
              </Callout.Text>
            </Callout.Root>
            <ToolPermissions
              key={session.actor}
              actor={session.actor}
              dirty={dirty}
              policy={policy}
              saved={savedPolicy ?? policy}
              inventory={inventory}
              onChange={update}
              onChat={(id) => {
                setChat(id)
                setPage("Chats")
              }}
              defaultContext={
                page === "Tool permissions" && window.location.hash === "#default-tool-permissions"
              }
            />
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
            <Text as="p" size="2">
              Enter an exact tool name even if discovery is unavailable. This stages global approval
              only; default and chat permissions remain unchanged.
            </Text>
            <Button variant="soft" onClick={() => setPage("MCP connections")}>
              Manage MCP connections
            </Button>
          </EditorSection>
          <EditorSection active={page === "MCP connections"} aria-label="MCP connections">
            <Heading size="3" mt="4">
              MCP connections — saved separately
            </Heading>
            <Text as="p">
              Connection configuration and enabled state do not grant execution permission. First
              discovery adds new tools to global and default permissions, but does not open server
              gates. Connection tests run only when requested.
            </Text>
            <Button variant="soft" onClick={() => setPage("Tool permissions")}>
              Manage tool and MCP server permissions
            </Button>
            {!inventory.mcp.length && (
              <Text as="p">
                No MCP connections configured. Add a server below, then test it and approve its
                tools separately.
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
                  {policy.servers.includes(m.name)
                    ? "Globally available"
                    : "Not globally available"}{" "}
                  · {m.tools.filter((name) => policy.tools.includes(name)).length} globally approved
                  tool names · {dirty ? "Policy draft" : "Saved policy"}
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
                    document.getElementById("mcp-guided")?.focus()
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
                      default, and chat selections first. Application cancels active work and
                      retains transcripts.
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
              Use Edit fields for an existing server, then select only the fields to replace. Saved
              values stay hidden. Reload retains this draft; a failed request can still have saved
              changes.
            </Text>
            <McpGuidedEditor
              text={mcpConfig}
              onChange={(text) => {
                setMcpConfig(text)
                setMcpDirty(true)
              }}
            />
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
            <details>
              <summary>Secret preservation and transport rules</summary>
              <Text as="p">
                Omit env or headers to preserve that map. A map in JSON replaces the whole map:
                include every key to retain with null. Omitted keys are removed. An empty object
                clears the map. Masked replacements preserve existing keys when JSON omits that map.
                Do not put secrets in commands, arguments, descriptions, or URLs. Selecting an HTTP
                URL removes command, arguments, working directory, and environment fields. Selecting
                a stdio command removes URL and header fields. For a command-only update, an omitted
                transport type is cleared and inferred again.
              </Text>
            </details>
            <section aria-label="MCP change preview">
              <Heading size="3">Review before saving MCP</Heading>
              <Text as="p" size="2">
                Field operations only; values are hidden. Transport changes remove fields that do
                not apply. The server validates this update before saving.
              </Text>
              {mcpValidation ? (
                <Text as="p" role="alert">
                  {mcpValidation}
                </Text>
              ) : (
                <ul>
                  {mcpPreview.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </section>
            {(dirty || localPending || !mcpName) && (
              <Text as="p" size="2">
                MCP save unavailable:{" "}
                {dirty
                  ? "save or discard policy edits first."
                  : localPending
                    ? "finish or clear unstaged input first."
                    : "enter a server name."}
              </Text>
            )}
            <Button
              disabled={busy || dirty || localPending || !mcpName || Boolean(mcpValidation)}
              onClick={() =>
                void run(async () => {
                  await request(
                    `mcp/${encodeURIComponent(mcpName)}`,
                    session.csrf,
                    {
                      revision: snapshot.revision,
                      config: (() => {
                        return mcpSavePatch(
                          mcpConfig,
                          inventory.mcp.find((m) => m.name === mcpName),
                          mcpSecrets,
                        )
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
          </EditorSection>
          <EditorSection active={page === "Model Providers"}>
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
                Use this only for a compatible endpoint that is not in the provider catalog. Save
                its configuration above before authentication. Costs are unknown, not verified
                zero-cost.
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
          </EditorSection>
          <EditorSection active={page === "Audit"} aria-label="Audit history">
            <Text as="p">
              Latest configuration operations. Secret values and conversation contents are excluded.
            </Text>
            <Heading size="3">Import reports</Heading>
            <ImportHistory reports={imports} />
            <Heading size="3">Configuration activity</Heading>
            <AuditHistory revision={snapshot.revision} run={run} />
          </EditorSection>
        </fieldset>
        {localPending && (
          <Text as="p" role="status">
            An editor has unfinished input. Add, stage, or clear it before saving settings. It is
            not included in policy changes yet.
          </Text>
        )}
        <VisuallyHidden.Root>
          <span role="status">
            {busy
              ? "Operation in progress"
              : error
                ? "Operation failed. Review the error and retry."
                : pending
                  ? "Pending changes. Submit each editor separately."
                  : "No pending browser edits."}
          </span>
        </VisuallyHidden.Root>
      </main>
    </div>
  )
}
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <Theme accentColor="teal" grayColor="slate" radius="medium">
      <App />
    </Theme>,
  )
