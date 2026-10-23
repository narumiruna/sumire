import { effectivePolicy, inherited as inherit } from "@narumitw/sumire-policy"
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
import { useCallback, useEffect, useState } from "react"
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
  request,
  type Selection,
  type Snapshot,
} from "./api.js"
import { AuditHistory } from "./audit.js"
import { ChatSelector, useChatDirectory } from "./chat-directory.js"
import { ChatWorkspace } from "./chats.js"
import { DurableInspector } from "./durable-inspector.js"
import { McpConnections } from "./mcp-connections.js"
import {
  type EditorTarget,
  focusEditor,
  navigationHref,
  type PendingEditor,
  pageLabel,
  pendingEditors,
  SideNavigation,
  useNavigation,
} from "./navigation.js"
import { captureSetupLink, signInWithPasskey } from "./passkey.js"
import { policyChangeEntries, policyChanges } from "./policy-changes.js"
import { Check, Choices, Field, IdList, ModelAvailability } from "./policy-editors.js"
import { ProviderEditor } from "./provider-editor.js"
import { Providers } from "./providers.js"
import { SaveStatus } from "./save-status.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"
import { EditorSection } from "./sections.js"
import { Skills } from "./skills.js"
import { countText } from "./status-text.js"
import { PageHeader, Panel, Prose } from "./surfaces.js"
import { defaultPermissionSummary, ToolPermissions } from "./tool-permissions.js"

const accessStorage = tabStorage(window)
const initialAccess = captureAccessLink(window.location, window.history, accessStorage)
const initialSetup = captureSetupLink(window.location, window.history)
const emptyInventory: Inventory = { tools: [], providers: [], mcp: [] }
const pageDescriptions = {
  Chats: "Review chat access and effective settings.",
  Durable: undefined,
  Access: "Approve private chats, groups, and channels.",
  Defaults: "Set shared settings and inheritance.",
  "Tool permissions": "Manage global, default, and chat permissions.",
  Skills: "Manage skill instructions for defaults and individual chats.",
  "MCP connections": "Manage connections and protected configuration.",
  "Model Providers": "Manage models and provider authentication.",
  Audit: "Review configuration activity and imports.",
}
function App() {
  const [session, setSession] = useState<{ csrf: string; actor: string } | null | undefined>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [savedPolicy, setSavedPolicy] = useState<Policy>()
  const [inventory, setInventory] = useState<Inventory>(emptyInventory)
  const { page, setPage, chat, setChat } = useNavigation()
  const [detailsRequest, setDetailsRequest] = useState(0)
  const [editorRequest, setEditorRequest] = useState<EditorTarget>()
  const [defaultModelRequest, setDefaultModelRequest] = useState(0)
  const openDefaultModel = () => {
    setDefaultModelRequest((request) => request + 1)
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
  const [focusRepairPage, setFocusRepairPage] = useState(0)
  useEffect(() => {
    if (focusRepairPage) document.getElementById("current-section-heading")?.focus()
  }, [focusRepairPage])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
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
  const expireSession = useCallback(() => {
    setSession(null)
    setDefaultModelRequest(0)
    setEditorRequest(undefined)
    setToolName("")
    setEditingProvider(undefined)
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
      <main className="session-screen">
        <Panel className="session-card" aria-busy="true">
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
  const changes = policyChanges(savedPolicy ?? policy, policy)
  return (
    <div className={`admin-shell${page === "Durable" ? " admin-shell-durable" : ""}`}>
      <SideNavigation page={page} chat={chat} actor={session.actor} onNavigate={setPage} />
      <main aria-busy={busy}>
        <PageHeader
          title={pageLabel(page)}
          description={pageDescriptions[page]}
          actions={
            <>
              <Button
                variant="ghost"
                aria-label="Reload"
                disabled={busy || dirty || localPending}
                onClick={() => {
                  refreshChats()
                  void run(load)
                }}
              >
                <ReloadIcon />
                <span className="workspace-action-label">Reload</span>
              </Button>
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
        {error && (
          <Callout.Root color="red" role="alert" className="workspace-error">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              {error} Review the input and retry. If settings were saved but application failed,
              reload the saved state to check it; discard policy edits only when you no longer need
              them.
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
            changes={changes}
            entries={policyChangeEntries(savedPolicy ?? policy, policy)}
            unfinished={(Object.keys(pendingEditors) as PendingEditor[])
              .filter((key) => editorPending[key])
              .map((key) => pendingEditors[key])}
            openEditor={openEditor}
            dirty={dirty}
            busy={busy}
            localPending={localPending}
            mcpDirty={mcpDirty}
            providerPending={providerPending}
            showHelp={(page !== "Audit" && page !== "Durable") || pending}
            navigate={setPage}
            apply={() =>
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
            retry={() =>
              void run(async () => {
                await request("apply", session.csrf)
                await load()
              })
            }
            discard={() => {
              if (
                window.confirm("Discard pending policy edits? Other editor drafts stay unchanged.")
              ) {
                setSnapshot({ ...snapshot, policy: savedPolicy ?? policy })
                setDirty(false)
              }
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
              onProviders={() => {
                setPage("Model Providers")
                setFocusRepairPage((request) => request + 1)
              }}
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
                        <span className="durable-action-label">Find or switch chat</span>
                      </summary>
                      <ChatSelector directory={directory} chat={chat} onSelect={setChat} />
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
            <section className="access-intro" aria-label="Access policy scope">
              <Prose>
                {countText(policy.privateUsers.length, "private user")} ·{" "}
                {countText(policy.groups.length, "group or channel", "groups or channels")} approved
                in this policy.
              </Prose>
              <Prose size="2">Private and group access are separate.</Prose>
              <details>
                <summary>Imported IDs and review history</summary>
                <Prose>
                  Import history never grants access or reverses a revocation. Review current access
                  below; no imported ID is approved automatically.
                </Prose>
                <Button variant="soft" onClick={() => setPage("Audit")}>
                  Open import history in Audit
                </Button>
              </details>
            </section>
            <div className="access-lists">
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
            </div>
          </EditorSection>
          <EditorSection
            active={page === "Defaults"}
            aria-label="Shared defaults"
            className="admin-page--defaults"
          >
            <div className="defaults-layout">
              <section
                id="default-model-settings"
                tabIndex={-1}
                className="defaults-model"
                aria-label="Default model settings"
              >
                <Heading size="3">Model and thinking defaults</Heading>
                <Prose size="2">
                  Saved model: {savedPolicy?.defaults.model ?? "Not configured"} · Thinking:{" "}
                  {savedPolicy?.defaults.thinking ?? "off"} · Allowed models:{" "}
                  {savedPolicy?.defaults.models?.join(", ") || "None"}
                </Prose>
                {JSON.stringify([
                  policy.defaults.model,
                  policy.defaults.thinking,
                  policy.defaults.models,
                ]) !==
                  JSON.stringify([
                    (savedPolicy ?? policy).defaults.model,
                    (savedPolicy ?? policy).defaults.thinking,
                    (savedPolicy ?? policy).defaults.models,
                  ]) && (
                  <Prose size="2">
                    Policy draft model: {policy.defaults.model ?? "Not configured"} · Thinking:{" "}
                    {policy.defaults.thinking ?? "off"} · Allowed models:{" "}
                    {policy.defaults.models?.join(", ") || "None"}
                  </Prose>
                )}
                <Choices
                  navigate={setPage}
                  defaults
                  onDefaultModel={openDefaultModel}
                  value={policy.defaults}
                  policy={policy}
                  effective={effectivePolicy(policy, 0)}
                  inventory={inventory}
                  onChange={(v) => update({ ...policy, defaults: v })}
                />
              </section>
              <Flex direction="column" gap="4" className="defaults-capabilities">
                <Panel className="defaults-summary">
                  <Heading size="3">Default tool permissions</Heading>
                  <Prose>
                    Applies to chats without a tool or MCP-server permission override. Explicit
                    overrides are not changed.
                  </Prose>
                  <Prose>Saved defaults: {defaultPermissionSummary(savedPolicy ?? policy)}.</Prose>
                  {dirty && (
                    <Prose>Policy draft defaults: {defaultPermissionSummary(policy)}.</Prose>
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
                </Panel>
                <Panel className="defaults-summary">
                  <Heading size="3">Default skills</Heading>
                  <Prose>
                    Saved skills:{" "}
                    {effectivePolicy(savedPolicy ?? policy, 0).skills.join(", ") || "None"}.
                  </Prose>
                  {dirty && (
                    <Prose>
                      Policy draft skills: {effectivePolicy(policy, 0).skills.join(", ") || "None"}.
                    </Prose>
                  )}
                  <Prose size="2">
                    Applies to chats without a skill override. Skills do not grant tool access.
                  </Prose>
                  <Button variant="soft" onClick={() => setPage("Skills")}>
                    Manage default skills
                  </Button>
                </Panel>
              </Flex>
            </div>
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
                      This stages edits only; use Apply policy changes to apply them.
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
              Manage Tool connections
            </Button>
          </EditorSection>
          <EditorSection
            active={page === "MCP connections"}
            aria-label="MCP connections"
            className="admin-page--mcp"
          >
            <McpConnections
              inventory={inventory}
              policy={policy}
              snapshot={snapshot}
              csrf={session.csrf}
              busy={busy}
              dirty={dirty}
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
              dirty={dirty || mcpDirty || localPending}
              busy={busy}
              run={run}
              refresh={load}
              error={error}
              onPending={setProviderPending}
              defaultModelRequest={defaultModelRequest}
            />
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
            <details className="provider-advanced">
              <summary id="model-availability">Manage model availability</summary>
              <Prose size="2">
                Add models with the provider flow above. Remove references from defaults and chats
                before removing a model. Selecting a provider never grants its full catalog.
              </Prose>
              <ModelAvailability
                key={snapshot.revision}
                value={policy.models}
                onChange={(models) => update({ ...policy, models })}
              />
            </details>
          </EditorSection>
          <EditorSection
            active={page === "Audit"}
            aria-label="Audit history"
            className="admin-page--audit"
          >
            <div className="audit-workspace">
              <section className="audit-configuration" aria-label="Configuration operations">
                <Heading size="3">Configuration activity</Heading>
                <Prose size="2">
                  Latest configuration operations. Secret values and conversation contents are
                  excluded.
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
    <Theme appearance="light" accentColor="teal" grayColor="sand" radius="medium">
      <App />
    </Theme>,
  )
