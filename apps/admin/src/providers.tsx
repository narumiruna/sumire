import { MagnifyingGlassIcon } from "@radix-ui/react-icons"
import {
  AlertDialog,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Flex,
  Heading,
  Link,
  Popover,
  Text,
  TextField,
} from "@radix-ui/themes"
import { useContext, useEffect, useId, useState } from "react"
import { type Inventory, request, type Selection, type Snapshot } from "./api.js"
import { loginUrl, savedProviderSelection, withProviderModel } from "./provider-policy.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { StatusBadge } from "./semantic-status.js"
import { EmptyState, Panel, Prose } from "./surfaces.js"

type Option = { id: string; label: string; detail?: string }
export function SearchChoice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  onChange(value: string): void
}) {
  const sectionActive = useContext(SectionActive)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!sectionActive) setOpen(false)
  }, [sectionActive])
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const id = useId()
  const filtered = options.filter((v) =>
    `${v.label} ${v.id}`.toLowerCase().includes(query.toLowerCase()),
  )
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [active, id, open])
  const choose = (value: string) => {
    onChange(value)
    setOpen(false)
  }
  return (
    <div className="provider-choice">
      <Text as="p" size="2" weight="medium">
        {label}
      </Text>
      <Popover.Root
        open={open && sectionActive}
        onOpenChange={(v) => {
          setOpen(v)
          setQuery("")
          setActive(0)
        }}
      >
        <Popover.Trigger>
          <Button
            color="gray"
            variant="surface"
            disabled={disabled}
            aria-label={label}
            aria-haspopup="dialog"
          >
            <MagnifyingGlassIcon aria-hidden="true" />
            {options.find((v) => v.id === value)?.label ??
              (value || `Choose ${label.toLowerCase()}`)}
          </Button>
        </Popover.Trigger>
        <Popover.Content
          className="provider-search"
          aria-label={`Choose ${label.toLowerCase()}`}
          onCloseAutoFocus={(event) => {
            // Navigation must keep focus on the destination, not a hidden trigger.
            if (!sectionActive) event.preventDefault()
          }}
        >
          <TextField.Root
            role="combobox"
            aria-label={`Search ${label.toLowerCase()}`}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={id}
            aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                setActive((v) =>
                  Math.max(0, Math.min(filtered.length - 1, v + (e.key === "ArrowDown" ? 1 : -1))),
                )
              } else if (e.key === "Enter" && filtered[active]) {
                e.preventDefault()
                choose(filtered[active].id)
              }
            }}
          />
          <div id={id} role="listbox" aria-label={`${label} results`} className="provider-options">
            {filtered.map((v, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-${index}`}
                key={v.id}
                aria-selected={v.id === value}
                data-active={index === active}
                onClick={() => choose(v.id)}
              >
                <strong>{v.label}</strong>
                <small>{v.detail ?? v.id}</small>
              </button>
            ))}
          </div>
          {!filtered.length && <EmptyState title="No matches." />}
        </Popover.Content>
      </Popover.Root>
    </div>
  )
}

type LoginState = {
  status: string
  event?: {
    type: string
    url?: string
    verificationUri?: string
    userCode?: string
    message?: string
  }
  prompt?: { message: string; type: string; options?: { id: string; label: string }[] }
}

export function Providers({
  snapshot,
  inventory,
  csrf,
  dirty,
  busy,
  run,
  refresh,
  error,
  onPending,
}: {
  snapshot: Snapshot
  inventory: Inventory
  csrf: string
  dirty: boolean
  busy: boolean
  error: string
  onPending(value: boolean): void
  run(action: () => Promise<void>): Promise<void>
  refresh(): Promise<void>
}) {
  const saved = savedProviderSelection(snapshot.policy)
  // Untouched fields follow saved settings. An explicit preview survives credential refresh.
  const [draft, setDraft] = useState<ReturnType<typeof savedProviderSelection> | null>(null)
  const { provider, model, thinking } = draft ?? saved
  const [defaultChoice, setDefaultChoice] = useState<boolean>()
  const [authOpen, setAuthOpen] = useState(false)
  const [method, setMethod] = useState<"choose" | "key" | "account">("choose")
  const [key, setKey] = useState("")
  const [answer, setAnswer] = useState("")
  const [oauth, setOauth] = useState("")
  const [login, setLogin] = useState<LoginState>()
  const [notice, setNotice] = useState("")
  const [credentialCheck, setCredentialCheck] = useState<{
    provider: string
    status: string
    revision: number
  }>()
  const [discoveryCheck, setDiscoveryCheck] = useState<{
    provider: string
    status: string
    revision: number
    configuration: string
    models: string[]
  }>()
  const selected = inventory.providers.find((p) => p.id === provider)
  const selectedModel = selected?.models.find((m) => m.id === model)
  const custom = snapshot.policy.providers.find((p) => p.id === provider)
  const discoveryConfiguration = JSON.stringify([
    custom?.baseUrl,
    custom?.api,
    custom?.enabled,
    custom?.models,
  ])
  const currentDiscovery =
    discoveryCheck?.provider === provider &&
    discoveryCheck.revision === snapshot.revision &&
    discoveryCheck.configuration === discoveryConfiguration
      ? discoveryCheck
      : undefined
  const discovered = currentDiscovery?.models ?? []
  const currentCredential =
    credentialCheck?.provider === provider && credentialCheck.revision === snapshot.revision
      ? credentialCheck
      : undefined
  const blocked = busy || dirty || Boolean(oauth)
  const ref = provider && model ? `${provider}/${model}` : ""
  const useDefault = defaultChoice ?? (Boolean(ref) && ref === snapshot.policy.defaults.model)
  const chatSelections = Object.entries(snapshot.policy.chats).filter(
    ([, chat]) => chat.model !== null,
  )
  const supported = selectedModel?.thinking ?? []
  const thinkingValid = thinking !== null && supported.includes(thinking)
  const modelChanged =
    !snapshot.policy.models.includes(ref) ||
    (useDefault &&
      (snapshot.policy.defaults.model !== ref ||
        (snapshot.policy.defaults.thinking ?? "off") !== thinking ||
        !snapshot.policy.defaults.models?.includes(ref)))

  useEffect(() => {
    onPending(Boolean(key || answer || oauth || (modelChanged && draft)))
  }, [key, answer, oauth, modelChanged, draft, onPending])

  useEffect(() => {
    if (!oauth) return
    let stopped = false
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const state = await request<LoginState>(`oauth/${oauth}`)
        if (stopped) return
        setLogin(state)
        if (state.status !== "pending") {
          setOauth("")
          setAnswer("")
          if (state.status === "completed") {
            setNotice("Provider authenticated. Your model selection is retained.")
            setAuthOpen(false)
            // Do not overwrite policy edits made on another page during login.
            if (dirty)
              setNotice(
                "Provider authenticated. Save or discard your policy edits before reloading the new revision.",
              )
            else await run(refresh)
          }
        }
      } catch (error) {
        if (!stopped) {
          // Keep the login ID so the administrator can retry or cancel it.
          setNotice("Could not read provider login. Retry or cancel the interaction.")
          await run(async () => {
            throw error
          })
        }
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [oauth, dirty, run, refresh])

  const startAccount = () => {
    setMethod("account")
    void run(async () => {
      const state = await request<{ id: string }>(`providers/${provider}/oauth`, csrf, {
        revision: snapshot.revision,
      })
      setOauth(state.id)
      setLogin({ status: "pending" })
    })
  }
  const closeAuth = () =>
    void run(async () => {
      if (oauth) {
        await request(`oauth/${oauth}`, csrf, { cancel: true })
        // Login can finish before cancellation reaches the server. Read its final saved revision.
        if (!dirty) await refresh()
      }
      setOauth("")
      setLogin(undefined)
      setKey("")
      setAnswer("")
      setAuthOpen(false)
    })
  const configureAuth = () => {
    setKey("")
    setAnswer("")
    setLogin(undefined)
    setAuthOpen(true)
    if (selected?.apiKey && selected.oauth) setMethod("choose")
    else if (selected?.apiKey) setMethod("key")
    else startAccount()
  }
  const authLink = loginUrl(login?.event?.url ?? login?.event?.verificationUri)
  return (
    <Dialog.Root
      open={authOpen}
      onOpenChange={(open) => {
        if (!open && !busy) closeAuth()
      }}
    >
      <Prose color="gray">
        Select a provider and configure its credentials, then choose a model.
      </Prose>
      <Text as="p" size="2" color="gray" className="provider-current" mt="2">
        Shared bot default in current settings: {snapshot.policy.defaults.model ?? "Not set"} ·
        Thinking: {snapshot.policy.defaults.thinking ?? "off"}
      </Text>
      {snapshot.policy.defaults.model && (
        <AlertDialog.Root>
          <AlertDialog.Trigger>
            <Button color="gray" variant="ghost" disabled={blocked}>
              Clear shared default model
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Content>
            <AlertDialog.Title>Clear the shared default model?</AlertDialog.Title>
            <AlertDialog.Description>
              Save and apply an unconfigured shared model and thinking default. Allowed models,
              authentication, and chat overrides stay unchanged. Active work will be cancelled.
            </AlertDialog.Description>
            <Flex gap="3" mt="4">
              <AlertDialog.Cancel>
                <Button color="gray" variant="soft">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button
                  variant="soft"
                  color="gray"
                  onClick={() =>
                    void run(async () => {
                      await request(
                        "settings",
                        csrf,
                        {
                          revision: snapshot.revision,
                          policy: {
                            ...snapshot.policy,
                            defaults: { ...snapshot.policy.defaults, model: null, thinking: null },
                          },
                        },
                        "PUT",
                      )
                      await refresh()
                      setNotice("Shared default cleared. Chat overrides remain unchanged.")
                    })
                  }
                >
                  Clear default and apply
                </Button>
              </AlertDialog.Action>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>
      )}
      {!inventory.providers.length && (
        <EmptyState
          title="No providers available."
          description="Add a custom endpoint below or check the host provider setup."
        />
      )}
      {!snapshot.policy.defaults.model && (
        <Text as="p" size="2" color="gray" mt="2">
          {saved.model
            ? `Existing chat model: ${saved.provider}/${saved.model}. This is not a shared bot default.`
            : "No shared bot default. Chats can use different models; no model is selected automatically."}
        </Text>
      )}
      {chatSelections.length > 0 && (
        <details className="provider-advanced provider-current">
          <summary>Chat-specific models ({chatSelections.length})</summary>
          <Text as="p" size="2">
            These settings override the bot default. Change them on Chats.
          </Text>
          <ul>
            {chatSelections.map(([id, chat]) => (
              <li key={id}>
                Chat {id}: {chat.model} · Thinking:{" "}
                {chat.thinking ?? snapshot.policy.defaults.thinking ?? "off"}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(draft || defaultChoice !== undefined) && (
        <Button
          color="gray"
          variant="soft"
          mt="2"
          disabled={busy || Boolean(oauth)}
          onClick={() => {
            setDraft(null)
            setDefaultChoice(undefined)
            setNotice("")
            setDiscoveryCheck(undefined)
          }}
        >
          Use saved selection
        </Button>
      )}
      {dirty && (
        <Text as="p" role="status">
          <StatusBadge status="pending">
            Save or discard the unsaved settings above before changing provider credentials or
            applying a model.
          </StatusBadge>
        </Text>
      )}
      <ol className="provider-steps" aria-label="Provider setup steps">
        <li>Configure credentials</li>
        <li>Review check status</li>
        <li>Choose model</li>
        <li>Save model explicitly</li>
      </ol>
      <Panel mt="4">
        <Heading size="3">1. Provider and authentication</Heading>
        <SearchChoice
          label="Provider"
          value={provider}
          disabled={Boolean(oauth) || busy}
          options={inventory.providers.map((p) => ({
            id: p.id,
            label: p.name,
            detail: `${p.id} · ${p.configured ? "Configured" : "Not configured"}`,
          }))}
          onChange={(id) => {
            if (id === provider) return
            setDraft(id === saved.provider ? saved : { provider: id, model: "", thinking: null })
            setDefaultChoice(false)
            setNotice("")
            setDiscoveryCheck(undefined)
          }}
        />
        {provider && !selected && (
          <Text as="p" mt="3">
            <StatusBadge status="unknown">
              The selected provider {provider} is no longer in the catalog. Choose another provider.
              No replacement is selected automatically.
            </StatusBadge>
          </Text>
        )}
        {selected && (
          <>
            <Flex align="center" gap="2" wrap="wrap" mt="3">
              <StatusBadge status={selected.configured ? "approved" : "unknown"}>
                {selected.configured
                  ? "Authentication configured locally"
                  : "Authentication not configured"}
              </StatusBadge>
              {custom?.enabled === false && <StatusBadge status="disabled" />}
              {selected.apiKey || selected.oauth ? (
                <Dialog.Trigger>
                  <Button color="gray" variant="soft" disabled={blocked} onClick={configureAuth}>
                    Configure authentication
                  </Button>
                </Dialog.Trigger>
              ) : (
                <Text size="2">
                  This provider uses host credentials. Configure them on the trusted host.
                </Text>
              )}
              <Button
                color="gray"
                variant="ghost"
                disabled={blocked}
                onClick={() =>
                  void run(async () => {
                    try {
                      const result = await request<{ configured: boolean }>(
                        `providers/${provider}/test`,
                        csrf,
                      )
                      setCredentialCheck({
                        provider,
                        revision: snapshot.revision,
                        status: result.configured ? "Configured locally" : "Not configured",
                      })
                      setNotice(
                        result.configured
                          ? "Authentication is available. No tokens were generated."
                          : "Authentication is not available. Check provider setup.",
                      )
                    } catch (error) {
                      setCredentialCheck({
                        provider,
                        revision: snapshot.revision,
                        status: "Check failed",
                      })
                      throw error
                    }
                  })
                }
              >
                Check authentication
              </Button>
              {selected.configured && (
                <AlertDialog.Root>
                  <AlertDialog.Trigger>
                    <Button variant="ghost" color="red" disabled={blocked}>
                      Remove credential
                    </Button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Content>
                    <AlertDialog.Title>Remove provider credential?</AlertDialog.Title>
                    <AlertDialog.Description>
                      Replace model references first. Ambient environment credentials are not
                      removed.
                    </AlertDialog.Description>
                    <Flex gap="3" mt="4">
                      <AlertDialog.Cancel>
                        <Button color="gray" variant="soft">
                          Cancel
                        </Button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action>
                        <Button
                          color="red"
                          onClick={() =>
                            void run(async () => {
                              await request(`providers/${provider}/credential`, csrf, {
                                key: null,
                                revision: snapshot.revision,
                              })
                              await refresh()
                            })
                          }
                        >
                          Remove
                        </Button>
                      </AlertDialog.Action>
                    </Flex>
                  </AlertDialog.Content>
                </AlertDialog.Root>
              )}
            </Flex>
            <Heading size="3" mt="3">
              2. Check status
            </Heading>
            <Text as="p" size="2" role="status">
              Local credential check:{" "}
              <StatusBadge
                status={
                  currentCredential?.status === "Check failed"
                    ? "failed"
                    : currentCredential?.status === "Configured locally"
                      ? "approved"
                      : "unknown"
                }
              >
                {currentCredential?.status ?? "Not checked"}
              </StatusBadge>
            </Text>
            <Text as="p" size="2">
              Remote verification: <StatusBadge status="unknown">Not checked.</StatusBadge> Local
              credential checks do not verify remote acceptance.
            </Text>
            <Text as="p" size="2" color="gray" mt="2">
              Model availability is unverified. Check authentication resolves credentials without
              generating model output. You can select and save a model before authentication.
            </Text>
          </>
        )}
      </Panel>
      {selected && (
        <Panel mt="3">
          <Heading size="3">3. Choose model</Heading>
          <SearchChoice
            label="Model"
            value={model}
            disabled={Boolean(oauth) || busy}
            options={selected.models.map((m) => ({ id: m.id, label: m.name, detail: m.id }))}
            onChange={(id) => {
              if (id === model) return
              setDraft({
                provider,
                model: id,
                thinking:
                  (selected.models.find((m) => m.id === id)
                    ?.thinking[0] as Selection["thinking"]) ?? null,
              })
              setDefaultChoice(false)
            }}
          />
          {model && !selectedModel && (
            <Text as="p">
              <StatusBadge status="unknown">
                The selected model is no longer in the catalog. Choose another model before saving.
              </StatusBadge>
            </Text>
          )}
          {selectedModel && (
            <>
              <Flex gap="2" my="3" wrap="wrap">
                <Badge color="gray">{selectedModel.reasoning ? "Reasoning" : "No reasoning"}</Badge>
                <Badge color="gray">{selectedModel.image ? "Image input" : "Text input"}</Badge>
              </Flex>
              {(supported.length > 1 || (!thinkingValid && supported.length > 0)) && (
                <label htmlFor="provider-thinking">
                  Thinking level
                  <Select.Root
                    value={thinking ?? ""}
                    onValueChange={(v) =>
                      setDraft({ provider, model, thinking: v as Selection["thinking"] })
                    }
                  >
                    <Select.Trigger id="provider-thinking" aria-label="Thinking level" />
                    <Select.Content>
                      {supported.map((level) => (
                        <Select.Item key={level} value={level}>
                          {level}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </label>
              )}
              {!thinkingValid && (
                <Text as="p">
                  <StatusBadge status="unknown">
                    The selected thinking level is unavailable. Choose a supported level.
                  </StatusBadge>
                </Text>
              )}
              <label className="check" htmlFor="provider-default">
                <Checkbox
                  id="provider-default"
                  aria-label="Use as the bot default"
                  checked={useDefault}
                  onCheckedChange={(v) => {
                    setDraft(draft ?? saved)
                    setDefaultChoice(v === true)
                  }}
                />
                Use as the bot default
              </label>
              <Text as="p" size="2" color="gray">
                {useDefault
                  ? "Changes the inherited model and thinking defaults. Chat overrides stay unchanged. Each chat must allow this model."
                  : "Add only this model to global availability. The bot default and chat overrides stay unchanged. Thinking applies only when this is the bot default."}
              </Text>
              {thinkingValid && !modelChanged && (
                <Text as="p" size="2" color="gray" mt="2">
                  Selection matches current settings. No model change is needed.
                </Text>
              )}
              <Heading size="3" mt="3">
                4. Save model
              </Heading>
              <AlertDialog.Root>
                <AlertDialog.Trigger>
                  <Button
                    variant="soft"
                    color="gray"
                    mt="3"
                    disabled={
                      blocked || !thinkingValid || !modelChanged || custom?.enabled === false
                    }
                  >
                    {useDefault ? "Save default model" : "Save model availability"}
                  </Button>
                </AlertDialog.Trigger>
                <AlertDialog.Content>
                  <AlertDialog.Title>Save model selection?</AlertDialog.Title>
                  <AlertDialog.Description>
                    Add {ref} to availability.
                    {useDefault
                      ? ` Set it as the bot default with thinking ${thinking}.`
                      : " Keep the current bot default."}{" "}
                    Active work will be cancelled.
                  </AlertDialog.Description>
                  <Flex gap="3" mt="4">
                    <AlertDialog.Cancel>
                      <Button color="gray" variant="soft">
                        Cancel
                      </Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button
                        variant="soft"
                        color="gray"
                        onClick={() =>
                          void run(async () => {
                            await request(
                              "settings",
                              csrf,
                              {
                                revision: snapshot.revision,
                                policy: withProviderModel(
                                  snapshot.policy,
                                  ref,
                                  thinking,
                                  useDefault,
                                ),
                              },
                              "PUT",
                            )
                            await refresh()
                            setNotice("Model selection saved. Check application status above.")
                          })
                        }
                      >
                        Save and apply
                      </Button>
                    </AlertDialog.Action>
                  </Flex>
                </AlertDialog.Content>
              </AlertDialog.Root>
            </>
          )}
          {custom?.baseUrl && (
            <details className="provider-advanced">
              <summary>Model discovery</summary>
              <Text as="p" size="2">
                OpenAI-compatible endpoints only. Discovery returns IDs, not verified model
                capabilities. Add their metadata under Custom endpoint.
              </Text>
              <Button
                color="gray"
                variant="soft"
                disabled={blocked || !custom.api?.startsWith("openai-")}
                onClick={() =>
                  void run(async () => {
                    try {
                      const models = await request<string[]>(`providers/${provider}/discover`, csrf)
                      setDiscoveryCheck({
                        provider,
                        revision: snapshot.revision,
                        configuration: discoveryConfiguration,
                        models,
                        status: "Verified — bounded model-list request only, not model execution",
                      })
                    } catch (error) {
                      setDiscoveryCheck({
                        provider,
                        revision: snapshot.revision,
                        configuration: discoveryConfiguration,
                        models: [],
                        status: "Check failed",
                      })
                      throw error
                    }
                  })
                }
              >
                Discover custom models
              </Button>
              <Text as="p" role="status">
                Model-list check:{" "}
                <StatusBadge
                  status={
                    !currentDiscovery
                      ? "unknown"
                      : currentDiscovery.status === "Check failed"
                        ? "failed"
                        : "approved"
                  }
                >
                  {currentDiscovery?.status ?? "Not checked"}
                </StatusBadge>
              </Text>
              {discovered.length > 0 && (
                <ul>
                  {discovered.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </Panel>
      )}
      {notice && (
        <Text as="p" role="status" mt="3">
          {notice}
        </Text>
      )}
      <Dialog.Content
        maxWidth="480px"
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault()
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <Dialog.Title>Connect {selected?.name}</Dialog.Title>
        <Dialog.Description size="2">
          Credentials are stored by Pi on the server. Existing secrets are never displayed.
        </Dialog.Description>
        {error && (
          <Text as="p" className="error-state" data-status="failed" role="alert">
            {error}
          </Text>
        )}
        {method === "choose" && (
          <Flex direction="column" gap="3" mt="4">
            <Button variant="soft" color="gray" disabled={busy} onClick={startAccount}>
              Sign in with account
            </Button>
            <Button color="gray" variant="soft" disabled={busy} onClick={() => setMethod("key")}>
              Use API key
            </Button>
          </Flex>
        )}
        {method === "key" && (
          <>
            <label htmlFor="provider-key">
              API key
              <TextField.Root
                id="provider-key"
                disabled={busy}
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <Button
              variant="soft"
              color="gray"
              disabled={busy || !key || dirty}
              onClick={() =>
                void run(async () => {
                  await request(`providers/${provider}/credential`, csrf, {
                    key,
                    revision: snapshot.revision,
                  })
                  setKey("")
                  await refresh()
                  setAuthOpen(false)
                  setNotice("Provider authentication saved. Your model selection is retained.")
                })
              }
            >
              Save API key
            </Button>
          </>
        )}
        {method === "account" && (
          <Flex direction="column" gap="3" mt="3">
            <Text role="status">Provider login: {login?.status ?? "starting"}</Text>
            {!oauth && (
              <Button color="gray" variant="soft" disabled={busy || dirty} onClick={startAccount}>
                Retry account sign-in
              </Button>
            )}
            {login?.event?.message && <Text>{login.event.message}</Text>}
            {authLink && (
              <Button color="gray" asChild variant="soft">
                <Link color="gray" href={authLink} target="_blank" rel="noopener noreferrer">
                  Open provider sign-in
                </Link>
              </Button>
            )}
            {login?.event?.userCode && (
              <Text>
                Verification code: <code>{login.event.userCode}</code>
              </Text>
            )}
            {login?.prompt && (
              <>
                <Text>{login.prompt.message}</Text>
                {login.prompt.options ? (
                  <label htmlFor="provider-answer">
                    Login option
                    <Select.Root disabled={busy} value={answer} onValueChange={setAnswer}>
                      <Select.Trigger id="provider-answer" aria-label={login.prompt.message} />
                      <Select.Content>
                        {login.prompt.options.map((v) => (
                          <Select.Item key={v.id} value={v.id}>
                            {v.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </label>
                ) : (
                  <label htmlFor="provider-answer">
                    Provider login response
                    <TextField.Root
                      id="provider-answer"
                      disabled={busy}
                      type="password"
                      autoComplete="off"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                  </label>
                )}
                <Button
                  variant="soft"
                  color="gray"
                  disabled={busy || !answer}
                  onClick={() =>
                    void run(async () => {
                      await request(`oauth/${oauth}`, csrf, { answer })
                      setAnswer("")
                    })
                  }
                >
                  Submit response
                </Button>
              </>
            )}
          </Flex>
        )}
        <Flex justify="end" mt="4">
          <Button color="gray" variant="soft" disabled={busy} onClick={closeAuth}>
            {oauth ? "Cancel provider login" : "Close"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
