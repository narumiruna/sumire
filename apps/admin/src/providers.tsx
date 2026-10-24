import { ChevronDownIcon, InfoCircledIcon } from "@radix-ui/react-icons"
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Code,
  DataList,
  Dialog,
  Flex,
  Heading,
  Popover,
  Text,
  TextField,
} from "@radix-ui/themes"
import { useContext, useEffect, useId, useRef, useState } from "react"
import { type Inventory, type Policy, request, type Selection, type Snapshot } from "./api.js"
import { focusEditor } from "./navigation.js"
import { loginUrl, savedProviderSelection, withProviderModel } from "./provider-policy.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { Panel, Prose, SettingsSection, StatusLabel } from "./surfaces.js"

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
  const displayValue =
    options.find((option) => option.id === value)?.label ??
    (value || `Choose ${label.toLowerCase()}`)
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
            variant="surface"
            disabled={disabled}
            aria-label={`${label}: ${displayValue}`}
            aria-haspopup="dialog"
          >
            <span>{displayValue}</span>
            <ChevronDownIcon aria-hidden />
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
              <Button asChild variant="ghost" key={v.id}>
                <button
                  type="button"
                  role="option"
                  id={`${id}-${index}`}
                  aria-selected={v.id === value}
                  data-active={index === active}
                  onClick={() => choose(v.id)}
                >
                  <strong>{v.label}</strong>
                  <small>{v.detail ?? v.id}</small>
                </button>
              </Button>
            ))}
          </div>
          {!filtered.length && (
            <Text as="p" size="2">
              No matches.
            </Text>
          )}
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
  authRequest,
  savedPolicy,
  onDefaults,
}: {
  authRequest?: { id: number; provider: string }
  savedPolicy: Policy
  onDefaults(): void
  snapshot: Snapshot
  inventory: Inventory
  csrf: string
  dirty: boolean
  busy: boolean
  error: string
  onPending(value: boolean): void
  run(action: () => Promise<void>, focusFailure?: boolean): Promise<void>
  refresh(): Promise<void>
}) {
  const sectionActive = useContext(SectionActive)
  const handledAuthRequest = useRef(0)
  const focusAuth = useRef<string | undefined>(undefined)
  const saved = savedProviderSelection(savedPolicy)
  // Untouched fields follow saved settings. An explicit preview survives credential refresh.
  const [draft, setDraft] = useState<ReturnType<typeof savedProviderSelection> | null>(null)
  const { provider, model, thinking } = draft ?? saved
  const [authOpen, setAuthOpen] = useState(false)
  const [authDetails, setAuthDetails] = useState<{ provider: string; open: boolean }>()
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
  const blocked = busy || dirty || Boolean(oauth)
  const ref = provider && model ? `${provider}/${model}` : ""
  const chatSelections = Object.entries(savedPolicy.chats).filter(([, chat]) => chat.model !== null)
  const supported = selectedModel?.thinking ?? []
  const thinkingValid = thinking !== null && supported.includes(thinking)
  const modelChanged = Boolean(ref) && !snapshot.policy.models.includes(ref)

  useEffect(() => {
    if (!authRequest || handledAuthRequest.current === authRequest.id) return
    handledAuthRequest.current = authRequest.id
    if (oauth || busy) {
      setNotice("Finish or cancel the current operation before switching authentication.")
      return
    }
    if (authRequest.provider !== provider) {
      if (
        (draft || key || answer || authOpen) &&
        !window.confirm("Replace the pending provider selection and authentication input?")
      )
        return
      setKey("")
      setAnswer("")
      setLogin(undefined)
      setAuthOpen(false)
      setDraft(
        authRequest.provider === saved.provider
          ? saved
          : { provider: authRequest.provider, model: "", thinking: null },
      )
      setDiscoveryCheck(undefined)
    }
    setAuthDetails({ provider: authRequest.provider, open: true })
    focusAuth.current = authRequest.provider
  }, [authRequest, provider, draft, key, answer, authOpen, oauth, busy, saved])

  useEffect(() => {
    if (
      focusAuth.current === undefined ||
      focusAuth.current !== provider ||
      !sectionActive ||
      !authDetails?.open
    )
      return
    const frame = requestAnimationFrame(() => {
      focusAuth.current = undefined
      focusEditor(selected ? "#provider-authentication" : "#provider-choice")
    })
    return () => cancelAnimationFrame(frame)
  }, [authDetails, selected, sectionActive, provider])

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
            else await run(refresh, false)
          }
        }
      } catch (error) {
        if (!stopped) {
          // Keep the login ID so the administrator can retry or cancel it.
          setNotice("Could not read provider login. Retry or cancel the interaction.")
          await run(async () => {
            throw error
          }, false)
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
      open={authOpen && sectionActive}
      onOpenChange={(open) => {
        if (!open && !busy) closeAuth()
      }}
    >
      <Flex direction="column" gap="4" className="settings-stack">
        {dirty && (
          <Callout.Root color="orange" size="1" role="status">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              Save or discard pending settings before changing provider credentials or applying a
              model.
            </Callout.Text>
          </Callout.Root>
        )}
        <SettingsSection
          title="Provider"
          description="Select a provider and configure its authentication."
        >
          <div id="provider-choice" tabIndex={-1}>
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
                setDraft(
                  id === saved.provider ? saved : { provider: id, model: "", thinking: null },
                )
                setNotice("")
                setDiscoveryCheck(undefined)
              }}
            />
          </div>

          {selected && (
            <div className="provider-readiness" data-attention={!selected.configured}>
              <StatusLabel tone={selected.configured ? "neutral" : "warning"}>
                {selected.configured
                  ? "Authentication configured locally"
                  : "Authentication required"}
              </StatusLabel>
              <Prose size="2">Remote acceptance is not checked.</Prose>
            </div>
          )}
          {provider && !selected && (
            <Text as="p" color="orange" mt="3">
              The selected provider {provider} is no longer in the catalog. Choose another provider.
              No replacement is selected automatically.
            </Text>
          )}

          {selected && (
            <details
              key={provider}
              className="provider-authentication"
              open={authDetails?.provider === provider ? authDetails.open : !selected.configured}
              onToggle={(event) => setAuthDetails({ provider, open: event.currentTarget.open })}
            >
              <summary id="provider-authentication">Authentication</summary>
              <Panel className="provider-connection">
                <Flex align="center" gap="3" wrap="wrap">
                  {selected.apiKey || selected.oauth ? (
                    <Dialog.Trigger>
                      <Button
                        id="provider-auth-action"
                        variant="soft"
                        disabled={blocked}
                        onClick={configureAuth}
                      >
                        Configure authentication
                      </Button>
                    </Dialog.Trigger>
                  ) : (
                    <Text id="provider-auth-action" tabIndex={-1} size="2">
                      This provider uses host credentials. Configure them on the trusted host.
                    </Text>
                  )}
                  <Button
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
                            <Button variant="soft">Cancel</Button>
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
                <details className="provider-checks">
                  <summary>Credential checks</summary>
                  <Prose size="2">
                    Provider ID: <Code>{selected.id}</Code>
                  </Prose>
                  <DataList.Root size="2" orientation="vertical">
                    <DataList.Item>
                      <DataList.Label>Credential resolution</DataList.Label>
                      <DataList.Value>
                        <Text as="p" size="2" role="status">
                          Local credential check:{" "}
                          {credentialCheck?.provider === provider &&
                          credentialCheck.revision === snapshot.revision
                            ? credentialCheck.status
                            : "Not checked"}
                        </Text>
                      </DataList.Value>
                    </DataList.Item>
                    <DataList.Item>
                      <DataList.Label>Remote acceptance</DataList.Label>
                      <DataList.Value>
                        <Text as="p" size="2">
                          Remote verification: Not checked. Local credential checks do not verify
                          remote acceptance.
                        </Text>
                      </DataList.Value>
                    </DataList.Item>
                  </DataList.Root>
                  <Prose size="2" color="gray" mt="3" className="section-copy">
                    Model availability is unverified. Check authentication resolves credentials
                    without generating model output. You can select and save a model before
                    authentication.
                  </Prose>
                </details>
              </Panel>
            </details>
          )}
        </SettingsSection>
        <SettingsSection
          title="Add an available model"
          description="Add models to global availability. Shared defaults and chat overrides do not change."
        >
          {selected ? (
            <>
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
                }}
              />
              {model && !selectedModel && (
                <Text as="p" color="orange">
                  The selected model is no longer in the catalog. Choose another model before
                  saving.
                </Text>
              )}
              {selectedModel && (
                <>
                  <Flex gap="2" my="3" wrap="wrap">
                    <Badge>{selectedModel.reasoning ? "Reasoning" : "No reasoning"}</Badge>
                    <Badge>{selectedModel.image ? "Image input" : "Text input"}</Badge>
                  </Flex>
                  {!thinkingValid &&
                    (supported.length > 1 || (!thinkingValid && supported.length > 0)) && (
                      <label htmlFor="provider-thinking" className="form-field">
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
                    <Text as="p" color="orange">
                      The selected thinking level is unavailable. Choose a supported level.
                    </Text>
                  )}
                  <Prose size="2" color="gray">
                    Makes this model available. The shared default and chat overrides do not change.
                  </Prose>
                  <section className="provider-save">
                    <AlertDialog.Root>
                      <AlertDialog.Trigger>
                        <Button
                          mt="3"
                          disabled={
                            blocked || !thinkingValid || !modelChanged || custom?.enabled === false
                          }
                        >
                          Save model availability
                        </Button>
                      </AlertDialog.Trigger>
                      <AlertDialog.Content>
                        <AlertDialog.Title>Save model selection?</AlertDialog.Title>
                        <AlertDialog.Description>
                          Add {ref} to availability. Keep the current bot default. Active work will
                          be cancelled.
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
                                    csrf,
                                    {
                                      revision: snapshot.revision,
                                      policy: withProviderModel(snapshot.policy, ref),
                                    },
                                    "PUT",
                                  )
                                  await refresh()
                                  setNotice(
                                    "Model selection saved. Check application status above.",
                                  )
                                })
                              }
                            >
                              Save changes
                            </Button>
                          </AlertDialog.Action>
                        </Flex>
                      </AlertDialog.Content>
                    </AlertDialog.Root>
                    {!blocked && !modelChanged && (
                      <Text as="p" size="2" color="gray" mt="2">
                        Selection matches current settings.
                      </Text>
                    )}
                  </section>
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
                    variant="soft"
                    disabled={blocked || !custom.api?.startsWith("openai-")}
                    onClick={() =>
                      void run(async () => {
                        try {
                          const models = await request<string[]>(
                            `providers/${provider}/discover`,
                            csrf,
                          )
                          setDiscoveryCheck({
                            provider,
                            revision: snapshot.revision,
                            configuration: discoveryConfiguration,
                            models,
                            status:
                              "Verified — bounded model-list request only, not model execution",
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
                    Model-list check: {currentDiscovery?.status ?? "Not checked"}
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
            </>
          ) : (
            <Prose size="2">
              Choose a provider to see its models. No model is selected automatically.
            </Prose>
          )}
          {draft && modelChanged && (
            <Flex>
              <Button
                variant="soft"
                mt="2"
                disabled={busy || Boolean(oauth)}
                onClick={() => {
                  setDraft(null)
                  setNotice("")
                  setDiscoveryCheck(undefined)
                }}
              >
                Use saved selection
              </Button>
            </Flex>
          )}

          <Button variant="ghost" onClick={onDefaults}>
            Edit shared default
          </Button>
        </SettingsSection>
        <details className="provider-saved-settings">
          <summary>Saved model settings</summary>
          <Panel className="provider-current-summary">
            <Flex direction="column" gap="3">
              <div className="section-heading">
                <Heading as="h3" size="3">
                  Current shared default
                </Heading>
              </div>
              <Flex align="start" justify="between" gap="3" wrap="wrap">
                <DataList.Root size="2" orientation={{ initial: "vertical", sm: "horizontal" }}>
                  <DataList.Item>
                    <DataList.Label>Shared bot default in current settings</DataList.Label>
                    <DataList.Value>
                      {savedPolicy.defaults.model ? (
                        <Code>{savedPolicy.defaults.model}</Code>
                      ) : (
                        <Text color="gray">Not set</Text>
                      )}
                    </DataList.Value>
                  </DataList.Item>
                  <DataList.Item>
                    <DataList.Label>Thinking</DataList.Label>
                    <DataList.Value>
                      <Badge color="gray">{savedPolicy.defaults.thinking ?? "off"}</Badge>
                    </DataList.Value>
                  </DataList.Item>
                </DataList.Root>
              </Flex>
              {!inventory.providers.length && (
                <Text as="p">
                  No providers available. Add a custom endpoint below or check the host provider
                  setup.
                </Text>
              )}
              {!savedPolicy.defaults.model && (
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
                        {chat.thinking ?? savedPolicy.defaults.thinking ?? "off"}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Flex>
          </Panel>
        </details>
        {notice && (
          <Callout.Root size="1" role="status">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>{notice}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
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
          <Text as="p" color="red" role="alert">
            {error}
          </Text>
        )}
        {method === "choose" && (
          <Flex direction="column" gap="3" mt="4">
            <Button disabled={busy} onClick={startAccount}>
              Sign in with account
            </Button>
            <Button variant="soft" disabled={busy} onClick={() => setMethod("key")}>
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
              <Button variant="soft" disabled={busy || dirty} onClick={startAccount}>
                Retry account sign-in
              </Button>
            )}
            {login?.event?.message && <Text>{login.event.message}</Text>}
            {authLink && (
              <Button asChild variant="soft">
                <a href={authLink} target="_blank" rel="noopener noreferrer">
                  Open provider sign-in
                </a>
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
          <Button variant="soft" disabled={busy} onClick={closeAuth}>
            {oauth ? "Cancel provider login" : "Close"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
