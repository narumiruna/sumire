import { effectivePolicy } from "@narumitw/sumire-policy"
import { ArrowLeftIcon, DotsHorizontalIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons"
import {
  Button,
  Callout,
  Code,
  DataList,
  DropdownMenu,
  Flex,
  Heading,
  Tabs,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { Activity, type AuditEntry } from "./activity.js"
import type { Inventory, Policy, Snapshot } from "./api.js"
import { ChatCards } from "./chat-cards.js"
import { type ChatDirectory, chatName } from "./chat-directory.js"
import { type ChatRepair, chatState } from "./chat-state.js"
import { type EditorTarget, focusEditor, navigationHref } from "./navigation.js"
import { policyChanges, withChatAccess } from "./policy-changes.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"
import { SectionActive } from "./sections.js"
import { Panel, Prose } from "./surfaces.js"
import { permissionResult } from "./tool-permissions.js"

export type { Chat } from "@narumitw/sumire-contracts"
export { chatName } from "./chat-directory.js"

function ChatFact({
  label,
  children,
  detail,
  action,
}: {
  label: string
  children: ReactNode
  detail?: ReactNode
  action?: ReactNode
}) {
  return (
    <DataList.Item>
      <DataList.Label>{label}</DataList.Label>
      <DataList.Value>
        <Flex
          className="chat-fact-value"
          justify="between"
          align="start"
          gap="3"
          wrap="wrap"
          width="100%"
        >
          <div>
            {children}
            {detail && (
              <Text as="span" size="1" color="gray" className="chat-fact-detail">
                {detail}
              </Text>
            )}
          </div>
          {action}
        </Flex>
      </DataList.Value>
    </DataList.Item>
  )
}

export function ChatWorkspace({
  directory,
  chat,
  busy,
  detailsRequest,
  editorRequest,
  onSelect,
  policy,
  savedPolicy,
  application,
  inventory,
  onAccess,
  onApplication,
  onProviders,
  onTools,
  onDurable,
  onPolicyChange,
  audit,
  onAudit,
  children,
}: {
  directory: ChatDirectory
  chat: string
  busy: boolean
  detailsRequest: number
  editorRequest?: EditorTarget
  onSelect(value: string): void
  policy: Policy
  savedPolicy: Policy
  application: Pick<Snapshot, "revision" | "applied" | "status">
  inventory: Inventory
  onAccess(): void
  onApplication(): void
  onProviders(provider: string): void
  onTools(): void
  onDurable(): void
  onPolicyChange(value: Policy): void
  audit: AuditEntry[]
  onAudit(): void
  children: ReactNode
}) {
  const active = useContext(SectionActive)
  const [actionsOpen, setActionsOpen] = useState(false)
  const { selected: metadataState } = directory
  const [chatDraft, setChatDraft] = useState(chat)
  useEffect(() => setChatDraft(chat), [chat])
  const validDraft = /^-?[1-9]\d*$/.test(chatDraft) && Number.isSafeInteger(Number(chatDraft))
  const [tab, setTab] = useState("overview")
  const [showDirectory, setShowDirectory] = useState(!chat)
  useEffect(() => {
    if (!active || showDirectory) setActionsOpen(false)
  }, [active, showDirectory])
  useEffect(() => setShowDirectory(!chat), [chat])
  const directoryRef = useRef<HTMLElement>(null)
  const directoryScroll = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLHeadingElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const handledDetailsRequest = useRef(0)
  useEffect(() => {
    if (!active || !chat || handledDetailsRequest.current === detailsRequest) return
    handledDetailsRequest.current = detailsRequest
    setShowDirectory(false)
    const frame = requestAnimationFrame(() => {
      if (headerRef.current?.checkVisibility()) headerRef.current.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, chat, detailsRequest])
  const focusedDirectory = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (!active || focusedDirectory.current === showDirectory) return
    const initial = focusedDirectory.current === undefined
    focusedDirectory.current = showDirectory
    if (initial && showDirectory) return
    if (showDirectory) {
      const selected = directoryRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
      const target = selected ?? searchRef.current
      target?.focus({ preventScroll: true })
      window.scrollTo({ top: directoryScroll.current, behavior: "instant" })
    } else headerRef.current?.focus()
  }, [active, showDirectory])
  const changeTab = (value: string) => {
    setTab(value)
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-view="${value}"]`)?.focus()
  }
  const [repairRequest, setRepairRequest] = useState<{ target: ChatRepair | "tools" }>()
  useEffect(() => {
    if (editorRequest?.chat && chat) {
      setTab("configuration")
      setShowDirectory(false)
    }
  }, [editorRequest, chat])
  useEffect(() => {
    if (!repairRequest) return
    const selector = {
      access: ".chat-access-editor h3",
      enabled: '.chat-policy-editor [role="checkbox"]',
      model: "#model-selection",
      providers: "",
      application: "",
      tools: "#chat-tools-options",
      servers: "#chat-servers-options",
      skills: "#chat-skills-options",
    }[repairRequest.target]
    if (selector) {
      const frame = requestAnimationFrame(() => focusEditor(selector))
      return () => cancelAnimationFrame(frame)
    }
  }, [repairRequest])
  const repair = (target: ChatRepair | "tools") => {
    if (target === "providers") return onProviders(saved.model?.split("/")[0] ?? "")
    if (target === "application") return onApplication()
    setTab(target === "access" ? "access" : "configuration")
    setRepairRequest({ target })
  }
  const [copyStatus, setCopyStatus] = useState({ chat: "", message: "" })
  const copyChatId = async (id = chat) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopyStatus({ chat: id, message: "Chat ID copied." })
    } catch {
      setCopyStatus({ chat: id, message: "Could not copy. Select the ID to copy it manually." })
    }
  }
  const metadata = metadataState.chat
  const detailName = metadataState.loading
    ? "Loading chat name…"
    : metadataState.error
      ? "Chat name unavailable"
      : metadata
        ? chatName(metadata)
        : "Chat name unknown"
  const valid = /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))
  const id = Number(chat)
  const effective = effectivePolicy(policy, id)
  const saved = effectivePolicy(savedPolicy, id)
  const list = id > 0 ? "privateUsers" : "groups"
  const approved = policy[list].includes(id)
  const savedApproval = savedPolicy[list].includes(id)
  const accessPending = approved !== savedApproval
  const override = policy.chats[chat]
  const state = chatState(id, savedPolicy, inventory, application)
  const primary = state.primary
  const draftState = chatState(id, policy, inventory, application)
  const provider = inventory.providers.find((p) => p.id === saved.model?.split("/")[0])
  const preview = policyChanges(savedPolicy, policy).length > 0
  const history = audit.filter((entry) => entry.target === `chat:${chat}`)
  const unavailableTools = (override?.tools ?? policy.defaults.tools ?? []).filter(
    (name) => !policy.tools.includes(name),
  )
  const showChatDetails = () => {
    directoryScroll.current = window.scrollY
    setShowDirectory(false)
  }
  const openChat = (value: string) => {
    onSelect(value)
    showChatDetails()
  }
  const configuredStatus = (
    <Text as="p" size="2" color="gray" className="chat-ready-summary">
      {state.label}. {state.reason}
    </Text>
  )
  return (
    <div
      className="chat-workspace"
      data-directory-visible={showDirectory}
      data-selected={Boolean(chat)}
    >
      <SectionActive value={active && showDirectory}>
        <aside ref={directoryRef} className="chat-directory chat-sidebar" aria-label="Find a chat">
          <ChatCards
            directory={directory}
            selected={chat}
            searchRef={searchRef}
            policy={policy}
            savedPolicy={savedPolicy}
            inventory={inventory}
            application={application}
            busy={busy}
            onOpen={(value) => openChat(String(value.id))}
            onConfigure={(value) => {
              openChat(String(value.id))
              setTab("configuration")
            }}
            onRepair={(value, target) => {
              openChat(String(value.id))
              if (target === "providers") {
                const status = chatState(value.id, savedPolicy, inventory, application)
                onProviders(status.effective.model?.split("/")[0] ?? "")
              } else repair(target)
            }}
            onChange={onPolicyChange}
          >
            <details className="configure-id">
              <summary>以聊天 ID 開啟設定</summary>
              <p>可在首次訊息前設定聊天；這不會核准存取。</p>
              <label htmlFor="chat-id">聊天 ID</label>
              <TextField.Root
                id="chat-id"
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
              />
              <Button variant="soft" disabled={!validDraft} onClick={() => openChat(chatDraft)}>
                開啟詳細資料
              </Button>
            </details>
          </ChatCards>
        </aside>
      </SectionActive>
      <SectionActive value={active && !showDirectory}>
        <section className="chat-detail" aria-label="Chat details">
          {!chat ? (
            <Panel className="chat-initial">
              <Heading size="4">Select a chat</Heading>
              <Prose color="gray">
                Choose a chat from the directory to review access, effective settings, and
                overrides. Selecting a chat does not grant access.
              </Prose>
            </Panel>
          ) : (
            <>
              <Button
                className="directory-action"
                variant="ghost"
                mb="0"
                onClick={() => setShowDirectory(true)}
              >
                <ArrowLeftIcon aria-hidden="true" />
                Back to chat directory
              </Button>
              {metadataState.error && (
                <>
                  <Text role="alert">{metadataState.error}</Text>
                  <Button variant="soft" onClick={directory.refresh}>
                    Retry chat metadata
                  </Button>
                </>
              )}
              <header className="chat-header">
                <div className="chat-identity">
                  <Heading
                    size="5"
                    className="chat-detail-name"
                    title={detailName}
                    ref={headerRef}
                    tabIndex={-1}
                  >
                    {detailName}
                  </Heading>
                  <Flex className="chat-identity-meta" gap="2" align="center" wrap="wrap">
                    <Text size="2">{metadata?.type || "Type not known"}</Text>
                    <Code size="2" variant="ghost">
                      {chat}
                    </Code>
                  </Flex>
                </div>
                <Button variant="ghost" onClick={() => void copyChatId()}>
                  Copy chat ID
                </Button>
                <DropdownMenu.Root
                  open={actionsOpen && active && !showDirectory}
                  onOpenChange={setActionsOpen}
                >
                  <DropdownMenu.Trigger>
                    <Button className="chat-actions" variant="soft" aria-label="Chat actions">
                      <DotsHorizontalIcon />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content
                    align="end"
                    onCloseAutoFocus={(event) => {
                      if (!active || showDirectory) event.preventDefault()
                    }}
                  >
                    <DropdownMenu.Item onSelect={() => void copyChatId()}>
                      Copy chat ID
                    </DropdownMenu.Item>
                    {valid && (
                      <DropdownMenu.Item asChild>
                        <a
                          href={navigationHref("Durable", chat)}
                          onKeyDownCapture={(event) => {
                            if (
                              event.key === "Enter" &&
                              (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            )
                              event.stopPropagation()
                          }}
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
                            onDurable()
                          }}
                        >
                          View conversation records
                        </a>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </header>
              <Text as="p" role="status" size="2" className="chat-copy-status">
                {copyStatus.chat === chat ? copyStatus.message : ""}
              </Text>
              {!valid ? (
                <Text as="p" role="alert">
                  Enter a valid, non-zero Telegram ID.
                </Text>
              ) : (
                <>
                  <section
                    className="chat-status"
                    aria-label="Chat setup status"
                    data-blocked={Boolean(state.primary)}
                    hidden={!state.primary && !preview && tab === "overview"}
                  >
                    {state.primary ? (
                      <Callout.Root className="chat-setup-callout" color="amber" size="1">
                        <Callout.Icon>
                          <ExclamationTriangleIcon />
                        </Callout.Icon>
                        <div className="chat-setup-body">
                          <Heading size="3">{state.label}</Heading>
                          <Text as="p" size="2">
                            {state.reason}
                          </Text>
                          {primary && (
                            <Button type="button" onClick={() => repair(primary.target)}>
                              {primary.action}
                            </Button>
                          )}
                        </div>
                      </Callout.Root>
                    ) : (
                      tab !== "overview" && configuredStatus
                    )}

                    {preview && (
                      <Text as="p" size="2" className="chat-draft-status">
                        Draft preview — not saved: {draftState.label}. {draftState.reason} Current
                        state above is unchanged.
                      </Text>
                    )}
                  </section>
                  <Tabs.Root value={tab} onValueChange={changeTab}>
                    <Tabs.List ref={tabsRef} aria-label="Selected chat views">
                      <Tabs.Trigger type="button" value="overview" data-view="overview">
                        Overview
                      </Tabs.Trigger>
                      <Tabs.Trigger type="button" value="access" data-view="access">
                        Access
                      </Tabs.Trigger>
                      <Tabs.Trigger type="button" value="configuration" data-view="configuration">
                        Model &amp; Tools
                      </Tabs.Trigger>
                      <Tabs.Trigger type="button" value="history" data-view="history">
                        History
                      </Tabs.Trigger>
                    </Tabs.List>

                    {preview && (
                      <Text className="draft-context" as="p" size="2" color="gray">
                        Unsaved preview. Authentication and connection status reflect the loaded
                        inventory.
                      </Text>
                    )}
                    {preview && (
                      <Text as="p" size="2">
                        Saved access: {saved.enabled ? "Approved and enabled" : "Blocked by policy"}{" "}
                        · Saved model: {saved.model ?? "No allowed model"}
                      </Text>
                    )}
                    <Tabs.Content
                      className="chat-view"
                      value="overview"
                      forceMount
                      hidden={tab !== "overview"}
                    >
                      <DataList.Root
                        className="chat-facts chat-overview-facts overview-settings"
                        size="2"
                      >
                        <ChatFact
                          label="Access"
                          detail={
                            effective.enabled ? undefined : (
                              <>
                                Approval {approved ? "granted" : "not granted"} · Chat{" "}
                                {override?.enabled === false ? "disabled" : "enabled"}
                              </>
                            )
                          }
                          action={
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => changeTab("access")}
                            >
                              Manage access
                            </Button>
                          }
                        >
                          {effective.enabled ? "Approved and enabled" : "Blocked by policy"}
                        </ChatFact>
                        <ChatFact
                          label="Model"
                          detail={
                            effective.sources.model === "chat"
                              ? "This chat override"
                              : "Shared default"
                          }
                          action={
                            <Button type="button" variant="ghost" onClick={() => repair("model")}>
                              Change model
                            </Button>
                          }
                        >
                          <Code variant="ghost">{effective.model ?? "No allowed model"}</Code>
                        </ChatFact>
                        <ChatFact
                          label="Tools"
                          detail={
                            effective.sources.tools === "chat"
                              ? "This chat override"
                              : "Shared default"
                          }
                          action={
                            <Button type="button" variant="ghost" onClick={() => repair("tools")}>
                              View tool permissions
                            </Button>
                          }
                        >
                          {effective.tools.length} allowed
                        </ChatFact>
                      </DataList.Root>
                      {!state.primary && configuredStatus}
                      {unavailableTools.length > 0 && (
                        <div className="blocker">
                          <Text size="2">
                            Selected tools excluded by global policy: {unavailableTools.join(", ")}
                          </Text>
                          <Button
                            type="button"
                            variant="soft"
                            onClick={() => changeTab("configuration")}
                          >
                            Review tool permissions
                          </Button>
                        </div>
                      )}
                    </Tabs.Content>
                    <Tabs.Content
                      className="chat-view"
                      value="access"
                      forceMount
                      hidden={tab !== "access"}
                    >
                      <section className="chat-access-editor">
                        <Heading as="h3" size="3" tabIndex={-1}>
                          Access for this chat
                        </Heading>
                        <Text as="p" size="2" mt="2">
                          {id > 0 ? "Private-message access" : "Group and channel access"}. Approval
                          never grants access in other chats.
                        </Text>
                        <DataList.Root className="chat-facts effective-settings" size="2">
                          <ChatFact label="Saved approval">
                            {savedApproval ? "Approved" : "Not approved"}
                          </ChatFact>
                          <ChatFact label="Draft approval">
                            {approved ? "Approved" : "Not approved"}
                          </ChatFact>
                          <ChatFact label="Policy access">
                            {effective.enabled ? "Approved and enabled" : "Blocked by policy"}
                            {override?.enabled === false
                              ? " · Chat disabled independently of approval"
                              : ""}
                          </ChatFact>
                        </DataList.Root>
                        <Text as="p" role="status">
                          {accessPending
                            ? approved
                              ? "Pending access grant"
                              : "Pending access revocation"
                            : "No pending approval change for this chat."}
                        </Text>
                        <Flex gap="3" wrap="wrap" mt="3">
                          <Button
                            color={approved ? "red" : "teal"}
                            variant={approved ? "soft" : "solid"}
                            onClick={() => onPolicyChange(withChatAccess(policy, id, !approved))}
                          >
                            {approved
                              ? "Revoke access"
                              : savedApproval
                                ? "Undo pending revocation"
                                : "Grant access"}
                          </Button>
                          {accessPending && approved && (
                            <Button
                              variant="soft"
                              onClick={() =>
                                onPolicyChange(withChatAccess(policy, id, savedApproval))
                              }
                            >
                              Undo pending grant
                            </Button>
                          )}
                          <Button variant="ghost" onClick={onAccess}>
                            Manage chat access
                          </Button>
                        </Flex>
                        <Text as="p" size="2" color="gray" mt="3">
                          These actions stage access changes for this chat only. Granting approval
                          does not enable a disabled chat or configure authentication.
                        </Text>
                      </section>
                    </Tabs.Content>
                    <Tabs.Content
                      className="chat-view"
                      value="configuration"
                      forceMount
                      hidden={tab !== "configuration"}
                    >
                      <Heading size="3">Model &amp; Tools</Heading>
                      <section className="chat-override-editor" aria-label="Chat overrides">
                        <Heading size="3" mt="4">
                          Chat overrides
                        </Heading>
                        {children}
                      </section>
                      <details className="configuration-summary">
                        <summary>Effective settings and authentication</summary>
                        <DataList.Root className="chat-facts effective-settings" size="2">
                          <ChatFact label="Effective model">
                            <Code variant="ghost">{effective.model ?? "No allowed model"}</Code> ·{" "}
                            {effective.sources.model === "chat"
                              ? "This chat override"
                              : "From shared defaults"}
                          </ChatFact>
                          <ChatFact label="Chat model override">
                            <Code variant="ghost">
                              {override?.model ?? "Inherit from defaults"}
                            </Code>
                          </ChatFact>
                          <ChatFact label="Tools">
                            {effective.tools.join(", ") || "None"} ·{" "}
                            {effective.sources.tools === "chat"
                              ? "This chat override"
                              : "From shared defaults"}
                          </ChatFact>
                          <ChatFact label="Skills">
                            {effective.skills.join(", ") || "None"} ·{" "}
                            {effective.sources.skills === "chat"
                              ? "This chat override"
                              : "From shared defaults"}
                          </ChatFact>
                          <ChatFact label="MCP servers">
                            {effective.servers.join(", ") || "None"} ·{" "}
                            {effective.sources.servers === "chat"
                              ? "This chat override"
                              : "From shared defaults"}
                          </ChatFact>
                          <ChatFact label="Thinking">
                            {effective.thinking} ·{" "}
                            {effective.sources.thinking === "chat"
                              ? "This chat override"
                              : "From shared defaults"}
                          </ChatFact>
                        </DataList.Root>
                        <Flex gap="3" wrap="wrap">
                          <Button
                            variant="soft"
                            onClick={() => onProviders(saved.model?.split("/")[0] ?? "")}
                          >
                            Manage model authentication
                          </Button>
                          <Button variant="soft" onClick={onTools}>
                            Manage tool permissions
                          </Button>
                        </Flex>
                      </details>
                      <details className="permission-details">
                        <summary>Inspect individual tool permissions</summary>
                        <Text as="p" size="2">
                          Available capabilities, configured selection, and effective permission are
                          different. Global availability limits chat choices. MCP tools also require
                          their server's permission and applicable exposure.
                        </Text>
                        <ul>
                          {[
                            ...new Set([
                              ...inventory.tools,
                              ...inventory.mcp.flatMap((server) => server.tools),
                              ...policy.tools,
                              ...(override?.tools ?? policy.defaults.tools ?? []),
                            ]),
                          ].map((name) => {
                            const result = permissionResult("tools", name, policy, inventory, {
                              selection: override ?? policy.defaults,
                              effective,
                            })
                            return (
                              <li key={name}>
                                <strong>{name}</strong> · {result.source} · Configured:{" "}
                                {result.selected ? "Allow" : "Deny"} ·{" "}
                                {result.status === "Allowed"
                                  ? "Tool permission allowed"
                                  : "Tool permission denied"}
                                {result.blocking && (
                                  <>
                                    <Text as="p" size="2">
                                      Blocking source: {result.blocking}
                                    </Text>
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        result.blockedServers.length
                                          ? repair("servers")
                                          : result.blocking === "Global policy"
                                            ? onTools()
                                            : repair("tools")
                                      }
                                    >
                                      Review blocking permission for {name}
                                    </Button>
                                  </>
                                )}
                                {inventory.toolAvailability?.[name]?.available === false && (
                                  <Text as="p" size="2">
                                    Capability unavailable:{" "}
                                    {inventory.toolAvailability[name]?.reason}
                                  </Text>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                      {!!effective.servers.length && (
                        <Panel mt="3">
                          <Heading size="2">Loaded MCP connection status</Heading>
                          <Text as="p" size="2">
                            Connection checks do not run automatically and do not grant permission.
                          </Text>
                          <ul>
                            {effective.servers.map((name) => {
                              const server = inventory.mcp.find((entry) => entry.name === name)
                              return (
                                <li key={name}>
                                  {name}:{" "}
                                  {server
                                    ? `${server.enabled === false ? "Disabled · " : ""}${server.connection}`
                                    : "Not present in loaded inventory"}
                                </li>
                              )
                            })}
                          </ul>
                        </Panel>
                      )}
                    </Tabs.Content>
                    <Tabs.Content
                      className="chat-view"
                      value="history"
                      forceMount
                      hidden={tab !== "history"}
                    >
                      <Heading size="3">Chat-targeted audit history</Heading>
                      <Text as="p" size="2" color="gray">
                        Only records explicitly targeted to this chat in the loaded audit page (up
                        to 100 records). Global policy saves are not attributed to individual chats.
                        This is not a complete chat history.
                      </Text>
                      {history.length ? (
                        <SectionErrorBoundary label="Chat history">
                          <Activity entries={history} />
                        </SectionErrorBoundary>
                      ) : (
                        <Text as="p">No chat-targeted records in the loaded audit page.</Text>
                      )}
                      <Button variant="soft" mt="3" onClick={onAudit}>
                        Open Audit
                      </Button>
                    </Tabs.Content>
                    <details className="setup-details">
                      <summary className="chat-readiness-toggle">Readiness details</summary>
                      <DataList.Root className="chat-facts effective-settings readiness" size="2">
                        <ChatFact label="Access">
                          {state.approved ? "Approved" : "Not approved"}
                        </ChatFact>
                        <ChatFact label="Chat">{state.enabled ? "Enabled" : "Disabled"}</ChatFact>
                        <ChatFact label="Configuration">
                          {!saved.model
                            ? "Setup required"
                            : state.issues.some((issue) => issue.code === "inventory") || !provider
                              ? "Unknown"
                              : provider.configured
                                ? "Configured locally"
                                : "Setup required"}
                        </ChatFact>
                        <ChatFact label="Verification">
                          Not checked — no remote model request
                        </ChatFact>
                        <ChatFact label="Application">
                          {application.status === "failed"
                            ? "Failed"
                            : application.status === "applied" &&
                                application.revision === application.applied
                              ? "Applied"
                              : "Pending"}
                        </ChatFact>
                      </DataList.Root>
                      {state.issues.slice(1).map((issue) => (
                        <div className="blocker" key={issue.code}>
                          <Text size="2">{issue.reason}</Text>
                          <Button type="button" variant="soft" onClick={() => repair(issue.target)}>
                            {issue.action}
                          </Button>
                        </div>
                      ))}
                      <Text as="p" size="2" color="gray">
                        {saved.enabled
                          ? "This chat is approved by policy."
                          : "Policy access is not allowed."}{" "}
                        Runtime availability is unchecked; policy approval does not establish
                        readiness. Authentication status comes from the loaded local inventory, not
                        a remote model request.
                      </Text>
                    </details>
                    <details className="permission-details" hidden={tab !== "overview"}>
                      <summary>Advanced settings</summary>
                      <DataList.Root className="chat-facts effective-settings" size="2">
                        <ChatFact label="Tools">
                          {effective.tools.join(", ") || "None"} ·{" "}
                          {effective.sources.tools === "chat"
                            ? "This chat override"
                            : "From shared defaults"}
                        </ChatFact>
                        <ChatFact label="Skills">
                          {effective.skills.join(", ") || "None"} ·{" "}
                          {effective.sources.skills === "chat"
                            ? "This chat override"
                            : "From shared defaults"}
                        </ChatFact>
                        <ChatFact label="MCP servers">
                          {effective.servers.join(", ") || "None"} ·{" "}
                          {effective.sources.servers === "chat"
                            ? "This chat override"
                            : "From shared defaults"}
                        </ChatFact>
                        <ChatFact label="Thinking">
                          {effective.thinking} ·{" "}
                          {effective.sources.thinking === "chat"
                            ? "This chat override"
                            : "From shared defaults"}
                        </ChatFact>
                      </DataList.Root>
                      <Text as="p" size="2">
                        Remote authentication and runtime availability are not verified here.
                        Connection checks require an explicit action.
                      </Text>
                      <Flex gap="3" wrap="wrap" mt="2">
                        <Button
                          type="button"
                          variant="soft"
                          onClick={() => onProviders(saved.model?.split("/")[0] ?? "")}
                        >
                          Manage authentication
                        </Button>
                        <Button type="button" variant="soft" onClick={onTools}>
                          Manage tool permissions
                        </Button>
                        <Button
                          type="button"
                          variant="soft"
                          onClick={() => changeTab("configuration")}
                        >
                          Review chat overrides
                        </Button>
                      </Flex>
                    </details>
                  </Tabs.Root>
                </>
              )}
            </>
          )}
        </section>
      </SectionActive>
    </div>
  )
}
