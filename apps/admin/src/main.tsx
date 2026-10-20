import { effectivePolicy, inherited as inherit } from "@narumitw/sumire-policy"
import { ExitIcon, MixerHorizontalIcon, ReloadIcon } from "@radix-ui/react-icons"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import { AlertDialog, Button, Callout, Flex, Heading, Text, Theme } from "@radix-ui/themes"
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
import { navigationHref, pageLabel, SideNavigation, useNavigation } from "./navigation.js"
import { captureSetupLink, signInWithPasskey } from "./passkey.js"
import { policyChanges } from "./policy-changes.js"
import { Check, Choices, Field, IdList, ModelAvailability } from "./policy-editors.js"
import { ProviderEditor } from "./provider-editor.js"
import { Providers } from "./providers.js"
import { SaveStatus } from "./save-status.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"
import { EditorSection } from "./sections.js"
import { countText } from "./status-text.js"
import { Panel, Prose } from "./surfaces.js"
import { defaultPermissionSummary, ToolPermissions } from "./tool-permissions.js"

const accessStorage = tabStorage(window)
const initialAccess = captureAccessLink(window.location, window.history, accessStorage)
const initialSetup = captureSetupLink(window.location, window.history)
const emptyInventory: Inventory = { tools: [], providers: [], mcp: [] }
function App() {
  const [session, setSession] = useState<{ csrf: string; actor: string } | null | undefined>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [savedPolicy, setSavedPolicy] = useState<Policy>()
  const [inventory, setInventory] = useState<Inventory>(emptyInventory)
  const { page, setPage, chat, setChat } = useNavigation()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [accessTarget, setAccessTarget] = useState("")
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [imports, setImports] = useState<ImportReport[]>([])
  const [mcpDirty, setMcpDirty] = useState(false)
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
  const expireSession = useCallback(() => {
    setSession(null)
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
        <Panel>
          <Heading>Sumire administration</Heading>
          <Prose>
            {setup
              ? "Register your administrator passkey with your device."
              : "Use your administrator passkey to sign in."}
          </Prose>
          {!setup && (
            <Prose>
              First visit? Send /admin in a private chat with Sumire to get a setup link.
            </Prose>
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
        </Panel>
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
  return (
    <div className={`admin-shell${page === "Durable" ? " admin-shell-durable" : ""}`}>
      <SideNavigation page={page} chat={chat} actor={session.actor} onNavigate={setPage} />
      <main aria-busy={busy}>
        <header className="workspace-header">
          {page === "Durable" ? (
            <Heading size="6" id="current-section-heading" tabIndex={-1}>
              {pageLabel(page)}
            </Heading>
          ) : (
            <Text size="2" color="gray">
              Administration / {pageLabel(page)}
            </Text>
          )}
          <Flex gap="2">
            <Button
              variant="soft"
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
            <Button
              variant="soft"
              aria-label="Sign out"
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
              <span className="workspace-action-label">Sign out</span>
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
        {page !== "Durable" && (
          <Heading size="6" id="current-section-heading" tabIndex={-1} mb="3">
            {pageLabel(page)}
          </Heading>
        )}
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
              <Panel>
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
              </Panel>
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
          <EditorSection active={page === "Access"} aria-label="Access settings">
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
            <Prose>
              {countText(policy.privateUsers.length, "private user")} ·{" "}
              {countText(policy.groups.length, "group or channel", "groups or channels")}
              approved in the policy draft.
            </Prose>
            <Prose>
              Private-message approval does not grant access in any group. Import history never
              grants access or reverses a revocation.
            </Prose>
            <details>
              <summary>Imported IDs and review history</summary>
              <Prose>
                Read-only history is available in Audit. Review current access below; no imported ID
                is approved automatically.
              </Prose>
              <Button variant="soft" onClick={() => setPage("Audit")}>
                Open import history in Audit
              </Button>
            </details>
            <Prose size="2">Private and group access are separate.</Prose>
            <Prose size="2">
              Search all entries in each access list by ID or loaded chat name. Names for chats on
              other pages may not be loaded.
            </Prose>
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
            <Prose>
              Review shared defaults below. Chat overrides take priority within global availability;
              defaults do not approve access.
            </Prose>
            <Prose size="2">
              Reset is unavailable when all chats already inherit defaults. During a save,
              configuration controls are unavailable.
            </Prose>
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
                  {countText(
                    Object.values(policy.chats).filter((choice) =>
                      Object.keys(inherit).some((key) => choice[key as keyof Selection] !== null),
                    ).length,
                    "chat has",
                    "chats have",
                  )}{" "}
                  explicit overrides in the policy draft. Clear tool, MCP server, allowed model,
                  model, and thinking overrides for all chats, including chats outside the current
                  page. Explicit empty lists will also inherit Defaults. Chat access and enabled
                  switches stay unchanged. Future chats already inherit Defaults. This stages edits
                  only; use Apply policy changes to apply them.
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
            <Panel>
              <Heading size="3">Default tool permissions</Heading>
              <Prose>
                Applies to chats without a tool or MCP-server permission override. Explicit
                overrides are not changed.
              </Prose>
              <Prose>Saved defaults: {defaultPermissionSummary(savedPolicy ?? policy)}.</Prose>
              {dirty && <Prose>Policy draft defaults: {defaultPermissionSummary(policy)}.</Prose>}
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
            <Prose size="2">
              Enter an exact tool name even if discovery is unavailable. This stages global approval
              only; default and chat permissions remain unchanged.
            </Prose>
            <Button variant="soft" onClick={() => setPage("MCP connections")}>
              Manage MCP connections
            </Button>
          </EditorSection>
          <EditorSection active={page === "MCP connections"} aria-label="MCP connections">
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
          <EditorSection active={page === "Model Providers"} aria-label="Model providers">
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
              <summary>Manage model availability</summary>
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
          <EditorSection active={page === "Audit"} aria-label="Audit history">
            <Prose>
              Latest configuration operations. Secret values and conversation contents are excluded.
            </Prose>
            <Heading size="3">Import reports</Heading>
            <ImportHistory reports={imports} />
            <Heading size="3">Configuration activity</Heading>
            <AuditHistory revision={snapshot.revision} run={run} />
          </EditorSection>
        </fieldset>
        {localPending && (
          <Prose role="status">
            An editor has unfinished input. Add, stage, or clear it before saving settings. It is
            not included in policy changes yet.
          </Prose>
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
    <Theme appearance="light" accentColor="teal" grayColor="slate" radius="medium">
      <App />
    </Theme>,
  )
