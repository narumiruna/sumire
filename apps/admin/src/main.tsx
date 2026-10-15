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
import { Providers } from "./providers.js"

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
  positive,
  onChange,
}: {
  label: string
  values: number[]
  positive: boolean
  onChange(values: number[]): void
}) {
  const [draft, setDraft] = useState(values.join(", "))
  const [error, setError] = useState("")
  return (
    <fieldset>
      <legend>{label}</legend>
      <Field label={label} value={draft} onChange={setDraft} />
      <Button
        variant="soft"
        onClick={() => {
          try {
            onChange(parseIds(draft, positive))
            setError("")
          } catch {
            setError("Enter valid Telegram IDs")
          }
        }}
      >
        Set {positive ? "private users" : "groups"}
      </Button>
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
}: {
  label: string
  options: string[]
  value: string[] | null
  onChange(value: string[] | null): void
  inheritable?: boolean
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
      {value?.length === 0 && <Text size="2">Explicit empty list: none allowed.</Text>}
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
}: {
  value: Selection
  policy: Policy
  inventory: Inventory
  onChange(value: Selection): void
  defaults?: boolean
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
            label={key}
            options={policy[key]}
            value={value[key]}
            onChange={(v) => onChange({ ...value, [key]: v })}
            inheritable={!defaults}
          />
        ))}
      </div>
      <label htmlFor="model-selection">
        Model
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
            {(value.models ?? policy.defaults.models ?? []).map((ref) => (
              <Select.Item key={ref} value={ref}>
                {ref}
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
            onChange({ ...value, thinking: v === "inherit" ? null : (v as Selection["thinking"]) })
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
    </>
  )
}
function SecretFields({
  onChange,
}: {
  onChange(value: { scope: "env" | "headers"; name: string; value: string }): void
}) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [scope, setScope] = useState<"env" | "headers">("env")
  return (
    <fieldset>
      <legend>MCP secret replacement</legend>
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
      <Field label="Secret field name" value={name} onChange={setName} />
      <Field secret label="New secret value" value={value} onChange={setValue} />
      <Button
        variant="soft"
        disabled={!name || !value}
        onClick={() => {
          onChange({ scope, name, value })
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
}: {
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
    <fieldset>
      <legend>{initial ? "Edit provider configuration" : "Add provider configuration"}</legend>
      <Field label="Provider ID" value={id} onChange={setId} />
      <Field label="API base URL" value={url} onChange={setUrl} />
      <details className="provider-advanced">
        <summary>Advanced protocol</summary>
        <label htmlFor="provider-api">
          API
          <Select.Root value={api} onValueChange={(v) => setApi(v as ProviderSettings["api"])}>
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
        <Check label="Reasoning supported" checked={reasoning} onChange={setReasoning} />
        <Check label="Image input supported" checked={image} onChange={setImage} />
        <Field label="Context window tokens" value={context} onChange={setContext} />
        <Field label="Maximum output tokens" value={output} onChange={setOutput} />
      </details>
      <Flex gap="2" wrap="wrap">
        <Button
          variant="soft"
          disabled={!model}
          onClick={() => {
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
      </Flex>
      <Text as="p" size="2">
        Save settings before authentication. This replaces the custom model list. Custom model costs
        are unknown, not verified zero-cost.
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
  const [audit, setAudit] = useState<unknown[]>([])
  const [imports, setImports] = useState<unknown>()
  const [auditOffset, setAuditOffset] = useState(0)
  const [chatOffset, setChatOffset] = useState(0)
  const [editingProvider, setEditingProvider] = useState<ProviderSettings>()
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
      request<unknown[]>(`audit?offset=${auditOffset}`),
      request<unknown>("imports"),
    ])
    setSnapshot(s)
    setInventory(i)
    setChats(c)
    setAudit(a)
    setImports(reports)
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
          <Button variant="soft" disabled={busy || dirty} onClick={() => void run(load)}>
            <ReloadIcon />
            Reload
          </Button>
          <Button
            variant="soft"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                clearAccess()
                await request("logout", session.csrf)
                setMcpSecrets({ env: {}, headers: {} })
                setMcpConfig("{}")
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
          <Button key={p} variant={page === p ? "solid" : "soft"} onClick={() => setPage(p)}>
            {p}
          </Button>
        ))}
      </nav>
      {error && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      <Flex gap="3" align="center" wrap="wrap">
        <Badge color={snapshot.status === "applied" ? "green" : "orange"}>
          Saved {snapshot.revision} · Applied {snapshot.applied} · {snapshot.status}
        </Badge>
        {dirty && <Badge color="orange">Unsaved changes</Badge>}
        <AlertDialog.Root>
          <AlertDialog.Trigger>
            <Button disabled={busy || !dirty}>Save settings</Button>
          </AlertDialog.Trigger>
          <AlertDialog.Content>
            <AlertDialog.Title>Apply configuration changes?</AlertDialog.Title>
            <AlertDialog.Description>
              Active work will be cancelled. Revoked permissions cannot undo completed external
              actions.
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
            disabled={busy || dirty}
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
          <Button variant="soft" onClick={() => void run(load)}>
            Discard edits and reload
          </Button>
        )}
      </Flex>
      {accessToken && (
        <AccessApproval
          key={accessToken}
          token={accessToken}
          clear={clearAccess}
          csrf={session.csrf}
          snapshot={snapshot}
          disabled={busy || dirty}
          run={run}
          refresh={load}
        />
      )}
      <Heading size="5" mt="5">
        {page}
      </Heading>
      {page === "Chats" && (
        <>
          <label htmlFor="known-chat">
            Known chat
            <Select.Root
              value={chat || "none"}
              onValueChange={(v) => setChat(v === "none" ? "" : v)}
            >
              <Select.Trigger id="known-chat" />
              <Select.Content>
                <Select.Item value="none">Choose chat</Select.Item>
                {chats.map((c) => (
                  <Select.Item key={c.id} value={String(c.id)}>
                    {c.name} · {c.type} · {c.id}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </label>
          <Flex gap="2">
            <Button
              variant="soft"
              disabled={chatOffset === 0 || dirty}
              onClick={() => setChatOffset(Math.max(0, chatOffset - 100))}
            >
              Previous chats
            </Button>
            <Button
              variant="soft"
              disabled={chats.length < 100 || dirty}
              onClick={() => setChatOffset(chatOffset + 100)}
            >
              Next chats
            </Button>
          </Flex>
          <Field
            label="Chat ID (can configure before first message)"
            value={chat}
            onChange={setChat}
          />
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
              <Text as="p">Access must also be approved on the Access page.</Text>
              <Heading size="3">Effective saved settings</Heading>
              <pre>
                {JSON.stringify(
                  chats.find((c) => String(c.id) === chat)?.effective ??
                    "Available after saving and reload",
                  null,
                  2,
                )}
              </pre>
            </Card>
          )}
          {!chats.length && (
            <Text>No chats observed. You can configure a Telegram ID directly.</Text>
          )}
        </>
      )}
      {page === "Access" && (
        <>
          <Text as="p">Private-message approval does not grant access in any group.</Text>
          <IdList
            key={`${snapshot.revision}:users`}
            label="Allowed private user IDs (comma separated)"
            values={policy.privateUsers}
            positive
            onChange={(values) => update({ ...policy, privateUsers: values })}
          />
          <IdList
            key={`${snapshot.revision}:groups`}
            label="Allowed group / channel IDs (negative, comma separated)"
            values={policy.groups}
            positive={false}
            onChange={(values) => update({ ...policy, groups: values })}
          />
        </>
      )}
      {page === "Defaults" && (
        <Choices
          defaults
          value={policy.defaults}
          policy={policy}
          inventory={inventory}
          onChange={(v) => update({ ...policy, defaults: v })}
        />
      )}
      {page === "Tools / MCP" && (
        <>
          <Callout.Root color="orange">
            <Callout.Text>
              Shell and file tools are trusted capabilities, not a sandbox. They can access
              process-readable credentials. New tools are denied until explicitly approved.
            </Callout.Text>
          </Callout.Root>
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
          <Field label="Additional approved tool name" value={toolName} onChange={setToolName} />
          <Button
            disabled={!toolName}
            onClick={() => {
              update({ ...policy, tools: [...new Set([...policy.tools, toolName])] })
              setToolName("")
            }}
          >
            Approve named tool
          </Button>
          <Heading size="3" mt="4">
            MCP configuration
          </Heading>
          {inventory.mcp.map((m) => (
            <Card key={m.name}>
              <Text>
                {m.name} · {m.enabled === false ? "disabled" : "enabled"} ·{" "}
                {m.exposure ?? "codemode"}
              </Text>
              <Text as="p">Connection: {m.connection}</Text>
              <pre>{m.tools?.join("\n")}</pre>
              <Button
                variant="soft"
                disabled={busy || dirty}
                onClick={() =>
                  void run(async () => {
                    await request(`mcp/${m.name}/discover`, session.csrf)
                    await load()
                  })
                }
              >
                Test and discover {m.name}
              </Button>
              <AlertDialog.Root>
                <AlertDialog.Trigger>
                  <Button color="red" variant="soft" disabled={busy || dirty}>
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
              setMcpName(name)
              setMcpSecrets({ env: {}, headers: {} })
            }}
          />
          <label htmlFor="mcp-config">
            Server configuration JSON
            <TextArea
              id="mcp-config"
              value={mcpConfig}
              onChange={(e) => setMcpConfig(e.target.value)}
              rows={12}
            />
          </label>
          <SecretFields
            key={mcpName}
            onChange={({ scope, name, value }) =>
              setMcpSecrets({ ...mcpSecrets, [scope]: { ...mcpSecrets[scope], [name]: value } })
            }
          />
          <Text as="p">
            Pending secret fields:{" "}
            {[...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(", ") ||
              "none"}
            . Enter new secret values only in the masked field, not the JSON editor.
          </Text>
          <Text as="p">
            Omit fields to preserve them. In env and headers, null preserves a value; an empty
            object clears the map. Do not put secrets in commands, arguments, descriptions, or URLs.
          </Text>
          <Button
            disabled={busy || dirty || !mcpName}
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
                await load()
              })
            }
          >
            Save MCP configuration and apply
          </Button>
        </>
      )}
      <section hidden={page !== "Model Providers"}>
        <Providers
          snapshot={snapshot}
          inventory={inventory}
          csrf={session.csrf}
          dirty={dirty}
          busy={busy}
          run={run}
          refresh={load}
          error={error}
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
                <Button variant="soft" onClick={() => setEditingProvider(p)}>
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
            key={JSON.stringify(editingProvider) ?? "new"}
            initial={editingProvider}
            onAdd={(p) => {
              update({
                ...policy,
                providers: [...policy.providers.filter((row) => row.id !== p.id), p],
              })
              setEditingProvider(undefined)
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
      {page === "Audit" && (
        <>
          <Text as="p">
            Latest configuration operations. Secret values and conversation contents are excluded.
          </Text>
          <Heading size="3">Import reports</Heading>
          <pre>{JSON.stringify(imports, null, 2)}</pre>
          <pre>{audit.length ? JSON.stringify(audit, null, 2) : "No audit records."}</pre>
          <Flex gap="2">
            <Button
              disabled={auditOffset === 0 || dirty}
              onClick={() => setAuditOffset(Math.max(0, auditOffset - 100))}
            >
              Newer
            </Button>
            <Button
              disabled={audit.length < 100 || dirty}
              onClick={() => setAuditOffset(auditOffset + 100)}
            >
              Older
            </Button>
          </Flex>
        </>
      )}
      <VisuallyHidden.Root>
        <span role="status">
          {busy ? "Operation in progress" : dirty ? "Unsaved changes" : "Ready"}
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
