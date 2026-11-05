import {
  effectivePolicy,
  inherited as inherit,
  policySchema,
  validateReferences,
} from "@narumitw/sumire-policy"
import {
  ExclamationTriangleIcon,
  ExitIcon,
  PersonIcon,
  ReloadIcon,
  UpdateIcon,
} from "@radix-ui/react-icons"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import {
  AlertDialog,
  Button,
  Callout,
  DropdownMenu,
  Flex,
  Heading,
  Text,
  Theme,
} from "@radix-ui/themes"
import { useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import "@radix-ui/themes/styles.css"
import "./styles.css"
import "./chat-cards.css"
import "./admin-design.css"
import "./reading-design.css"
import { AccessApproval } from "./access.js"
import { captureAccessLink, clearAccessLink, tabStorage } from "./access-link.js"
import { type AuditEntry, ImportHistory, type ImportReport } from "./activity.js"
import {
  ApiError,
  type Inventory,
  type Policy,
  type ProviderSettings,
  parseSnapshot,
  request,
  type Selection,
  type Snapshot,
} from "./api.js"
import { AuditHistory } from "./audit.js"
import { BrandIcon } from "./brand-icon.js"
import { ChatAccess } from "./chat-access.js"
import { ChatAccessIcon } from "./chat-cards.js"
import { ChatSelector, useChatDirectory } from "./chat-directory.js"
import { ChatWorkspace } from "./chats.js"
import { DurableInspector } from "./durable-inspector.js"
import { GithubNotifications } from "./github-notifications.js"
import { errorMessage, initializeLocale, LocalizedError, t, useLocale } from "./i18n.js"
import { LanguageSelector } from "./language-selector.js"
import { McpConnections } from "./mcp-connections.js"
import { ModelRemovalImpact } from "./model-removal-impact.js"
import {
  type EditorTarget,
  focusEditor,
  type Page,
  type PendingEditor,
  pageLabel,
  pageTitle,
  pendingEditors,
  SideNavigation,
  useNavigation,
} from "./navigation.js"
import { captureSetupLink, signInWithPasskey } from "./passkey.js"
import { policyChangeCount, policyChangeEntries, policyChanges } from "./policy-changes.js"
import { Check, Choices, Field, ModelAvailability } from "./policy-editors.js"
import { PolicyRecoveryDialog } from "./policy-recovery-dialog.js"
import { ProviderEditor } from "./provider-editor.js"
import { withModelAvailability } from "./provider-policy.js"
import { Providers } from "./providers.js"
import { RuntimeConfig } from "./runtime-config.js"
import { SaveStatus } from "./save-status.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"
import { EditorSection } from "./sections.js"
import { SharedDefaults } from "./shared-defaults.js"
import { Skills } from "./skills.js"
import { countText } from "./status-text.js"
import { PageHeader, Panel, Prose, SettingsSection } from "./surfaces.js"
import { ToolPermissions } from "./tool-permissions.js"

initializeLocale()

const accessStorage = tabStorage(window)
const initialAccess = captureAccessLink(window.location, window.history, accessStorage)
const initialSetup = captureSetupLink(window.location, window.history)
const emptyInventory: Inventory = { tools: [], providers: [], mcp: [] }
const pageDescriptions = () => ({
  Chats: undefined,
  Durable: undefined,
  Defaults: t("description.defaults"),
  "Tool permissions": t("description.tools"),
  Skills: t("description.skills"),
  "MCP connections": t("description.mcp"),
  "Model Providers": t("description.providers"),
  "Secrets & variables": t("description.secrets"),
  "GitHub mentions": t("description.github"),
  Audit: t("description.audit"),
})

function App() {
  useLocale()
  const [session, setSession] = useState<{ csrf: string; actor: string } | null | undefined>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [savedPolicy, setSavedPolicy] = useState<Policy>()
  const sessionVersion = useRef(0)
  const sessionGeneration = sessionVersion.current
  const [failedPolicySave, setFailedPolicySave] = useState<{
    base: Policy
    submitted: Policy
    revision: number
    message: Error | string
  }>()
  const [recoveryReview, setRecoveryReview] = useState<{
    base: Policy
    draft: Policy
    submitted: Policy
    revision: number
    failure: Error | string
    latest: Snapshot
  }>()
  const [refreshError, setRefreshError] = useState<Error | string>("")
  const [inventory, setInventory] = useState<Inventory>(emptyInventory)
  const runtimeGuard = useRef<(() => boolean) | undefined>(undefined)
  const [runtimePending, setRuntimePending] = useState(false)
  const [connectionRequest, setConnectionRequest] = useState(0)
  const {
    page,
    setPage: navigatePage,
    chat,
    setChat: navigateChat,
  } = useNavigation(Boolean(session && snapshot), () => runtimeGuard.current?.() ?? true)
  useEffect(() => {
    if (page !== "Secrets & variables") setConnectionRequest(0)
  }, [page])
  const [detailsRequest, setDetailsRequest] = useState(0)
  const [editorRequest, setEditorRequest] = useState<EditorTarget>()
  const setPage = (page: Page, anchor?: string) => {
    setEditorRequest(undefined)
    const accepted = navigatePage(page, anchor)
    if (accepted && page !== "Secrets & variables") setConnectionRequest(0)
    return accepted
  }
  const setChat = (chat: string) => {
    setEditorRequest(undefined)
    navigateChat(chat)
  }
  const openChat = (id: string) => {
    setChat(id)
    setPage("Chats")
    if (id) setDetailsRequest((request) => request + 1)
  }
  useEffect(() => {
    const cancel = () => setEditorRequest(undefined)
    window.addEventListener("popstate", cancel)
    return () => window.removeEventListener("popstate", cancel)
  }, [])
  const [authRequest, setAuthRequest] = useState<{
    id: number
    provider: string
    model?: string
    thinking?: Selection["thinking"]
  }>()
  const [policyReviewOpen, setPolicyReviewOpen] = useState(false)
  const openProvider = (provider: string) => {
    const selection =
      savedPolicy && effectivePolicy(savedPolicy, page === "Chats" ? Number(chat) : 0)
    setAuthRequest((previous) => ({
      id: (previous?.id ?? 0) + 1,
      provider,
      ...(selection?.model?.startsWith(`${provider}/`)
        ? {
            model: selection.model.slice(provider.length + 1),
            thinking: selection.thinking,
          }
        : {}),
    }))
    setPage("Model Providers")
  }
  const openEditor = (target: EditorTarget) => {
    if (target.chat) {
      setChat(target.chat)
      setDetailsRequest((request) => request + 1)
    }
    setPage(target.page)
    setEditorRequest({ ...target })
  }
  useEffect(() => {
    if (!editorRequest || page !== editorRequest.page) return
    const frame = requestAnimationFrame(() => {
      focusEditor(editorRequest.selector)
      setEditorRequest(undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [editorRequest, page])
  const [error, setError] = useState<Error | string>("")
  const errorText = errorMessage(error)
  const refreshErrorText = errorMessage(refreshError)
  const [busy, setBusy] = useState(false)
  const errorAlert = useRef<HTMLDivElement>(null)
  const focusError = useRef(false)
  useEffect(() => {
    if (busy || !(error || refreshError) || !focusError.current) return
    focusError.current = false
    const alert = errorAlert.current
    // Keep modal focus inside its dialog; authentication errors are also shown there.
    if (!alert || alert.closest('[aria-hidden="true"], [inert]')) return
    alert.focus({ preventScroll: true })
    alert.scrollIntoView({ block: "center", behavior: "instant" })
  }, [busy, error, refreshError])
  const [dirty, setDirty] = useState(false)
  const [accessTarget, setAccessTarget] = useState("")
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [imports, setImports] = useState<ImportReport[]>([])
  const [mcpDirty, setMcpDirty] = useState(false)
  const [providerPending, setProviderPending] = useState(false)
  const [editorPending, setEditorPending] = useState<Partial<Record<PendingEditor, boolean>>>({})
  const localPending = Object.values(editorPending).some(Boolean)
  const markPending = (key: PendingEditor, value: boolean) =>
    setEditorPending((previous) => ({ ...previous, [key]: value }))
  const pending =
    dirty ||
    mcpDirty ||
    providerPending ||
    localPending ||
    runtimePending ||
    Boolean(failedPolicySave)
  const confirmDiscard = () => !pending || window.confirm(t("app.discardLeave"))
  const [editingProvider, setEditingProvider] = useState<ProviderSettings>()
  const [endpointEditorVersion, setEndpointEditorVersion] = useState(0)
  const [toolName, setToolName] = useState("")
  const [setup, setSetup] = useState(initialSetup)
  const [accessToken, setAccessToken] = useState(initialAccess)
  const clearAccess = useCallback(() => {
    clearAccessLink(accessStorage)
    setAccessToken("")
  }, [])
  const expireSession = useCallback(() => {
    sessionVersion.current++
    setFailedPolicySave(undefined)
    setRecoveryReview(undefined)
    setRefreshError("")
    setSession(null)
    setAuthRequest(undefined)
    setPolicyReviewOpen(false)
    setEditorRequest(undefined)
    setToolName("")
    setEditingProvider(undefined)
    setMcpDirty(false)
    setProviderPending(false)
    setEditorPending({})
    setRuntimePending(false)
    setConnectionRequest(0)
    setDirty(false)
    setSnapshot(undefined)
    setSavedPolicy(undefined)
    setBusy(false)
  }, [])
  const expireInspectorSession = useCallback(() => {
    expireSession()
    setError(new LocalizedError("app.expired"))
  }, [expireSession])
  const run = useCallback(
    async (action: () => Promise<void>, focusFailure = true) => {
      const version = sessionVersion.current
      focusError.current = false
      setBusy(true)
      setError("")
      try {
        await action()
      } catch (e) {
        if (version !== sessionVersion.current) return
        if (e instanceof ApiError && e.status === 401) expireSession()
        else focusError.current = focusFailure
        setError(e instanceof Error ? e : new LocalizedError("app.failed"))
      } finally {
        if (version === sessionVersion.current) setBusy(false)
      }
    },
    [expireSession],
  )
  const refreshResources = useCallback(async () => {
    const version = sessionGeneration
    if (version !== sessionVersion.current) return
    const [i, a, reports] = await Promise.all([
      request<Inventory>("inventory"),
      request<AuditEntry[]>("audit?offset=0"),
      request<ImportReport[]>("imports"),
    ])
    if (version !== sessionVersion.current) return
    setInventory(i)
    setAudit(a)
    setImports(Array.isArray(reports) ? reports : [])
  }, [sessionGeneration])
  const load = useCallback(async () => {
    const version = sessionGeneration
    if (version !== sessionVersion.current) return
    const [s, i, a, reports] = await Promise.all([
      request<Snapshot>("settings"),
      request<Inventory>("inventory"),
      request<AuditEntry[]>("audit?offset=0"),
      request<ImportReport[]>("imports"),
    ])
    if (version !== sessionVersion.current) return
    setRefreshError("")
    setFailedPolicySave(undefined)
    setRecoveryReview(undefined)
    const parsed = parseSnapshot(s)
    setSnapshot(parsed)
    setSavedPolicy(parsed.policy)
    setInventory(i)
    setAudit(a)
    setImports(Array.isArray(reports) ? reports : [])
    setDirty(false)
  }, [sessionGeneration])
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
        setError(new LocalizedError("app.loadFailed"))
    })
  }, [])
  useEffect(() => {
    if (session) void run(load, false)
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
      <main className="session-screen">
        <Panel className="session-card" aria-busy="true">
          <BrandIcon />
          <LanguageSelector />
          <PageHeader title={t("app.title")} description={t("app.loadingSession")} />
          <Text size="2" color="gray" role="status">
            {t("app.checkingSession")}
          </Text>
        </Panel>
      </main>
    )
  if (!session)
    return (
      <main className="session-screen">
        <Panel className="session-card">
          <BrandIcon />
          <LanguageSelector />
          <PageHeader
            title={t("app.title")}
            description={setup ? t("app.registerHelp") : t("app.signInHelp")}
          />
          {!setup && <Prose>{t("app.firstVisit")}</Prose>}
          {error && (
            <Callout.Root role="alert" color="red">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>{errorText}</Callout.Text>
            </Callout.Root>
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
            {setup ? t("app.register") : t("app.signIn")}
          </Button>
        </Panel>
      </main>
    )
  if (!snapshot)
    return (
      <main className="session-screen">
        <Panel className="session-card">
          <BrandIcon />
          <LanguageSelector />
          <PageHeader title={t("app.title")} description={t("app.loadHelp")} />
          {error ? (
            <Callout.Root role="alert" color="red">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>{errorText}</Callout.Text>
            </Callout.Root>
          ) : (
            <Text role="status">{t("app.loadingSettings")}</Text>
          )}
          <Button variant="soft" onClick={() => void run(load)}>
            <ReloadIcon aria-hidden />
            {t("app.retry")}
          </Button>
        </Panel>
      </main>
    )
  const policy = snapshot.policy
  const selected = policy.chats[chat]
  return (
    <div
      className={`admin-shell reading-first${page === "Durable" ? " admin-shell-durable" : ""}${page === "Chats" ? " admin-shell-chats" : ""}`}
    >
      <SideNavigation
        page={page}
        chat={chat}
        actor={session.actor}
        onNavigate={setPage}
        account={
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button variant="ghost" aria-label={t("app.account")} disabled={busy}>
                <PersonIcon aria-hidden />
                <span className="workspace-action-label">{t("app.account")}</span>
                <DropdownMenu.TriggerIcon />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              align="end"
              aria-label={t("app.account")}
              className="account-menu"
            >
              <DropdownMenu.Label className="account-menu-actor">
                {t("app.actor", { actor: session.actor })}
              </DropdownMenu.Label>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                disabled={busy}
                onSelect={() =>
                  void run(async () => {
                    if (!confirmDiscard()) return
                    clearAccess()
                    await request("logout", session.csrf)
                    expireSession()
                  })
                }
              >
                <ExitIcon aria-hidden />
                {t("app.signOut")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        }
      />
      <main aria-busy={busy}>
        <PageHeader
          title={pageTitle(page)}
          description={pageDescriptions()[page]}
          actions={
            page !== "Durable" && (
              <Button
                variant="ghost"
                aria-label={t("app.refresh")}
                disabled={
                  busy || dirty || localPending || runtimePending || Boolean(failedPolicySave)
                }
                onClick={() => {
                  refreshChats()
                  void run(load)
                }}
              >
                <UpdateIcon aria-hidden />
                <span className="workspace-action-label">{t("app.refresh")}</span>
              </Button>
            )
          }
        />
        {(error || refreshError) && (
          <Callout.Root
            ref={errorAlert}
            tabIndex={-1}
            color="red"
            role="alert"
            className="workspace-error"
          >
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              {errorText || refreshErrorText}{" "}
              {error && (failedPolicySave ? t("app.retainedDraft") : t("app.retryHelp"))}
            </Callout.Text>
          </Callout.Root>
        )}
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
        {!(
          page === "Durable" &&
          !pending &&
          !busy &&
          snapshot.status === "applied" &&
          snapshot.revision === snapshot.applied
        ) && (
          <SaveStatus
            quiet
            snapshot={snapshot}
            reviewOpen={policyReviewOpen}
            onReviewOpenChange={setPolicyReviewOpen}
            entries={policyChangeEntries(savedPolicy ?? policy, policy)}
            changeCount={policyChangeCount(savedPolicy ?? policy, policy)}
            removalReview={<ModelRemovalImpact before={savedPolicy ?? policy} after={policy} />}
            runtimePending={runtimePending}
            modelReview={
              savedPolicy &&
              (savedPolicy.defaults.model !== policy.defaults.model ||
                JSON.stringify(savedPolicy.defaults.models) !==
                  JSON.stringify(policy.defaults.models))
                ? {
                    before: savedPolicy.defaults.model,
                    after: policy.defaults.model,
                    added: (policy.defaults.models ?? []).filter(
                      (ref) => !savedPolicy.defaults.models?.includes(ref),
                    ),
                  }
                : undefined
            }
            unfinished={(Object.keys(pendingEditors) as PendingEditor[])
              .filter((key) => editorPending[key])
              .map((key) => pendingEditors[key])}
            openEditor={openEditor}
            dirty={dirty}
            busy={busy}
            localPending={localPending || runtimePending}
            mcpDirty={mcpDirty}
            providerPending={providerPending}
            navigate={setPage}
            recover={
              failedPolicySave
                ? () =>
                    void run(async () => {
                      const version = sessionVersion.current
                      const latest = await request<Snapshot>("settings")
                      if (version !== sessionVersion.current) return
                      setRecoveryReview({
                        base: failedPolicySave.base,
                        draft: policy,
                        submitted: failedPolicySave.submitted,
                        revision: failedPolicySave.revision,
                        failure: failedPolicySave.message,
                        latest: parseSnapshot(latest),
                      })
                    })
                : undefined
            }
            apply={() =>
              void run(async () => {
                if (failedPolicySave) throw new LocalizedError("app.reviewBeforeSave")
                const submitted = policySchema.parse(policy)
                validateReferences(submitted)
                const version = sessionVersion.current
                let committed: Snapshot
                try {
                  committed = await request<Snapshot>(
                    "settings",
                    session.csrf,
                    { revision: snapshot.revision, policy: submitted },
                    "PUT",
                  )
                  committed = parseSnapshot(committed)
                  if (committed.revision <= snapshot.revision)
                    throw new LocalizedError("app.unknownSaveHelp")
                } catch (failure) {
                  if (version !== sessionVersion.current) return
                  if (!(failure instanceof ApiError && failure.status === 401))
                    setFailedPolicySave((previous) => ({
                      base: previous?.base ?? savedPolicy ?? policy,
                      submitted: previous?.submitted ?? submitted,
                      revision: previous?.revision ?? snapshot.revision,
                      message:
                        failure instanceof Error ? failure : new LocalizedError("app.unknownSave"),
                    }))
                  throw failure
                }
                if (version !== sessionVersion.current) return
                setSnapshot(committed)
                setSavedPolicy(committed.policy)
                setDirty(false)
                setFailedPolicySave(undefined)
                setRefreshError("")
                try {
                  await refreshResources()
                } catch (failure) {
                  if (version !== sessionVersion.current) return
                  if (failure instanceof ApiError && failure.status === 401) throw failure
                  focusError.current = true
                  setRefreshError(new LocalizedError("app.refreshFailed"))
                }
              })
            }
            retry={() =>
              void run(async () => {
                await request("apply", session.csrf)
                await load()
              })
            }
            discard={() => {
              if (
                window.confirm(failedPolicySave ? t("app.discardUnknown") : t("app.discardPolicy"))
              ) {
                setSnapshot({ ...snapshot, policy: savedPolicy ?? policy })
                setDirty(false)
              }
            }}
          />
        )}
        {recoveryReview && (
          <PolicyRecoveryDialog
            {...recoveryReview}
            failure={errorMessage(recoveryReview.failure)}
            onReturnFocus={() => {
              if (document.querySelector('[role="alertdialog"]')) return
              const target =
                document.getElementById("policy-recovery-trigger") ??
                document.getElementById("save-status")
              if (target?.checkVisibility()) target.focus()
            }}
            onCancel={() => {
              setRecoveryReview(undefined)
              setError(recoveryReview.failure)
            }}
            onConfirm={(recovered) => {
              const latest = recoveryReview.latest
              const hasChanges = policyChanges(latest.policy, recovered).length > 0
              setSavedPolicy(latest.policy)
              setSnapshot({ ...latest, policy: recovered })
              setDirty(hasChanges)
              setFailedPolicySave(undefined)
              setRecoveryReview(undefined)
              setError(latest.revision === recoveryReview.revision ? recoveryReview.failure : "")
              if (hasChanges) setPolicyReviewOpen(true)
            }}
          />
        )}
        <fieldset disabled={busy} className="editor-panel" aria-label={t("app.editors")}>
          <EditorSection active={page === "Chats"} aria-label={t("app.chatSettings")}>
            <ChatWorkspace
              directory={directory}
              chat={chat}
              busy={busy}
              detailsRequest={detailsRequest}
              editorRequest={editorRequest?.page === "Chats" ? editorRequest : undefined}
              onSelect={setChat}
              policy={policy}
              savedPolicy={savedPolicy ?? policy}
              application={snapshot}
              inventory={inventory}
              audit={audit}
              onPolicyChange={update}
              onAudit={() => setPage("Audit")}
              onAccess={() => {
                setAccessTarget(chat)
                openEditor({ page: "Chats", selector: "#access-id-input" })
              }}
              onApplication={() => document.getElementById("save-status")?.focus()}
              onProviders={openProvider}
              onTools={() => setPage("Tool permissions")}
              onDurable={() => setPage("Durable")}
            >
              <section className="chat-policy-editor" aria-label={t("app.chatPolicy")}>
                <Check
                  id="chat-policy-enabled"
                  label={t("app.chatEnabled")}
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
              </section>
            </ChatWorkspace>
            <details className="chat-access-management" id="chat-access-management" tabIndex={-1}>
              <summary>
                <ChatAccessIcon />
                {t("app.accessManagement")}
              </summary>
              <Heading size="3">{t("app.chatAccess")}</Heading>
              {accessTarget && (
                <Panel>
                  <Heading size="3">{t("app.chatAccessFor", { id: accessTarget })}</Heading>
                  <Prose>{t("app.accessReview")}</Prose>
                  <Button
                    variant="soft"
                    onClick={(event) => {
                      event.currentTarget.closest("details")?.removeAttribute("open")
                      openChat(accessTarget)
                    }}
                  >
                    {t("app.backChat")}
                  </Button>
                  <Button variant="ghost" onClick={() => setAccessTarget("")}>
                    {t("app.allAccess")}
                  </Button>
                </Panel>
              )}
              <ChatAccess
                policy={policy}
                saved={savedPolicy ?? policy}
                target={accessTarget}
                chats={knownChats}
                onChange={update}
                onPending={(value) => markPending("access", value)}
                onReview={() => setPolicyReviewOpen(true)}
              />
              <details className="access-intro">
                <summary>{t("app.importHistory")}</summary>
                <Prose>{t("app.importHelp")}</Prose>
                <Button variant="soft" onClick={() => setPage("Audit")}>
                  {t("app.openImports")}
                </Button>
              </details>
            </details>
          </EditorSection>
          {page === "Durable" && (
            <SectionErrorBoundary key={chat} label={t("app.inspector")}>
              <DurableInspector
                key={chat}
                chat={chat}
                chatSelector={
                  <ChatSelector title={null} directory={directory} chat={chat} onSelect={setChat} />
                }
                metadata={directory.selected.chat}
                metadataLoading={directory.selected.loading}
                metadataError={directory.selected.error}
                onMetadataRetry={directory.refresh}
                onChats={() => openChat(chat)}
                onSessionExpired={expireInspectorSession}
              />
            </SectionErrorBoundary>
          )}
          <EditorSection
            active={page === "Defaults"}
            aria-label={t("app.defaults")}
            className="admin-page--defaults"
          >
            <SharedDefaults
              policy={policy}
              saved={savedPolicy ?? policy}
              chat={chat}
              inventory={inventory}
              onChange={update}
              navigate={setPage}
              onProvider={openProvider}
            />
            <details className="defaults-advanced">
              <summary>{t("app.advanced")}</summary>
              <section className="defaults-reset" aria-label={t("app.inheritance")}>
                <AlertDialog.Root>
                  <AlertDialog.Trigger>
                    <Button
                      variant="soft"
                      disabled={
                        !Object.values(policy.chats).some((choice) =>
                          Object.keys(inherit).some(
                            (key) => choice[key as keyof Selection] !== null,
                          ),
                        )
                      }
                    >
                      {t("app.resetDefaults")}
                    </Button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Content>
                    <AlertDialog.Title>{t("app.resetConfirm")}</AlertDialog.Title>
                    <AlertDialog.Description>
                      {t("app.resetHelp", {
                        count: countText(
                          Object.values(policy.chats).filter((choice) =>
                            Object.keys(inherit).some(
                              (key) => choice[key as keyof Selection] !== null,
                            ),
                          ).length,
                          "chat has",
                          "chats have",
                        ),
                      })}
                    </AlertDialog.Description>
                    <Flex gap="3" mt="4">
                      <AlertDialog.Cancel>
                        <Button variant="soft">{t("app.cancel")}</Button>
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
                          {t("app.stageReset")}
                        </Button>
                      </AlertDialog.Action>
                    </Flex>
                  </AlertDialog.Content>
                </AlertDialog.Root>
              </section>
            </details>
          </EditorSection>
          <EditorSection active={page === "Skills"} aria-label={t("app.skills")}>
            <Skills
              policy={policy}
              saved={savedPolicy ?? policy}
              inventory={inventory}
              onChange={update}
              onChat={openChat}
            />
          </EditorSection>
          <EditorSection
            active={page === "Tool permissions"}
            aria-label={t("app.tools")}
            className="admin-page--permissions"
          >
            <ToolPermissions
              key={session.actor}
              actor={session.actor}
              selectedChat={chat}
              dirty={dirty}
              policy={policy}
              saved={savedPolicy ?? policy}
              inventory={inventory}
              onChange={update}
              onChat={(id) =>
                openEditor({ page: "Chats", chat: id, selector: "#chat-tools-options" })
              }
              defaultContext={
                page === "Tool permissions" && window.location.hash === "#default-tool-permissions"
              }
            />
            <div className="permission-footer">
              <details className="permission-manual">
                <summary>{t("app.exactTool")}</summary>
                <Panel as="fieldset">
                  <legend>{t("app.manualTool")}</legend>
                  <Field
                    id="tool-input"
                    label={t("app.additionalTool")}
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
                    {t("app.addTool")}
                  </Button>
                  {toolName && (
                    <Button
                      variant="soft"
                      onClick={() => {
                        setToolName("")
                        markPending("tool", false)
                      }}
                    >
                      {t("app.clearTool")}
                    </Button>
                  )}
                  <Prose size="2">{t("app.exactToolHelp")}</Prose>
                </Panel>
              </details>
              <Button variant="soft" onClick={() => setPage("MCP connections")}>
                {t("app.manageMcp")}
              </Button>
            </div>
          </EditorSection>
          <EditorSection
            active={page === "MCP connections"}
            aria-label={pageLabel("MCP connections")}
            className="admin-page--mcp"
          >
            <McpConnections
              inventory={inventory}
              policy={policy}
              snapshot={snapshot}
              csrf={session.csrf}
              busy={busy}
              dirty={dirty || Boolean(failedPolicySave)}
              localPending={localPending}
              mcpDirty={mcpDirty}
              secretPending={Boolean(editorPending.secret)}
              setMcpDirty={setMcpDirty}
              markPending={markPending}
              onTools={() => setPage("Tool permissions")}
              run={run}
              load={load}
            />
          </EditorSection>
          <EditorSection
            active={page === "Model Providers"}
            aria-label={t("app.providers")}
            className="admin-page--providers"
          >
            <Providers
              snapshot={snapshot}
              inventory={inventory}
              csrf={session.csrf}
              dirty={dirty || mcpDirty || localPending || Boolean(failedPolicySave)}
              busy={busy}
              run={run}
              refresh={load}
              error={errorText}
              onPending={setProviderPending}
              authRequest={authRequest}
              editorTarget={
                editorRequest?.page === "Model Providers" ? editorRequest.selector : undefined
              }
              savedPolicy={savedPolicy ?? policy}
              onDefaults={() =>
                openEditor({ page: "Defaults", selector: "#default-model-selection" })
              }
              chat={chat}
              onChat={() => openEditor({ page: "Chats", chat, selector: "#model-selection" })}
              onSelectProvider={() => {
                if (!editorPending.endpoint) return true
                if (!window.confirm(t("app.discardEndpoint"))) return false
                setEditingProvider(undefined)
                setEndpointEditorVersion((version) => version + 1)
                markPending("endpoint", false)
                return true
              }}
              onCustomEndpoint={() => {
                if (editorPending.endpoint && !window.confirm(t("app.discardEndpoint")))
                  return false
                setEditingProvider(undefined)
                setEndpointEditorVersion((version) => version + 1)
                markPending("endpoint", false)
                setEditorRequest({ page: "Model Providers", selector: "#endpoint-provider-id" })
                return true
              }}
              connection={(providerId) => (
                <details className="provider-advanced">
                  <summary>{t("app.endpoint")}</summary>
                  <Prose size="2">{t("app.endpointHelp")}</Prose>
                  {policy.providers
                    .filter((p) => !providerId || p.id === providerId)
                    .map((p) => (
                      <Panel key={p.id}>
                        <Check
                          label={t("app.providerEnabled", { provider: p.id })}
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
                                window.confirm(t("app.discardEndpoint"))
                              ) {
                                setEditingProvider(p)
                                markPending("endpoint", false)
                              }
                            }}
                          >
                            {t("app.editConfig", { provider: p.id })}
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
                            {t("app.removeConfig")}
                          </Button>
                        </Flex>
                      </Panel>
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
              )}
              availability={(providerId) => (
                <SettingsSection
                  title={t("app.availability")}
                  id="model-availability"
                  tabIndex={-1}
                  description={t("app.removeModelsHelp")}
                >
                  <ModelAvailability
                    key={snapshot.revision}
                    value={policy.models}
                    provider={providerId || undefined}
                    onChange={(models) => update(withModelAvailability(policy, models))}
                  />
                  <Prose size="2">{t("app.restoreModelsHelp")}</Prose>
                  <ModelRemovalImpact before={savedPolicy ?? policy} after={policy} />
                </SettingsSection>
              )}
            />
          </EditorSection>
          <EditorSection active={page === "GitHub mentions"} aria-label={t("app.github")}>
            <GithubNotifications
              active={page === "GitHub mentions"}
              policy={policy}
              saved={savedPolicy ?? policy}
              disabled={busy || runtimePending}
              onChange={update}
              onPending={(value) => markPending("githubMentionAuthor", value)}
              onNavigate={setPage}
              onOpenConnection={() => {
                if (setPage("Secrets & variables")) setConnectionRequest((request) => request + 1)
              }}
              application={snapshot}
              onSessionExpired={expireInspectorSession}
            />
          </EditorSection>
          {page === "Secrets & variables" && (
            <EditorSection active aria-label={t("app.secrets")}>
              <RuntimeConfig
                key={sessionGeneration}
                connectionRequest={connectionRequest}
                csrf={session.csrf}
                revision={snapshot.revision}
                application={snapshot}
                blocked={
                  busy ||
                  dirty ||
                  mcpDirty ||
                  providerPending ||
                  localPending ||
                  Boolean(failedPolicySave)
                }
                onPending={setRuntimePending}
                guard={runtimeGuard}
                onSessionExpired={expireInspectorSession}
                onCommitted={(value) =>
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          revision: value.revision,
                          applied: value.applied,
                          status: value.status,
                        }
                      : current,
                  )
                }
                refresh={load}
              />
            </EditorSection>
          )}
          <EditorSection
            active={page === "Audit"}
            aria-label={t("app.audit")}
            className="admin-page--audit"
          >
            <div className="audit-workspace">
              <section className="audit-configuration" aria-label={t("app.configOperations")}>
                <Heading size="3">{t("app.configActivity")}</Heading>
                <Prose size="2">{t("app.activityHelp")}</Prose>
                <AuditHistory revision={snapshot.revision} run={run} />
              </section>
              <section className="audit-imports" aria-label={t("app.importReports")}>
                <Heading size="3">{t("app.importReports")}</Heading>
                <ImportHistory reports={imports} />
              </section>
            </div>
          </EditorSection>
        </fieldset>

        <VisuallyHidden.Root>
          <span role="status">
            {busy
              ? t("app.operation")
              : error
                ? t("app.operationError")
                : pending
                  ? t("app.pending")
                  : t("app.noPending")}
          </span>
        </VisuallyHidden.Root>
      </main>
    </div>
  )
}
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <Theme appearance="light" accentColor="teal" grayColor="sand" radius="small">
      <App />
    </Theme>,
  )
