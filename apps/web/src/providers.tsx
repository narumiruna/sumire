import { Button } from "@react-spectrum/s2/Button"
import Asset3D from "@react-spectrum/s2/icons/3DAsset"
import InfoCircle from "@react-spectrum/s2/icons/InfoCircle"
import { LinkButton } from "@react-spectrum/s2/LinkButton"
import { iconStyle, style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { ToggleButton } from "@react-spectrum/s2/ToggleButton"
import {
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
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
import { focusProviderControl, ProviderConfirmation, ProviderDialog } from "./provider-spectrum.js"
import { SearchChoice } from "./search-choice.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { SectionActive } from "./sections.js"
import { Panel, Prose, SettingsSection, StatusLabel } from "./surfaces.js"

const workspaceStyles = style({
  font: "body-lg",
  color: "body",
  "--provider-notice-bg": { type: "backgroundColor", value: "gray-100" },
  "--provider-warning-bg": { type: "backgroundColor", value: "notice-subtle" },
  "--provider-warning-line": { type: "borderColor", value: "orange-900" },
  "--provider-divider": { type: "borderColor", value: "gray-300" },
  "--provider-radius": { type: "borderRadius", value: "default" },
})
const titleStyles = style({ font: "heading-sm", color: "title", margin: 0 })
const wideField = style({ width: "full", minWidth: 0 })

// InlineAlert always announces an alert. Provider notices are polite status updates.
function ProviderNotice({ children, warning }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className="provider-notice" data-tone={warning ? "warning" : undefined} role="status">
      <InfoCircle
        styles={warning ? iconStyle({ color: "notice" }) : iconStyle({ color: "neutral" })}
      />
      <Prose size="2">{children}</Prose>
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
  const authDialogId = useId()
  const authWasVisible = useRef(false)
  const authError = useRef<HTMLParagraphElement>(null)
  const authStatus = useRef<HTMLParagraphElement>(null)
  const confirmationFocus = useRef<"authentication" | "availability" | undefined>(undefined)
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
  const authVisible = authOpen && sectionActive && view === "detail"
  useEffect(() => {
    if (!sectionActive || view !== "detail") {
      authWasVisible.current = false
      confirmationFocus.current = undefined
      return
    }
    if (authVisible) {
      authWasVisible.current = true
      return
    }
    if (busy || (!authWasVisible.current && !confirmationFocus.current)) return
    const frame = requestAnimationFrame(() => {
      const restoreAuth = authWasVisible.current
      const confirmed = confirmationFocus.current
      authWasVisible.current = false
      confirmationFocus.current = undefined
      if (document.activeElement !== document.body) return
      if (restoreAuth || confirmed === "authentication") {
        if (focusProviderControl(document.getElementById("provider-auth-action"))) return
        if (focusProviderControl(document.getElementById("provider-authentication"))) return
      } else if (focusProviderControl(document.getElementById("model-availability"))) return
      focusProviderControl(document.getElementById("provider-detail-heading"))
    })
    return () => cancelAnimationFrame(frame)
  }, [authVisible, busy, sectionActive, view])
  useEffect(() => {
    if (!authVisible || document.activeElement !== document.body) return
    // Switching methods or disabling the active control while saving can move focus to body.
    const target =
      (!busy && error ? authError.current : null) ??
      (method === "account" ? authStatus.current : null) ??
      document.getElementById(authDialogId)
    focusProviderControl(target)
  }, [authDialogId, authVisible, busy, error, method])
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
    <>
      <div className={`provider-spectrum settings-stack ${workspaceStyles}`}>
        {dirty && <ProviderNotice warning>{t("provider.dirtyHelp")}</ProviderNotice>}
        {view === "list" && (
          <section aria-label={t("provider.configuredList")} className="settings-stack">
            <Prose color="gray">
              {t(providers.length === 1 ? "provider.countOne" : "provider.count", {
                count: providers.length,
              })}
            </Prose>
            <div className="provider-directory-toolbar">
              <TextField
                aria-label={t("provider.search")}
                placeholder={t("provider.search")}
                size="XL"
                styles={wideField}
                value={directoryQuery}
                onChange={setDirectoryQuery}
              />
              <Button
                variant="accent"
                size="XL"
                isDisabled={busy || Boolean(oauth)}
                onPress={() => setView("add")}
              >
                {t("provider.add")}
              </Button>
            </div>
            <fieldset className="provider-filters" aria-label={t("provider.status")}>
              {(
                [
                  ["all", "provider.all"],
                  ["configured", "provider.configured"],
                  ["attention", "provider.attention"],
                ] as const
              ).map(([value, label]) => (
                <ToggleButton
                  key={value}
                  size="XL"
                  isEmphasized
                  isSelected={providerFilter === value}
                  onChange={() => setProviderFilter(value)}
                >
                  {t(label)}
                </ToggleButton>
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
                    <Asset3D styles={iconStyle({ color: "neutral" })} />
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
                      variant="secondary"
                      fillStyle="outline"
                      size="XL"
                      isDisabled={busy || Boolean(oauth)}
                      aria-label={t("provider.manageNamed", { id: item.id })}
                      onPress={() => openProvider(item.id)}
                    >
                      {t("provider.manage")}
                    </Button>
                  </div>
                  <details className="disclosure">
                    <summary>{t("provider.identifiers")}</summary>
                    <code>{item.id}</code>
                  </details>
                </section>
              ))}
            </div>
          </section>
        )}
        {view === "add" && (
          <section aria-label={t("provider.add")} className="settings-stack">
            <Button
              variant="secondary"
              size="XL"
              isDisabled={busy || Boolean(oauth)}
              onPress={() => setView("list")}
            >
              {t("provider.back")}
            </Button>
            <h2 className={titleStyles}>{t("provider.add")}</h2>
            <Prose>{t("provider.setupHelp")}</Prose>
            <TextField
              aria-label={t("provider.search")}
              size="XL"
              styles={wideField}
              value={providerQuery}
              onChange={setProviderQuery}
            />
            <div id="provider-choice" className="data-list" tabIndex={-1}>
              {inventory.providers
                .filter((item) =>
                  `${item.id} ${item.name}`.toLowerCase().includes(providerQuery.toLowerCase()),
                )
                .map((item) => (
                  <div className="data-row" key={item.id}>
                    <div className="provider-model-facts">
                      <strong>{item.name}</strong>
                      <code>{item.id}</code>
                    </div>
                    <Button
                      variant="secondary"
                      fillStyle="outline"
                      size="XL"
                      isDisabled={busy || Boolean(oauth)}
                      aria-label={t("provider.setupNamed", { id: item.id })}
                      onPress={() => openProvider(item.id)}
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
                variant="secondary"
                fillStyle="outline"
                size="XL"
                onPress={() => {
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
            <div className="provider-controls">
              <Button
                variant="secondary"
                size="XL"
                isDisabled={busy || Boolean(oauth)}
                onPress={() => setView("list")}
              >
                {t("provider.back")}
              </Button>
              <h2 className={titleStyles} id="provider-detail-heading" tabIndex={-1}>
                {selected?.name ?? (provider || t("provider.customEndpoint"))}
              </h2>
              {provider && <code>{provider}</code>}
            </div>
            <SettingsSection title={t("provider.connection")}>
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
                <Prose color="orange" mt="3">
                  {t("provider.catalogMissing", { provider })}
                </Prose>
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
                    <div className="provider-controls">
                      {selected.apiKey || selected.oauth ? (
                        <Button
                          id="provider-auth-action"
                          variant="secondary"
                          size="XL"
                          isDisabled={blocked}
                          aria-haspopup="dialog"
                          aria-expanded={authVisible}
                          aria-controls={authVisible ? authDialogId : undefined}
                          onPress={configureAuth}
                        >
                          {t("provider.configureAuthentication")}
                        </Button>
                      ) : (
                        <span id="provider-auth-action" tabIndex={-1}>
                          {t("provider.hostCredentials")}
                        </span>
                      )}
                      <Button
                        variant="secondary"
                        fillStyle="outline"
                        size="XL"
                        isDisabled={blocked}
                        onPress={() =>
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
                        <ProviderConfirmation
                          trigger={t("provider.removeCredential")}
                          title={t("provider.removeCredentialTitle")}
                          description={t("provider.removeCredentialHelp")}
                          action={t("selection.remove")}
                          destructive
                          disabled={blocked}
                          onConfirm={() =>
                            void run(async () => {
                              await request(`providers/${provider}/credential`, csrf, {
                                key: null,
                                revision: snapshot.revision,
                              })
                              await refresh()
                              confirmationFocus.current = "authentication"
                            })
                          }
                        />
                      )}
                    </div>
                    <details className="provider-checks">
                      <summary>{t("provider.credentialChecks")}</summary>
                      <Prose size="2">{t("provider.idValue", { id: selected.id })}</Prose>
                      <dl className="provider-credential-facts">
                        <div>
                          <dt>{t("provider.credentialResolution")}</dt>
                          <dd>
                            <Prose size="2" role="status">
                              {t("provider.localCheck", {
                                status:
                                  credentialCheck?.provider === provider &&
                                  credentialCheck.revision === snapshot.revision
                                    ? t(credentialCheck.status)
                                    : t("provider.notChecked"),
                              })}
                            </Prose>
                          </dd>
                        </div>
                        <div>
                          <dt>{t("provider.remoteAcceptance")}</dt>
                          <dd>
                            <Prose size="2">{t("provider.remoteVerificationHelp")}</Prose>
                          </dd>
                        </div>
                      </dl>
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
                    <Prose color="orange">{t("model.catalogRemoved")}</Prose>
                  )}
                  {selectedModel && (
                    <>
                      <div className="provider-controls provider-model-badges">
                        <StatusLabel>
                          {selectedModel.reasoning ? t("model.reasoning") : t("model.noReasoning")}
                        </StatusLabel>
                        <StatusLabel>
                          {selectedModel.image ? t("model.imageInput") : t("model.textInput")}
                        </StatusLabel>
                      </div>
                      {!thinkingValid &&
                        (supported.length > 1 || (!thinkingValid && supported.length > 0)) && (
                          <label htmlFor="provider-thinking" className="form-field">
                            {t("model.thinkingLevel")}
                            <SectionPicker
                              value={thinking ?? ""}
                              onValueChange={(v) =>
                                setDraft({ provider, model, thinking: v as Selection["thinking"] })
                              }
                              id="provider-thinking"
                              aria-label={t("model.thinkingLevel")}
                            >
                              {supported.map((level) => (
                                <PickerOption key={level} id={level}>
                                  {thinkingLabel(level)}
                                </PickerOption>
                              ))}
                            </SectionPicker>
                          </label>
                        )}
                      {!thinkingValid && (
                        <Prose color="orange">{t("model.thinkingUnavailable")}</Prose>
                      )}
                      <section className="provider-save">
                        <ProviderConfirmation
                          trigger={t("model.saveAvailability")}
                          title={t("model.saveSelectionTitle")}
                          description={t("model.saveSelectionHelp", { model: ref })}
                          action={t("selection.saveChanges")}
                          disabled={
                            blocked || !thinkingValid || !modelChanged || custom?.enabled === false
                          }
                          onConfirm={() =>
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
                              confirmationFocus.current = "availability"
                            })
                          }
                        />
                        {!blocked && !modelChanged && (
                          <Prose size="2" color="gray">
                            {t("model.selectionMatches")}
                          </Prose>
                        )}
                      </section>
                    </>
                  )}
                  {custom?.baseUrl && (
                    <details className="provider-advanced">
                      <summary>{t("model.discovery")}</summary>
                      <Prose size="2">{t("model.discoveryHelp")}</Prose>
                      <Button
                        variant="secondary"
                        size="XL"
                        isDisabled={blocked || !custom.api?.startsWith("openai-")}
                        onPress={() =>
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
                      <Prose role="status">
                        {t("model.listCheck", {
                          status: t(currentDiscovery?.status ?? "provider.notChecked"),
                        })}
                      </Prose>
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
                <Button
                  variant="secondary"
                  size="XL"
                  isDisabled={busy || Boolean(oauth)}
                  onPress={() => {
                    setDraft(null)
                    setNotice("")
                    setDiscoveryCheck(undefined)
                  }}
                >
                  {t("model.savedSelection")}
                </Button>
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
              <div className="provider-controls">
                <Button variant="secondary" fillStyle="outline" size="XL" onPress={onDefaults}>
                  {t("model.editShared")}
                </Button>
                {chat && onChat && (
                  <Button variant="secondary" fillStyle="outline" size="XL" onPress={onChat}>
                    {t("provider.backChat", { chat })}
                  </Button>
                )}
              </div>
            </SettingsSection>
          </div>
        </SectionActive.Provider>
        {notice && <ProviderNotice>{t(notice)}</ProviderNotice>}
      </div>
      {authVisible && (
        <ProviderDialog
          id={authDialogId}
          title={t("provider.connectNamed", { name: selected?.name ?? provider })}
          description={t("provider.credentialsHelp")}
          busy={busy}
          onClose={closeAuth}
        >
          {error && (
            <p
              className={style({ color: "negative-1000" })}
              role="alert"
              tabIndex={-1}
              ref={authError}
            >
              {error}
            </p>
          )}
          {method === "choose" && (
            <div className="provider-task-fields">
              <Button variant="accent" size="XL" isDisabled={busy} onPress={startAccount}>
                {t("provider.accountSignIn")}
              </Button>
              <Button
                variant="secondary"
                size="XL"
                isDisabled={busy}
                onPress={() => setMethod("key")}
              >
                {t("provider.useApiKey")}
              </Button>
            </div>
          )}
          {method === "key" && (
            <div className="provider-task-fields">
              <TextField
                id="provider-key"
                label={t("provider.apiKey")}
                size="XL"
                styles={wideField}
                autoFocus
                isDisabled={busy}
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={setKey}
              />
              <Button
                variant="accent"
                size="XL"
                isDisabled={busy || !key || dirty}
                onPress={() =>
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
            </div>
          )}
          {method === "account" && (
            <div className="provider-task-fields">
              <p role="status" tabIndex={-1} ref={authStatus}>
                {t("provider.loginStatus", { status: loginStatusLabel(login?.status) })}
              </p>
              {!oauth && (
                <Button
                  variant="secondary"
                  size="XL"
                  isDisabled={busy || dirty}
                  onPress={startAccount}
                >
                  {t("provider.retrySignIn")}
                </Button>
              )}
              {login?.event?.message && <p>{login.event.message}</p>}
              {authLink && (
                <LinkButton
                  href={authLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="secondary"
                  size="XL"
                >
                  {t("provider.openSignIn")}
                </LinkButton>
              )}
              {login?.event?.userCode && (
                <p>{t("provider.verificationCode", { code: login.event.userCode })}</p>
              )}
              {login?.prompt && (
                <>
                  <p>{login.prompt.message}</p>
                  {login.prompt.options ? (
                    <label className="form-field" htmlFor="provider-answer">
                      {t("provider.loginOption")}
                      <SectionPicker
                        disabled={busy}
                        value={answer}
                        onValueChange={setAnswer}
                        id="provider-answer"
                        aria-label={login.prompt.message}
                      >
                        {login.prompt.options.map((v) => (
                          <PickerOption key={v.id} id={v.id}>
                            {v.label}
                          </PickerOption>
                        ))}
                      </SectionPicker>
                    </label>
                  ) : (
                    <TextField
                      id="provider-answer"
                      label={t("provider.loginResponse")}
                      size="XL"
                      styles={wideField}
                      isDisabled={busy}
                      type="password"
                      autoComplete="off"
                      value={answer}
                      onChange={setAnswer}
                    />
                  )}
                  <Button
                    variant="accent"
                    size="XL"
                    isDisabled={busy || !answer}
                    onPress={() =>
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
            </div>
          )}
          <div className="provider-controls provider-controls--end">
            <Button variant="secondary" size="XL" isDisabled={busy} onPress={closeAuth}>
              {oauth ? t("provider.cancelLogin") : t("selection.close")}
            </Button>
          </div>
        </ProviderDialog>
      )}
    </>
  )
}
