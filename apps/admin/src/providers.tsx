import {
  ChevronDownIcon,
  CubeIcon,
  InfoCircledIcon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons"
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
import {
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type Inventory, type Policy, request, type Selection, type Snapshot } from "./api.js"
import { focusEditor } from "./navigation.js"
import {
  configuredProviders,
  loginUrl,
  providerReferences,
  savedProviderSelection,
  withProviderModel,
} from "./provider-policy.js"
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
  const trigger = useRef<HTMLButtonElement>(null)
  const tabExit = useRef(false)
  const id = useId()
  const displayValue =
    options.find((option) => option.id === value)?.label ??
    (value || `Choose ${label.toLowerCase()}`)
  const filtered = useMemo(
    () => options.filter((v) => `${v.label} ${v.id}`.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  )
  useEffect(() => {
    if (open && filtered[active])
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [active, filtered, id, open])
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
          if (v) tabExit.current = false
          setOpen(v)
          setQuery("")
          setActive(0)
        }}
      >
        <Popover.Trigger>
          <Button
            ref={trigger}
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
            if (!sectionActive || tabExit.current || !trigger.current?.checkVisibility())
              event.preventDefault()
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
              if (e.key === "Tab") {
                // Leave Radix's looping focus scope. Native Tab then moves from the trigger.
                e.stopPropagation()
                tabExit.current = true
                setOpen(false)
                if (sectionActive && trigger.current?.checkVisibility()) trigger.current.focus()
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
                  tabIndex={-1}
                  id={`${id}-${index}`}
                  aria-selected={v.id === value}
                  data-active={index === active}
                  onMouseDown={(event) => event.preventDefault()}
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
  chat = "",
  onChat,
  connection,
  availability,
  onCustomEndpoint,
  onSelectProvider,
  editorTarget,
}: {
  chat?: string
  onChat?(): void
  connection?(provider: string): ReactNode
  availability?(provider: string): ReactNode
  onCustomEndpoint?(): boolean
  onSelectProvider?(provider: string): boolean
  editorTarget?: string
  authRequest?: { id: number; provider: string; model?: string; thinking?: Selection["thinking"] }
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
  const [view, setView] = useState<"list" | "add" | "detail">("list")
  const [providerQuery, setProviderQuery] = useState("")
  const handledAuthRequest = useRef(0)
  const focusAuth = useRef<string | undefined>(undefined)
  const focusDetail = useRef(false)
  const saved = savedProviderSelection(savedPolicy)
  // Untouched fields follow saved settings. An explicit preview survives credential refresh.
  const [draft, setDraft] = useState<ReturnType<typeof savedProviderSelection> | null>(null)
  const { provider, model, thinking } = draft ?? saved
  const [directoryQuery, setDirectoryQuery] = useState("")
  const [providerFilter, setProviderFilter] = useState("all")
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
  const providers = [
    ...new Map(
      [
        ...configuredProviders(snapshot.policy, inventory),
        ...configuredProviders(savedPolicy, inventory),
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort((a, b) => a.id.localeCompare(b.id))
  const visibleProviders = providers.filter(
    (item) =>
      `${item.name} ${item.id}`.toLowerCase().includes(directoryQuery.trim().toLowerCase()) &&
      (providerFilter === "all" ||
        (providerFilter === "configured" ? item.configured === true : item.configured !== true)),
  )
  const references = providerReferences(savedPolicy, provider)
  const supported = selectedModel?.thinking ?? []
  const thinkingValid = thinking !== null && supported.includes(thinking)
  const modelChanged = Boolean(ref) && !snapshot.policy.models.includes(ref)

  useLayoutEffect(() => {
    if (!sectionActive) return
    const revealAnchor = () => {
      if (
        ["#model-availability", "#endpoint-provider-id", "#provider-authentication"].includes(
          editorTarget ?? window.location.hash,
        )
      )
        setView("detail")
    }
    revealAnchor()
    window.addEventListener("hashchange", revealAnchor)
    return () => window.removeEventListener("hashchange", revealAnchor)
  }, [sectionActive, editorTarget])

  useEffect(() => {
    if (!authRequest || handledAuthRequest.current === authRequest.id) return
    handledAuthRequest.current = authRequest.id
    if (oauth || busy) {
      setNotice("Finish or cancel the current operation before switching authentication.")
      return
    }
    if (
      authRequest.provider !== provider ||
      (authRequest.model && (authRequest.model !== model || authRequest.thinking !== thinking))
    ) {
      if (
        (draft || key || answer || authOpen) &&
        !window.confirm("Replace the pending provider selection and authentication input?")
      )
        return
      if (
        authRequest.provider !== provider &&
        onSelectProvider &&
        !onSelectProvider(authRequest.provider)
      )
        return
      setKey("")
      setAnswer("")
      setLogin(undefined)
      setAuthOpen(false)
      setDraft(
        authRequest.model
          ? {
              provider: authRequest.provider,
              model: authRequest.model,
              thinking: authRequest.thinking ?? null,
            }
          : authRequest.provider === saved.provider
            ? saved
            : { provider: authRequest.provider, model: "", thinking: null },
      )
      setDiscoveryCheck(undefined)
    }
    setView("detail")
    setAuthDetails({ provider: authRequest.provider, open: true })
    focusAuth.current = authRequest.provider
  }, [
    authRequest,
    provider,
    model,
    thinking,
    draft,
    key,
    answer,
    authOpen,
    oauth,
    busy,
    saved,
    onSelectProvider,
  ])

  useEffect(() => {
    if (
      focusAuth.current === undefined ||
      focusAuth.current !== provider ||
      !sectionActive ||
      !authDetails?.open
    )
      return
    // Let the revealed detail and any closing picker finish their focus work first.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        focusAuth.current = undefined
        focusEditor(selected ? "#provider-authentication" : "#provider-detail-heading")
      })
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
  useEffect(() => {
    if (!sectionActive || view !== "detail" || !focusDetail.current) return
    focusDetail.current = false
    const frame = requestAnimationFrame(() => focusEditor("#provider-detail-heading"))
    return () => cancelAnimationFrame(frame)
  }, [view, sectionActive])

  const openProvider = (id: string) => {
    if (busy || oauth) return
    if (
      id !== provider &&
      (draft || key || answer || authOpen) &&
      !window.confirm("Replace the pending provider selection and authentication input?")
    )
      return
    if (id !== provider && onSelectProvider && !onSelectProvider(id)) return
    if (id !== provider) {
      setDraft(id === saved.provider ? saved : { provider: id, model: "", thinking: null })
      setKey("")
      setAnswer("")
      setAuthOpen(false)
      setNotice("")
      setDiscoveryCheck(undefined)
    }
    focusDetail.current = true
    setView("detail")
  }
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
              Save or discard pending settings before changing provider credentials or saving model
              availability.
            </Callout.Text>
          </Callout.Root>
        )}
        {view === "list" && (
          <section aria-label="Configured providers" className="settings-stack">
            <Text as="p" color="gray">
              {providers.length} 個供應商
            </Text>
            <div className="provider-directory-toolbar">
              <TextField.Root
                aria-label="Search providers"
                placeholder="搜尋供應商"
                value={directoryQuery}
                onChange={(event) => setDirectoryQuery(event.target.value)}
              >
                <TextField.Slot>
                  <MagnifyingGlassIcon aria-hidden />
                </TextField.Slot>
              </TextField.Root>
              <Button disabled={busy || Boolean(oauth)} onClick={() => setView("add")}>
                Add provider
              </Button>
            </div>
            <fieldset className="scope-segments" aria-label="Provider status">
              {[
                ["all", "全部"],
                ["configured", "已設定"],
                ["attention", "需處理"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={providerFilter === value}
                  onClick={() => setProviderFilter(value ?? "all")}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {!providers.length && (
              <Prose className="empty-state">
                No configured or referenced providers. Add a provider to open supported setup.
              </Prose>
            )}
            {providers.length > 0 && !visibleProviders.length && (
              <Prose className="empty-state">沒有符合條件的供應商。請調整搜尋或狀態篩選。</Prose>
            )}
            <div className="data-list provider-directory">
              {visibleProviders.map((item) => (
                <section
                  className="data-row provider-card"
                  key={item.id}
                  aria-label={`Provider ${item.id}`}
                >
                  <div className="provider-card-header">
                    <CubeIcon aria-hidden />
                    <strong>{item.name}</strong>
                    <StatusLabel tone={item.configured === false ? "warning" : "neutral"}>
                      {item.configured === null
                        ? "Credential state unknown"
                        : item.configured
                          ? "Credential configured"
                          : "Missing credential"}
                    </StatusLabel>
                  </div>
                  <dl className="provider-card-facts">
                    <div>
                      <dt>可用模型</dt>
                      <dd>{item.references.available.length} 個</dd>
                    </div>
                    <div>
                      <dt>明確政策引用</dt>
                      <dd>{item.references.chats.length} 處</dd>
                    </div>
                  </dl>
                  <div className="provider-card-footer">
                    <Prose size="2">本機憑證狀態，未驗證遠端回應</Prose>
                    <Button
                      variant="outline"
                      disabled={busy || Boolean(oauth)}
                      aria-label={`Manage provider ${item.id}`}
                      onClick={() => openProvider(item.id)}
                    >
                      管理設定 →
                    </Button>
                  </div>
                  <details className="disclosure">
                    <summary>技術識別資訊</summary>
                    <Code>{item.id}</Code>
                  </details>
                </section>
              ))}
            </div>
          </section>
        )}
        {view === "add" && (
          <section aria-label="Add provider" className="settings-stack">
            <Button
              variant="ghost"
              disabled={busy || Boolean(oauth)}
              onClick={() => setView("list")}
            >
              Back to providers
            </Button>
            <Heading as="h2" size="4">
              Add provider
            </Heading>
            <Prose>
              Open supported provider setup. Choosing a provider does not grant models, change
              defaults, or save credentials.
            </Prose>
            <TextField.Root
              aria-label="Search providers"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
            />
            <div id="provider-choice" className="data-list" tabIndex={-1}>
              {inventory.providers
                .filter((item) =>
                  `${item.id} ${item.name}`.toLowerCase().includes(providerQuery.toLowerCase()),
                )
                .map((item) => (
                  <div className="data-row" key={item.id}>
                    <Flex direction="column" gap="2">
                      <strong>{item.name}</strong>
                      <Code>{item.id}</Code>
                    </Flex>
                    <Button
                      variant="outline"
                      disabled={busy || Boolean(oauth)}
                      aria-label={`Set up provider ${item.id}`}
                      onClick={() => openProvider(item.id)}
                    >
                      Set up
                    </Button>
                  </div>
                ))}
            </div>
            {!inventory.providers.some((item) =>
              `${item.id} ${item.name}`.toLowerCase().includes(providerQuery.toLowerCase()),
            ) && <Prose>No matching providers.</Prose>}
            {onCustomEndpoint && (
              <Button
                variant="outline"
                onClick={() => {
                  if (busy || oauth) return
                  if (
                    (key || answer || draft) &&
                    !window.confirm(
                      "Replace the pending provider selection and authentication input?",
                    )
                  )
                    return
                  if (onCustomEndpoint() === false) return
                  setKey("")
                  setAnswer("")
                  setDraft({ provider: "", model: "", thinking: null })
                  setView("detail")
                }}
              >
                Add custom endpoint
              </Button>
            )}
          </section>
        )}
        <SectionActive.Provider value={sectionActive && view === "detail"}>
          <div hidden={view !== "detail"}>
            <Flex gap="3" align="center" wrap="wrap">
              <Button
                variant="ghost"
                disabled={busy || Boolean(oauth)}
                onClick={() => setView("list")}
              >
                Back to providers
              </Button>
              <Heading as="h2" size="5" id="provider-detail-heading" tabIndex={-1}>
                {selected?.name ?? (provider || "Custom endpoint")}
              </Heading>
              {provider && <Code>{provider}</Code>}
            </Flex>
            <SettingsSection
              title="Connection"
              description="Credentials and endpoint configuration are separate from model availability and policy use."
            >
              {selected && (
                <div className="provider-readiness" data-attention={!selected.configured}>
                  <StatusLabel tone={selected.configured ? "neutral" : "warning"}>
                    {selected.configured ? "Credential configured" : "Missing credential"}
                  </StatusLabel>
                  <Prose size="2">Remote acceptance is not checked.</Prose>
                </div>
              )}
              {provider && !selected && (
                <Text as="p" color="orange" mt="3">
                  The selected provider {provider} is not in the loaded catalog. Its policy
                  references are retained. Review its endpoint configuration or return to the
                  provider list; no replacement is selected automatically.
                </Text>
              )}

              {selected && (
                <details
                  key={provider}
                  className="provider-authentication"
                  open={
                    authDetails?.provider === provider ? authDetails.open : !selected.configured
                  }
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
                                  ? "Credentials are configured locally. Remote acceptance was not checked; no model output was generated."
                                  : "Credentials are not available locally. Check provider setup.",
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
                              Replace model references first. Ambient environment credentials are
                              not removed.
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
                              Remote verification: Not checked. Local credential checks do not
                              verify remote acceptance.
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
              {connection?.(provider)}
            </SettingsSection>
            <SettingsSection
              title="Models"
              description="Add models to global availability. Shared defaults and chat overrides do not change."
            >
              {selected ? (
                <>
                  <SearchChoice
                    label="Model"
                    value={model}
                    disabled={Boolean(oauth) || busy}
                    options={selected.models.map((m) => ({
                      id: m.id,
                      label: m.name,
                      detail: m.id,
                    }))}
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
                      <section className="provider-save">
                        <AlertDialog.Root>
                          <AlertDialog.Trigger>
                            <Button
                              mt="3"
                              disabled={
                                blocked ||
                                !thinkingValid ||
                                !modelChanged ||
                                custom?.enabled === false
                              }
                            >
                              Save model availability
                            </Button>
                          </AlertDialog.Trigger>
                          <AlertDialog.Content>
                            <AlertDialog.Title>Save model selection?</AlertDialog.Title>
                            <AlertDialog.Description>
                              Add {ref} to availability. Keep the current bot default. Active work
                              will be cancelled.
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

              {availability?.(provider)}
            </SettingsSection>
            <SettingsSection
              title="Usage policy references"
              description="Saved policy references, not verified running chats. Inheriting chats are not counted."
            >
              <Prose>
                Shared model: {references.sharedModel ?? "No reference to this provider"}. Shared
                allowed-model references: {references.sharedAllowed.length}. Explicit chat policy
                references: {references.chats.length} (including disabled entries).
              </Prose>
              {references.chats.length > 0 && (
                <ul aria-label="Explicit chat policy references">
                  {references.chats.map((entry) => (
                    <li key={entry.id}>
                      Chat {entry.id}
                      {entry.enabled ? "" : " (disabled)"}: model {entry.model ?? "Inherit"}
                      {"; "}
                      allowed models{" "}
                      {entry.models?.join(", ") || (entry.models === null ? "Inherit" : "None")}
                      {"; "}
                      thinking {entry.thinking ?? "Inherit"}
                    </li>
                  ))}
                </ul>
              )}
              <Flex gap="2" wrap="wrap" align="center">
                <Button variant="outline" onClick={onDefaults}>
                  Edit shared default
                </Button>
                {chat && onChat && (
                  <Button variant="outline" onClick={onChat}>
                    Back to chat {chat}
                  </Button>
                )}
              </Flex>
              <Prose size="2">
                Set model use in Shared defaults or the chat editor. Adding availability does not
                change either selection.
              </Prose>
            </SettingsSection>
          </div>
        </SectionActive.Provider>
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
