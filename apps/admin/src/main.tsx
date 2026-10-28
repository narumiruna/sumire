import {
  effectivePolicy,
  inherited as inherit,
  policySchema,
  validateReferences,
} from "@narumitw/sumire-policy"
import {
  ExclamationTriangleIcon,
  ExitIcon,
  MixerHorizontalIcon,
  PersonIcon,
  ReloadIcon,
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
import { ChatSelector, useChatDirectory } from "./chat-directory.js"
import { ChatWorkspace } from "./chats.js"
import { DurableInspector } from "./durable-inspector.js"
import { GithubNotifications } from "./github-notifications.js"
import { McpConnections } from "./mcp-connections.js"
import {
  type EditorTarget,
  focusEditor,
  type Page,
  type PendingEditor,
  pageLabel,
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

const accessStorage = tabStorage(window)
const initialAccess = captureAccessLink(window.location, window.history, accessStorage)
const initialSetup = captureSetupLink(window.location, window.history)
const emptyInventory: Inventory = { tools: [], providers: [], mcp: [] }
const pageDescriptions = {
  Chats: "Review chat access and effective settings.",
  Durable: undefined,
  Access: "Approve private chats, groups, and channels.",
  Defaults:
    "Defaults for chats without corresponding overrides. Explicit chat overrides stay unchanged.",
  "Tool permissions": "Manage global, default, and chat permissions.",
  Skills: "Manage skill instructions for defaults and individual chats.",
  "MCP connections": "Manage connections and protected configuration.",
  "Model Providers": "Manage models and provider authentication.",
  "Secrets & variables": "Manage stored runtime values without changing tool or chat permissions.",
  "GitHub mentions": "Allow GitHub mention authors to trigger replies on GitHub.",
  Audit: "Review configuration activity and imports.",
}
function App() {
  const [session, setSession] = useState<{ csrf: string; actor: string } | null | undefined>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [savedPolicy, setSavedPolicy] = useState<Policy>()
  const sessionVersion = useRef(0)
  const sessionGeneration = sessionVersion.current
  const [failedPolicySave, setFailedPolicySave] = useState<{
    base: Policy
    submitted: Policy
    revision: number
    message: string
  }>()
  const [recoveryReview, setRecoveryReview] = useState<{
    base: Policy
    draft: Policy
    submitted: Policy
    revision: number
    failure: string
    latest: Snapshot
  }>()
  const [refreshError, setRefreshError] = useState("")
  const [inventory, setInventory] = useState<Inventory>(emptyInventory)
  const runtimeGuard = useRef<(() => boolean) | undefined>(undefined)
  const [runtimePending, setRuntimePending] = useState(false)
  const {
    page,
    setPage: navigatePage,
    chat,
    setChat: navigateChat,
  } = useNavigation(Boolean(session && snapshot), () => runtimeGuard.current?.() ?? true)
  const [detailsRequest, setDetailsRequest] = useState(0)
  const [editorRequest, setEditorRequest] = useState<EditorTarget>()
  const setPage = (page: Page, anchor?: string) => {
    setEditorRequest(undefined)
    navigatePage(page, anchor)
  }
  const setChat = (chat: string) => {
    setEditorRequest(undefined)
    navigateChat(chat)
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
  const [error, setError] = useState("")
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
    setDirty(false)
    setSnapshot(undefined)
    setSavedPolicy(undefined)
    setBusy(false)
  }, [])
  const expireInspectorSession = useCallback(() => {
    expireSession()
    setError("Administrator session expired. Sign in again.")
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
        setError(e instanceof Error ? e.message : "Operation failed")
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
        setError("Could not load administrator session")
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
          <PageHeader title="Sumire administration" description="Loading administrator session…" />
          <Text size="2" color="gray" role="status">
            Checking your administrator session.
          </Text>
        </Panel>
      </main>
    )
  if (!session)
    return (
      <main className="session-screen">
        <Panel className="session-card">
          <BrandIcon />
          <PageHeader
            title="Sumire administration"
            description={
              setup
                ? "Register your administrator passkey with your device."
                : "Use your administrator passkey to sign in."
            }
          />
          {!setup && (
            <Prose>
              First visit? Send /admin in a private chat with Sumire to get a setup link.
            </Prose>
          )}
          {error && (
            <Callout.Root role="alert" color="red">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
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
            {setup ? "Register passkey" : "Sign in with passkey"}
          </Button>
        </Panel>
      </main>
    )
  if (!snapshot)
    return (
      <main className="session-screen">
        <Panel className="session-card">
          <BrandIcon />
          <PageHeader
            title="Sumire administration"
            description="Load the saved policy and connected services."
          />
          {error ? (
            <Callout.Root role="alert" color="red">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : (
            <Text role="status">Loading settings…</Text>
          )}
          <Button variant="soft" onClick={() => void run(load)}>
            <ReloadIcon aria-hidden />
            Retry
          </Button>
        </Panel>
      </main>
    )
  const policy = snapshot.policy
  const selected = policy.chats[chat]
  return (
    <div className={`admin-shell${page === "Durable" ? " admin-shell-durable" : ""}`}>
      <SideNavigation page={page} chat={chat} actor={session.actor} onNavigate={setPage} />
      <main aria-busy={busy}>
        <PageHeader
          title={pageLabel(page)}
          description={pageDescriptions[page]}
          actions={
            <>
              {page !== "Durable" && (
                <Button
                  variant="ghost"
                  aria-label="Reload"
                  disabled={
                    busy || dirty || localPending || runtimePending || Boolean(failedPolicySave)
                  }
                  onClick={() => {
                    refreshChats()
                    void run(load)
                  }}
                >
                  <ReloadIcon />
                  <span className="workspace-action-label">Reload</span>
                </Button>
              )}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Button variant="ghost" aria-label="Account" disabled={busy}>
                    <PersonIcon aria-hidden />
                    <span className="workspace-action-label">Account</span>
                    <DropdownMenu.TriggerIcon />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" aria-label="Account" className="account-menu">
                  <DropdownMenu.Label className="account-menu-actor">
                    Administrator: {session.actor}
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
                    Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </>
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
              {error || refreshError}{" "}
              {error &&
                (failedPolicySave
                  ? "Your settings draft is retained. Load the latest settings and review it before saving again."
                  : "Review the input and retry. Check application status before repeating a saved operation.")}
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
            snapshot={snapshot}
            reviewOpen={policyReviewOpen}
            onReviewOpenChange={setPolicyReviewOpen}
            entries={policyChangeEntries(savedPolicy ?? policy, policy)}
            changeCount={policyChangeCount(savedPolicy ?? policy, policy)}
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
                if (failedPolicySave)
                  throw new Error("Load latest and review draft before another save.")
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
                    throw new Error(
                      "Save outcome is unknown. Load the latest settings before another save.",
                    )
                } catch (failure) {
                  if (version !== sessionVersion.current) return
                  if (!(failure instanceof ApiError && failure.status === 401))
                    setFailedPolicySave((previous) => ({
                      base: previous?.base ?? savedPolicy ?? policy,
                      submitted: previous?.submitted ?? submitted,
                      revision: previous?.revision ?? snapshot.revision,
                      message:
                        failure instanceof Error ? failure.message : "Save outcome is unknown",
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
                  setRefreshError(
                    "Settings were saved, but related data could not be refreshed. Check application status, then Reload to refresh related data without repeating the save.",
                  )
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
                window.confirm(
                  failedPolicySave
                    ? "Discard local policy edits? The save outcome still needs review. This does not undo a save. Load the latest settings to check it."
                    : "Discard pending policy edits? Other editor drafts stay unchanged.",
                )
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
        <fieldset disabled={busy} className="editor-panel" aria-label="Configuration editors">
          <EditorSection active={page === "Chats"} aria-label="Chat settings">
            <ChatWorkspace
              directory={directory}
              chat={chat}
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
                setPage("Access")
              }}
              onApplication={() => document.getElementById("save-status")?.focus()}
              onProviders={openProvider}
              onTools={() => setPage("Tool permissions")}
              onDurable={() => setPage("Durable")}
            >
              <section className="chat-policy-editor" aria-label="Chat policy settings">
                <Check
                  id="chat-policy-enabled"
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
              </section>
            </ChatWorkspace>
          </EditorSection>
          {page === "Durable" && (
            <SectionErrorBoundary key={chat} label="Durable inspector">
              <DurableInspector
                key={chat}
                chat={chat}
                chatSelector={
                  <section className="durable-chat-selector" aria-label="Find a chat">
                    <details open={!chat}>
                      <summary aria-label="Find or switch chat">
                        <MixerHorizontalIcon aria-hidden />
                        <span className="durable-action-label">
                          {chat ? "Switch chat" : "Choose a chat"}
                        </span>
                      </summary>
                      <ChatSelector
                        title={null}
                        directory={directory}
                        chat={chat}
                        onSelect={setChat}
                      />
                    </details>
                  </section>
                }
                metadata={directory.selected.chat}
                metadataLoading={directory.selected.loading}
                metadataError={directory.selected.error}
                onMetadataRetry={directory.refresh}
                onChats={() => setPage("Chats")}
                onSessionExpired={expireInspectorSession}
              />
            </SectionErrorBoundary>
          )}
          <EditorSection
            active={page === "Access"}
            aria-label="Access settings"
            className="admin-page--access"
          >
            {accessTarget && (
              <Panel>
                <Heading size="3">Access for chat {accessTarget}</Heading>
                <Prose>
                  Review its access entry below. If approval is missing, add this ID to the
                  appropriate list.
                </Prose>
                <Button variant="soft" onClick={() => setPage("Chats")}>
                  Back to chat details
                </Button>
                <Button variant="ghost" onClick={() => setAccessTarget("")}>
                  Show all access entries
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
              <summary>Imported IDs and review history</summary>
              <Prose>
                Import history never grants access or reverses a revocation. No imported ID is
                approved automatically.
              </Prose>
              <Button variant="soft" onClick={() => setPage("Audit")}>
                Open import history in Audit
              </Button>
            </details>
          </EditorSection>
          <EditorSection
            active={page === "Defaults"}
            aria-label="Shared defaults"
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
              <summary>Advanced actions</summary>
              <section className="defaults-reset" aria-label="Default inheritance">
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
                      Reset all chats to inherit defaults
                    </Button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Content>
                    <AlertDialog.Title>
                      Reset all chat overrides to inherit defaults?
                    </AlertDialog.Title>
                    <AlertDialog.Description>
                      {countText(
                        Object.values(policy.chats).filter((choice) =>
                          Object.keys(inherit).some(
                            (key) => choice[key as keyof Selection] !== null,
                          ),
                        ).length,
                        "chat has",
                        "chats have",
                      )}{" "}
                      explicit overrides in the policy draft. Clear tool, MCP server, skill, allowed
                      model, model, and thinking overrides for all chats, including chats outside
                      the current page. Explicit empty lists will also inherit Defaults. Chat access
                      and enabled switches stay unchanged. Future chats already inherit Defaults.
                      This stages edits only; use Review and save changes to apply them.
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
              </section>
            </details>
          </EditorSection>
          <EditorSection active={page === "Skills"} aria-label="Skills">
            <Skills
              policy={policy}
              saved={savedPolicy ?? policy}
              inventory={inventory}
              onChange={update}
              onChat={(id) => {
                setChat(id)
                setPage("Chats")
                setDetailsRequest((request) => request + 1)
              }}
            />
          </EditorSection>
          <EditorSection
            active={page === "Tool permissions"}
            aria-label="Tool permissions"
            className="admin-page--permissions"
          >
            <Callout.Root color="orange">
              <Callout.Text>
                Shell and file tools are not sandboxed. They can access process-readable
                credentials.
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
            <div className="permission-footer">
              <details className="permission-manual">
                <summary>Approve an exact tool name</summary>
                <Panel as="fieldset">
                  <legend>Manual tool approval</legend>
                  <Field
                    id="tool-input"
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
                  {toolName && (
                    <Button
                      variant="soft"
                      onClick={() => {
                        setToolName("")
                        markPending("tool", false)
                      }}
                    >
                      Clear tool input
                    </Button>
                  )}
                  <Prose size="2">
                    Enter an exact tool name even if discovery is unavailable. This stages global
                    approval only; default and chat permissions remain unchanged.
                  </Prose>
                </Panel>
              </details>
              <Button variant="soft" onClick={() => setPage("MCP connections")}>
                Manage MCP Servers
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
            aria-label="Model providers"
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
              error={error}
              onPending={setProviderPending}
              authRequest={authRequest}
              savedPolicy={savedPolicy ?? policy}
              onDefaults={() =>
                openEditor({ page: "Defaults", selector: "#default-model-selection" })
              }
              chat={chat}
              onChat={() => openEditor({ page: "Chats", chat, selector: "#model-selection" })}
              onModelUse={(next) => {
                update(next)
                setPolicyReviewOpen(true)
              }}
            />
            <SettingsSection
              title="Manage model availability"
              id="model-availability"
              tabIndex={-1}
              description="Removing a model also removes it from shared and chat allowed-model lists. Matching shared model and thinking defaults are cleared. Matching chat model and thinking overrides reset to shared defaults. Review and save to apply."
            >
              <ModelAvailability
                key={snapshot.revision}
                value={policy.models}
                onChange={(models) => update(withModelAvailability(policy, models))}
              />
              <Prose size="2">
                Selecting a model again restores availability only. Discard settings changes to undo
                removal. Selecting a provider never grants its full catalog.
              </Prose>
            </SettingsSection>
            <details className="provider-advanced">
              <summary>Custom endpoint</summary>
              <Prose size="2">
                Use this only for a compatible endpoint that is not in the provider catalog. Save
                its configuration above before authentication. Costs are unknown, not verified
                zero-cost.
              </Prose>
              {policy.providers.map((p) => (
                <Panel key={p.id}>
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
          </EditorSection>
          <EditorSection active={page === "GitHub mentions"} aria-label="GitHub mentions">
            <GithubNotifications
              policy={policy}
              saved={savedPolicy ?? policy}
              disabled={busy || runtimePending}
              onChange={update}
              onPending={(value) => markPending("githubMentionAuthor", value)}
              onNavigate={setPage}
            />
          </EditorSection>
          {page === "Secrets & variables" && (
            <EditorSection active aria-label="Secrets & variables">
              <RuntimeConfig
                key={sessionGeneration}
                csrf={session.csrf}
                revision={snapshot.revision}
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
            aria-label="Audit history"
            className="admin-page--audit"
          >
            <div className="audit-workspace">
              <section className="audit-configuration" aria-label="Configuration operations">
                <Heading size="3">Configuration activity</Heading>
                <Prose size="2">
                  Latest configuration operations. Field-level changes were not recorded. Secret
                  values and conversation contents are excluded.
                </Prose>
                <AuditHistory revision={snapshot.revision} run={run} />
              </section>
              <section className="audit-imports" aria-label="Import reports">
                <Heading size="3">Import reports</Heading>
                <ImportHistory reports={imports} />
              </section>
            </div>
          </EditorSection>
        </fieldset>

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
    <Theme appearance="light" accentColor="teal" grayColor="sand" radius="small">
      <App />
    </Theme>,
  )
