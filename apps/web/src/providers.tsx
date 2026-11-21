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
import { thinkingLabel } from "./default-model.js"
import { type MessageKey, t } from "./i18n.js"
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
    (value || t("selection.choose", { label: label.toLowerCase() }))
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
            aria-label={t("selection.choiceValue", { label, value: displayValue })}
            aria-haspopup="dialog"
          >
            <span>{displayValue}</span>
            <ChevronDownIcon aria-hidden />
          </Button>
        </Popover.Trigger>
        <Popover.Content
          className="provider-search"
          aria-label={t("selection.choose", { label: label.toLowerCase() })}
          onCloseAutoFocus={(event) => {
            // Navigation must keep focus on the destination, not a hidden trigger.
            if (!sectionActive || tabExit.current || !trigger.current?.checkVisibility())
              event.preventDefault()
          }}
        >
          <TextField.Root
            role="combobox"
            aria-label={t("selection.search", { label: label.toLowerCase() })}
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
          <div
            id={id}
            role="listbox"
            aria-label={t("selection.results", { label })}
            className="provider-options"
          >
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
              {t("selection.noMatches")}
            </Text>
          )}
        </Popover.Content>
      </Popover.Root>
    </div>
  )
}

const loginStatusKeys = {
  pending: "provider.loginPending",
  completed: "provider.loginCompleted",
  failed: "provider.loginFailed",
  cancelled: "provider.loginCancelled",
} as const

function loginStatusLabel(status?: string): string {
  return status && Object.hasOwn(loginStatusKeys, status)
    ? t(loginStatusKeys[status as keyof typeof loginStatusKeys])
    : (status ?? t("provider.loginStarting"))
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
  const [notice, setNotice] = useState<MessageKey | "">("")
  const [credentialCheck, setCredentialCheck] = useState<{
    provider: string
    status: MessageKey
    revision: number
  }>()
  const [discoveryCheck, setDiscoveryCheck] = useState<{
    provider: string
    status: MessageKey
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
      setNotice("provider.finishOperation")
      return
    }
    if (
      authRequest.provider !== provider ||
      (authRequest.model && (authRequest.model !== model || authRequest.thinking !== thinking))
    ) {
      if ((draft || key || answer || authOpen) && !window.confirm(t("provider.replacePending")))
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
            setNotice("provider.authenticated")
            setAuthOpen(false)
            // Do not overwrite policy edits made on another page during login.
            if (dirty) setNotice("provider.authenticatedDirty")
            else await run(refresh, false)
          }
        }
      } catch (error) {
        if (!stopped) {
          // Keep the login ID so the administrator can retry or cancel it.
          setNotice("provider.loginReadFailed")
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
      !window.confirm(t("provider.replacePending"))
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
            <Callout.Text>{t("provider.dirtyHelp")}</Callout.Text>
          </Callout.Root>
        )}
        {view === "list" && (
          <section aria-label={t("provider.configuredList")} className="settings-stack">
            <Text as="p" color="gray">
              {t(providers.length === 1 ? "provider.countOne" : "provider.count", {
                count: providers.length,
              })}
            </Text>
            <div className="provider-directory-toolbar">
              <TextField.Root
                aria-label={t("provider.search")}
                placeholder={t("provider.search")}
                value={directoryQuery}
                onChange={(event) => setDirectoryQuery(event.target.value)}
              >
                <TextField.Slot>
                  <MagnifyingGlassIcon aria-hidden />
                </TextField.Slot>
              </TextField.Root>
              <Button disabled={busy || Boolean(oauth)} onClick={() => setView("add")}>
                {t("provider.add")}
              </Button>
            </div>
            <fieldset className="scope-segments" aria-label={t("provider.status")}>
              {(
                [
                  ["all", "provider.all"],
                  ["configured", "provider.configured"],
                  ["attention", "provider.attention"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={providerFilter === value}
                  onClick={() => setProviderFilter(value ?? "all")}
                >
                  {t(label)}
                </button>
              ))}
            </fieldset>
            {!providers.length && <Prose className="empty-state">{t("provider.none")}</Prose>}
            {providers.length > 0 && !visibleProviders.length && (
              <Prose className="empty-state">{t("provider.noFiltered")}</Prose>
            )}
            <div className="data-list provider-directory">
              {visibleProviders.map((item) => (
                <section
                  className="data-row provider-card"
                  key={item.id}
                  aria-label={t("provider.named", { id: item.id })}
                >
                  <div className="provider-card-header">
                    <CubeIcon aria-hidden />
                    <strong>{item.name}</strong>
                    <StatusLabel tone={item.configured === false ? "warning" : "neutral"}>
                      {item.configured === null
                        ? t("provider.credentialUnknown")
                        : item.configured
                          ? t("provider.credentialConfigured")
                          : t("provider.credentialMissing")}
                    </StatusLabel>
                  </div>
                  <dl className="provider-card-facts">
                    <div>
                      <dt>{t("provider.availableModels")}</dt>
                      <dd>
                        {t(
                          item.references.available.length === 1
                            ? "provider.modelCountOne"
                            : "provider.modelCount",
                          { count: item.references.available.length },
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("provider.explicitReferences")}</dt>
                      <dd>
                        {t(
                          item.references.chats.length === 1
                            ? "provider.referenceCountOne"
                            : "provider.referenceCount",
                          { count: item.references.chats.length },
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div className="provider-card-footer">
                    <Prose size="2">{t("provider.localCredentialHelp")}</Prose>
                    <Button
                      variant="outline"
                      disabled={busy || Boolean(oauth)}
                      aria-label={t("provider.manageNamed", { id: item.id })}
                      onClick={() => openProvider(item.id)}
                    >
                      {t("provider.manage")}
                    </Button>
                  </div>
                  <details className="disclosure">
                    <summary>{t("provider.identifiers")}</summary>
                    <Code>{item.id}</Code>
                  </details>
                </section>
              ))}
            </div>
          </section>
        )}
        {view === "add" && (
          <section aria-label={t("provider.add")} className="settings-stack">
            <Button
              variant="ghost"
              disabled={busy || Boolean(oauth)}
              onClick={() => setView("list")}
            >
              {t("provider.back")}
            </Button>
            <Heading as="h2" size="4">
              {t("provider.add")}
            </Heading>
            <Prose>{t("provider.setupHelp")}</Prose>
            <TextField.Root
              aria-label={t("provider.search")}
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
                      aria-label={t("provider.setupNamed", { id: item.id })}
                      onClick={() => openProvider(item.id)}
                    >
                      {t("provider.setup")}
                    </Button>
                  </div>
                ))}
            </div>
            {!inventory.providers.some((item) =>
              `${item.id} ${item.name}`.toLowerCase().includes(providerQuery.toLowerCase()),
            ) && <Prose>{t("provider.noMatches")}</Prose>}
            {onCustomEndpoint && (
              <Button
                variant="outline"
                onClick={() => {
                  if (busy || oauth) return
                  if ((key || answer || draft) && !window.confirm(t("provider.replacePending")))
                    return
                  if (onCustomEndpoint() === false) return
                  setKey("")
                  setAnswer("")
                  setDraft({ provider: "", model: "", thinking: null })
                  setView("detail")
                }}
              >
                {t("provider.addEndpoint")}
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
                {t("provider.back")}
              </Button>
              <Heading as="h2" size="5" id="provider-detail-heading" tabIndex={-1}>
                {selected?.name ?? (provider || t("provider.customEndpoint"))}
              </Heading>
              {provider && <Code>{provider}</Code>}
            </Flex>
            <SettingsSection
              title={t("provider.connection")}
              description={t("provider.connectionHelp")}
            >
              {selected && (
                <div className="provider-readiness" data-attention={!selected.configured}>
                  <StatusLabel tone={selected.configured ? "neutral" : "warning"}>
                    {selected.configured
                      ? t("provider.credentialConfigured")
                      : t("provider.credentialMissing")}
                  </StatusLabel>
                  <Prose size="2">{t("provider.remoteUnchecked")}</Prose>
                </div>
              )}
              {provider && !selected && (
                <Text as="p" color="orange" mt="3">
                  {t("provider.catalogMissing", { provider })}
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
                  <summary id="provider-authentication">{t("provider.authentication")}</summary>
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
                            {t("provider.configureAuthentication")}
                          </Button>
                        </Dialog.Trigger>
                      ) : (
                        <Text id="provider-auth-action" tabIndex={-1} size="2">
                          {t("provider.hostCredentials")}
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
                                status: result.configured
                                  ? "model.configuredLocally"
                                  : "model.notConfigured",
                              })
                              setNotice(
                                result.configured
                                  ? "provider.localCheckPassed"
                                  : "provider.localCheckMissing",
                              )
                            } catch (error) {
                              setCredentialCheck({
                                provider,
                                revision: snapshot.revision,
                                status: "provider.checkFailed",
                              })
                              throw error
                            }
                          })
                        }
                      >
                        {t("provider.checkAuthentication")}
                      </Button>
                      {selected.configured && (
                        <AlertDialog.Root>
                          <AlertDialog.Trigger>
                            <Button variant="ghost" color="red" disabled={blocked}>
                              {t("provider.removeCredential")}
                            </Button>
                          </AlertDialog.Trigger>
                          <AlertDialog.Content>
                            <AlertDialog.Title>
                              {t("provider.removeCredentialTitle")}
                            </AlertDialog.Title>
                            <AlertDialog.Description>
                              {t("provider.removeCredentialHelp")}
                            </AlertDialog.Description>
                            <Flex gap="3" mt="4">
                              <AlertDialog.Cancel>
                                <Button variant="soft">{t("selection.cancel")}</Button>
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
                                  {t("selection.remove")}
                                </Button>
                              </AlertDialog.Action>
                            </Flex>
                          </AlertDialog.Content>
                        </AlertDialog.Root>
                      )}
                    </Flex>
                    <details className="provider-checks">
                      <summary>{t("provider.credentialChecks")}</summary>
                      <Prose size="2">{t("provider.idValue", { id: selected.id })}</Prose>
                      <DataList.Root size="2" orientation="vertical">
                        <DataList.Item>
                          <DataList.Label>{t("provider.credentialResolution")}</DataList.Label>
                          <DataList.Value>
                            <Text as="p" size="2" role="status">
                              {t("provider.localCheck", {
                                status:
                                  credentialCheck?.provider === provider &&
                                  credentialCheck.revision === snapshot.revision
                                    ? t(credentialCheck.status)
                                    : t("provider.notChecked"),
                              })}
                            </Text>
                          </DataList.Value>
                        </DataList.Item>
                        <DataList.Item>
                          <DataList.Label>{t("provider.remoteAcceptance")}</DataList.Label>
                          <DataList.Value>
                            <Text as="p" size="2">
                              {t("provider.remoteVerificationHelp")}
                            </Text>
                          </DataList.Value>
                        </DataList.Item>
                      </DataList.Root>
                      <Prose size="2" color="gray" mt="3" className="section-copy">
                        {t("provider.availabilityHelp")}
                      </Prose>
                    </details>
                  </Panel>
                </details>
              )}
              {connection?.(provider)}
            </SettingsSection>
            <SettingsSection
              title={t("model.title")}
              description={t("model.availabilityDescription")}
            >
              {selected ? (
                <>
                  <SearchChoice
                    label={t("model.label")}
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
                      {t("model.catalogRemoved")}
                    </Text>
                  )}
                  {selectedModel && (
                    <>
                      <Flex gap="2" my="3" wrap="wrap">
                        <Badge>
                          {selectedModel.reasoning ? t("model.reasoning") : t("model.noReasoning")}
                        </Badge>
                        <Badge>
                          {selectedModel.image ? t("model.imageInput") : t("model.textInput")}
                        </Badge>
                      </Flex>
                      {!thinkingValid &&
                        (supported.length > 1 || (!thinkingValid && supported.length > 0)) && (
                          <label htmlFor="provider-thinking" className="form-field">
                            {t("model.thinkingLevel")}
                            <Select.Root
                              value={thinking ?? ""}
                              onValueChange={(v) =>
                                setDraft({ provider, model, thinking: v as Selection["thinking"] })
                              }
                            >
                              <Select.Trigger
                                id="provider-thinking"
                                aria-label={t("model.thinkingLevel")}
                              />
                              <Select.Content>
                                {supported.map((level) => (
                                  <Select.Item key={level} value={level}>
                                    {thinkingLabel(level)}
                                  </Select.Item>
                                ))}
                              </Select.Content>
                            </Select.Root>
                          </label>
                        )}
                      {!thinkingValid && (
                        <Text as="p" color="orange">
                          {t("model.thinkingUnavailable")}
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
                              {t("model.saveAvailability")}
                            </Button>
                          </AlertDialog.Trigger>
                          <AlertDialog.Content>
                            <AlertDialog.Title>{t("model.saveSelectionTitle")}</AlertDialog.Title>
                            <AlertDialog.Description>
                              {t("model.saveSelectionHelp", { model: ref })}
                            </AlertDialog.Description>
                            <Flex gap="3" mt="4">
                              <AlertDialog.Cancel>
                                <Button variant="soft">{t("selection.cancel")}</Button>
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
                                      setNotice("model.selectionSaved")
                                    })
                                  }
                                >
                                  {t("selection.saveChanges")}
                                </Button>
                              </AlertDialog.Action>
                            </Flex>
                          </AlertDialog.Content>
                        </AlertDialog.Root>
                        {!blocked && !modelChanged && (
                          <Text as="p" size="2" color="gray" mt="2">
                            {t("model.selectionMatches")}
                          </Text>
                        )}
                      </section>
                    </>
                  )}
                  {custom?.baseUrl && (
                    <details className="provider-advanced">
                      <summary>{t("model.discovery")}</summary>
                      <Text as="p" size="2">
                        {t("model.discoveryHelp")}
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
                                status: "model.discoveryVerified",
                              })
                            } catch (error) {
                              setDiscoveryCheck({
                                provider,
                                revision: snapshot.revision,
                                configuration: discoveryConfiguration,
                                models: [],
                                status: "provider.checkFailed",
                              })
                              throw error
                            }
                          })
                        }
                      >
                        {t("model.discover")}
                      </Button>
                      <Text as="p" role="status">
                        {t("model.listCheck", {
                          status: t(currentDiscovery?.status ?? "provider.notChecked"),
                        })}
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
                <Prose size="2">{t("model.chooseProviderHelp")}</Prose>
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
                    {t("model.savedSelection")}
                  </Button>
                </Flex>
              )}

              {availability?.(provider)}
            </SettingsSection>
            <SettingsSection
              title={t("provider.policyReferences")}
              description={t("provider.policyReferencesHelp")}
            >
              <Prose>
                {t("provider.referenceSummary", {
                  model: references.sharedModel ?? t("provider.noReference"),
                  allowed: references.sharedAllowed.length,
                  chats: references.chats.length,
                })}
              </Prose>
              {references.chats.length > 0 && (
                <ul aria-label={t("provider.explicitChatReferences")}>
                  {references.chats.map((entry) => (
                    <li key={entry.id}>
                      {t(
                        entry.enabled ? "provider.chatReference" : "provider.disabledChatReference",
                        {
                          id: entry.id,
                          model: entry.model ?? t("selection.inherit"),
                          models:
                            entry.models?.join(", ") ||
                            (entry.models === null ? t("selection.inherit") : t("selection.none")),
                          thinking:
                            entry.thinking === null
                              ? t("selection.inherit")
                              : thinkingLabel(entry.thinking),
                        },
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Flex gap="2" wrap="wrap" align="center">
                <Button variant="outline" onClick={onDefaults}>
                  {t("model.editShared")}
                </Button>
                {chat && onChat && (
                  <Button variant="outline" onClick={onChat}>
                    {t("provider.backChat", { chat })}
                  </Button>
                )}
              </Flex>
              <Prose size="2">{t("model.policyUseHelp")}</Prose>
            </SettingsSection>
          </div>
        </SectionActive.Provider>
        {notice && (
          <Callout.Root size="1" role="status">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>{t(notice)}</Callout.Text>
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
        <Dialog.Title>
          {t("provider.connectNamed", { name: selected?.name ?? provider })}
        </Dialog.Title>
        <Dialog.Description size="2">{t("provider.credentialsHelp")}</Dialog.Description>
        {error && (
          <Text as="p" color="red" role="alert">
            {error}
          </Text>
        )}
        {method === "choose" && (
          <Flex direction="column" gap="3" mt="4">
            <Button disabled={busy} onClick={startAccount}>
              {t("provider.accountSignIn")}
            </Button>
            <Button variant="soft" disabled={busy} onClick={() => setMethod("key")}>
              {t("provider.useApiKey")}
            </Button>
          </Flex>
        )}
        {method === "key" && (
          <>
            <label htmlFor="provider-key">
              {t("provider.apiKey")}
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
                  setNotice("provider.authenticationSaved")
                })
              }
            >
              {t("provider.saveApiKey")}
            </Button>
          </>
        )}
        {method === "account" && (
          <Flex direction="column" gap="3" mt="3">
            <Text role="status">
              {t("provider.loginStatus", { status: loginStatusLabel(login?.status) })}
            </Text>
            {!oauth && (
              <Button variant="soft" disabled={busy || dirty} onClick={startAccount}>
                {t("provider.retrySignIn")}
              </Button>
            )}
            {login?.event?.message && <Text>{login.event.message}</Text>}
            {authLink && (
              <Button asChild variant="soft">
                <a href={authLink} target="_blank" rel="noopener noreferrer">
                  {t("provider.openSignIn")}
                </a>
              </Button>
            )}
            {login?.event?.userCode && (
              <Text>{t("provider.verificationCode", { code: login.event.userCode })}</Text>
            )}
            {login?.prompt && (
              <>
                <Text>{login.prompt.message}</Text>
                {login.prompt.options ? (
                  <label htmlFor="provider-answer">
                    {t("provider.loginOption")}
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
                    {t("provider.loginResponse")}
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
                  {t("provider.submitResponse")}
                </Button>
              </>
            )}
          </Flex>
        )}
        <Flex justify="end" mt="4">
          <Button variant="soft" disabled={busy} onClick={closeAuth}>
            {oauth ? t("provider.cancelLogin") : t("selection.close")}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
