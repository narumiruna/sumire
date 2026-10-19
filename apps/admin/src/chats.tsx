import type { Chat } from "@narumitw/sumire-contracts"
import { effectivePolicy } from "@narumitw/sumire-policy"
import {
  Button,
  DataList,
  Flex,
  Heading,
  Link,
  SegmentedControl,
  Spinner,
  Tabs,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Activity, type AuditEntry } from "./activity.js"
import type { Inventory, Policy } from "./api.js"
import { type ChatDirectory, ChatSelector, chatName } from "./chat-directory.js"
import { navigationHref } from "./navigation.js"
import { policyChanges, withChatAccess } from "./policy-changes.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"
import { StatusBadge } from "./semantic-status.js"
import { EmptyState, Panel } from "./surfaces.js"

export type { Chat } from "@narumitw/sumire-contracts"
export { chatName } from "./chat-directory.js"

function chatType(chat: Chat) {
  if (chat.type === "supergroup") return "group"
  return ["private", "group", "channel"].includes(chat.type) ? chat.type : "unknown"
}

export function ChatWorkspace({
  directory,
  chat,
  onSelect,
  policy,
  savedPolicy,
  application,
  inventory,
  onAccess,
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
  onSelect(value: string): void
  policy: Policy
  savedPolicy: Policy
  application: string
  inventory: Inventory
  onAccess(): void
  onProviders(): void
  onTools(): void
  onDurable(): void
  onPolicyChange(value: Policy): void
  audit: AuditEntry[]
  onAudit(): void
  children: ReactNode
}) {
  const { chats, selected: metadataState } = directory
  const [chatDraft, setChatDraft] = useState(chat)
  useEffect(() => setChatDraft(chat), [chat])
  const validDraft = /^-?[1-9]\d*$/.test(chatDraft) && Number.isSafeInteger(Number(chatDraft))
  const [type, setType] = useState("all")
  const [access, setAccess] = useState("all")
  const [tab, setTab] = useState("overview")
  const [showDirectory, setShowDirectory] = useState(!chat)
  const directoryRef = useRef<HTMLElement>(null)
  const directoryScroll = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const directory = directoryRef.current
    const main = directory?.closest("main")
    const workspace = directory?.parentElement
    const header = directory?.querySelector<HTMLElement>(".directory-header")
    const footer = directory?.querySelector<HTMLElement>(".directory-footer")
    const list = directory?.querySelector<HTMLElement>(".directory-list-region")
    if (!directory || !main || !workspace || !header || !footer || !list) return
    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!directory.getClientRects().length) return
        // Measure the non-sticky workspace so document scrolling does not change the bound.
        const top = workspace.getBoundingClientRect().top + window.scrollY
        const start = `${top}px`
        if (directory.style.getPropertyValue("--directory-start") !== start)
          directory.style.setProperty("--directory-start", start)
        const rowHeight = Array.from(
          directory.querySelectorAll<HTMLElement>(".chat-list button"),
        ).reduce((height, row) => Math.max(height, row.offsetHeight), 0)
        const listStyle = getComputedStyle(list)
        const minimumHeight =
          header.offsetHeight +
          footer.offsetHeight +
          rowHeight +
          Number.parseFloat(listStyle.paddingTop) +
          Number.parseFloat(listStyle.paddingBottom)
        const availableHeight =
          window.innerHeight - top - Number.parseFloat(getComputedStyle(main).paddingBottom)
        // Keep at least one full row usable when content above the workspace is tall.
        directory.dataset.naturalScroll = String(availableHeight < minimumHeight)
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(main)
    observer.observe(header)
    observer.observe(footer)
    window.addEventListener("resize", resize)
    resize()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", resize)
    }
  }, [])
  const headerRef = useRef<HTMLHeadingElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!window.matchMedia("(max-width: 850px)").matches) return
    if (showDirectory) {
      const selected =
        directoryRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')
      const target = selected ?? searchRef.current
      target?.focus({ preventScroll: true })
      window.scrollTo({ top: directoryScroll.current, behavior: "instant" })
    } else headerRef.current?.focus()
  }, [showDirectory])
  const changeTab = (value: string) => {
    setTab(value)
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-view="${value}"]`)?.focus()
  }
  const [copyStatus, setCopyStatus] = useState({ chat: "", message: "" })
  const filtered = chats.filter(
    (c) =>
      (type === "all" || chatType(c) === type) &&
      (access === "all" || effectivePolicy(policy, c.id).enabled === (access === "allowed")),
  )
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
  const configuredModel = override?.model ?? policy.defaults.model
  const provider = inventory.providers.find((p) => p.id === effective.model?.split("/")[0])
  const preview = policyChanges(savedPolicy, policy).length > 0
  const history = audit.filter((entry) => entry.target === `chat:${chat}`)
  const unavailableTools = (override?.tools ?? policy.defaults.tools ?? []).filter(
    (name) => !policy.tools.includes(name),
  )
  const blockers = [
    ...(!approved
      ? [
          {
            text: "Access approval is missing.",
            action: "Review access approval",
            run: () => changeTab("access"),
          },
        ]
      : []),
    ...(override?.enabled === false
      ? [
          {
            text: "The chat is disabled.",
            action: "Review chat enabled switch",
            run: () => changeTab("configuration"),
          },
        ]
      : []),
    ...(!effective.model
      ? [
          {
            text: configuredModel
              ? `Configured model ${configuredModel} is not effective. Review allowed models and provider availability.`
              : "No effective model configured.",
            action: "Configure model",
            run: () => changeTab("configuration"),
          },
        ]
      : []),
    ...(effective.model && provider && !provider.configured
      ? [
          {
            text: "Model authentication is not configured.",
            action: "Configure authentication",
            run: onProviders,
          },
        ]
      : []),
  ]
  const showChatDetails = () => {
    if (window.matchMedia("(max-width: 850px)").matches) directoryScroll.current = window.scrollY
    setShowDirectory(false)
  }
  const openChat = (value: string) => {
    onSelect(value)
    showChatDetails()
  }
  return (
    <div
      className="chat-workspace"
      data-directory-visible={showDirectory}
      data-selected={Boolean(chat)}
    >
      <aside ref={directoryRef} className="chat-directory" aria-label="Find a chat">
        <ChatSelector
          directory={directory}
          chat={chat}
          onSelect={openChat}
          searchRef={searchRef}
          title="Chat directory"
          visibleChats={filtered}
          filters={
            <>
              <div className="directory-filters">
                <div>
                  <Text as="div" size="2">
                    Chat type
                  </Text>
                  <SegmentedControl.Root
                    className="directory-segments"
                    aria-label="Chat type"
                    value={type}
                    onValueChange={setType}
                  >
                    <SegmentedControl.Item value="all" aria-label="All types">
                      All
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="private" aria-label="Private">
                      Private
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="group" aria-label="Group / supergroup">
                      Groups
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="channel" aria-label="Channel">
                      Channels
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="unknown" aria-label="Unknown type">
                      Unknown
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>
                <div>
                  <Text as="div" size="2">
                    Access status
                  </Text>
                  <SegmentedControl.Root
                    className="directory-segments"
                    aria-label="Access status"
                    value={access}
                    onValueChange={setAccess}
                  >
                    <SegmentedControl.Item value="all" aria-label="All access">
                      All
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="allowed" aria-label="Approved and enabled">
                      Approved
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="denied" aria-label="Not approved or disabled">
                      Blocked
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </div>
              </div>
              {(directory.query || type !== "all" || access !== "all") && (
                <Button
                  color="gray"
                  variant="ghost"
                  onClick={() => {
                    directory.setQuery("")
                    setType("all")
                    setAccess("all")
                  }}
                >
                  Clear search and filters
                </Button>
              )}
              <details className="directory-help">
                <summary>Search scope and access labels</summary>
                <Text as="p" size="1" color="gray">
                  Search covers stored chats. Type and access filters cover this page only. Access
                  labels show {preview ? "the policy draft" : "saved policy"}, not verified runtime
                  readiness. Names reflect observed Telegram metadata; ID-only records have no known
                  name.
                </Text>
              </details>
            </>
          }
          badge={(c) => {
            const list = c.id > 0 ? "privateUsers" : "groups"
            const approved = policy[list].includes(c.id)
            const pending = approved !== savedPolicy[list].includes(c.id)
            return (
              <Flex gap="1" wrap="wrap">
                <StatusBadge status={approved ? "approved" : "disabled"}>
                  {approved ? "Approved" : "Not approved"}
                  {preview ? " · Draft" : ""}
                </StatusBadge>
                {policy.chats[String(c.id)]?.enabled === false && <StatusBadge status="disabled" />}
                {pending && (
                  <StatusBadge status="pending">
                    {approved ? "Grant pending" : "Revocation pending"}
                  </StatusBadge>
                )}
              </Flex>
            )
          }}
          footer={
            <>
              <Button
                color="gray"
                className="mobile-directory-action"
                variant="soft"
                mt="3"
                disabled={!chat}
                style={{ visibility: chat ? undefined : "hidden" }}
                onClick={showChatDetails}
              >
                Show selected chat
              </Button>
              <details className="configure-id">
                <summary>Configure a chat before its first message</summary>
                <Text as="p" size="2">
                  This creates settings, not access approval.
                </Text>
                <label htmlFor="chat-id">
                  Chat ID (can configure before first message)
                  <TextField.Root
                    id="chat-id"
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                  />
                </label>
                <Button
                  color="gray"
                  variant="soft"
                  disabled={!validDraft}
                  onClick={() => openChat(chatDraft)}
                >
                  Open chat details
                </Button>
              </details>
            </>
          }
        />
      </aside>
      <section className="chat-detail" aria-label="Chat details">
        {!chat ? (
          <EmptyState
            className="chat-initial"
            title="Select a chat"
            description="Choose a chat from the directory to review access, effective settings, and overrides. Selecting a chat does not grant access."
          />
        ) : (
          <>
            <Button
              color="gray"
              className="mobile-directory-action"
              variant="ghost"
              mb="3"
              onClick={() => setShowDirectory(true)}
            >
              Back to chat directory
            </Button>
            {metadataState.error && (
              <>
                <Text className="error-state" data-status="failed" role="alert">
                  {metadataState.error}
                </Text>
                <Button color="gray" variant="soft" onClick={directory.refresh}>
                  Retry chat metadata
                </Button>
              </>
            )}
            <header className="chat-header">
              <div>
                <Heading
                  size="5"
                  className="chat-detail-name"
                  title={detailName}
                  ref={headerRef}
                  tabIndex={-1}
                >
                  {metadataState.loading && <Spinner aria-hidden="true" mr="2" />}
                  {detailName}
                </Heading>
                <Text size="2" color="gray">
                  {metadata?.type || "Type not known"} · <code>{chat}</code>
                </Text>
                {valid && (
                  <Flex gap="2" wrap="wrap" mt="2">
                    <StatusBadge status={approved ? "approved" : "disabled"}>
                      {approved ? "Approved" : "Not approved"}
                    </StatusBadge>
                    {override?.enabled === false && <StatusBadge status="disabled" />}
                    {accessPending && (
                      <StatusBadge status="pending">
                        {approved ? "Grant pending" : "Revocation pending"}
                      </StatusBadge>
                    )}
                  </Flex>
                )}
              </div>
              <Flex gap="2" align="center" wrap="wrap">
                {valid && (
                  <Button color="gray" variant="soft" asChild>
                    <Link
                      color="gray"
                      href={navigationHref("Durable", chat)}
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
                      Inspect Durable
                    </Link>
                  </Button>
                )}
                <Button
                  color="gray"
                  variant="surface"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(chat)
                      setCopyStatus({ chat, message: "Chat ID copied." })
                    } catch {
                      setCopyStatus({
                        chat,
                        message: "Could not copy. Select the ID to copy it manually.",
                      })
                    }
                  }}
                >
                  Copy chat ID
                </Button>
              </Flex>
            </header>
            <Text as="p" className="copy-confirmation" role="status" size="2">
              {copyStatus.chat === chat ? copyStatus.message : ""}
            </Text>
            {!valid ? (
              <Text as="p" className="error-state" data-status="failed" role="alert">
                Enter a valid, non-zero Telegram ID.
              </Text>
            ) : (
              <>
                <section
                  className="chat-status"
                  aria-label="Chat setup status"
                  data-blocked={blockers.length > 0}
                >
                  <Heading size="3">
                    {blockers.length
                      ? `Setup required${blockers.length > 1 ? `: ${blockers.length} blockers` : ""}`
                      : "Runtime status unchecked"}
                  </Heading>
                  {blockers.map((blocker) => (
                    <div className="blocker" key={blocker.text}>
                      <Text size="2">{blocker.text}</Text>
                      <Button color="gray" type="button" variant="soft" onClick={blocker.run}>
                        {blocker.action}
                      </Button>
                    </div>
                  ))}
                  <details className="setup-details">
                    <summary>Readiness details</summary>
                    <DataList.Root
                      className="effective-settings readiness"
                      orientation="horizontal"
                    >
                      <DataList.Item>
                        <DataList.Label>Access</DataList.Label>
                        <DataList.Value>
                          <StatusBadge status={savedApproval ? "approved" : "disabled"}>
                            {savedApproval ? "Approved" : "Not approved"}
                          </StatusBadge>
                          {accessPending && (
                            <StatusBadge status="pending">
                              Draft: {approved ? "Approved" : "Not approved"}
                            </StatusBadge>
                          )}
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Chat</DataList.Label>
                        <DataList.Value>
                          <StatusBadge
                            status={override?.enabled === false ? "disabled" : "approved"}
                          >
                            {override?.enabled === false ? "Disabled" : "Enabled"}
                          </StatusBadge>
                          {preview ? " · Policy draft" : ""}
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Configuration</DataList.Label>
                        <DataList.Value>
                          <StatusBadge
                            status={
                              effective.model && provider?.configured ? "approved" : "unknown"
                            }
                          >
                            {!provider
                              ? "Unknown"
                              : effective.model && provider.configured
                                ? "Configured locally"
                                : "Setup required"}
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Verification</DataList.Label>
                        <DataList.Value>
                          <StatusBadge status="unknown">
                            Not checked — no remote model request
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Application</DataList.Label>
                        <DataList.Value>{application}</DataList.Value>
                      </DataList.Item>
                    </DataList.Root>
                    <Text as="p" size="2" color="gray">
                      {effective.enabled
                        ? "This chat is approved by policy."
                        : "Policy access is not allowed."}{" "}
                      {effective.model && provider?.configured
                        ? "Configured locally; remote authentication not checked here."
                        : "Remote authentication not checked here."}{" "}
                      Runtime availability is unchecked; policy approval does not establish
                      readiness.
                    </Text>
                    <Text as="p" size="2">
                      Approval and the chat enabled switch are independent. Model availability
                      follows global policy and chat settings. Authentication status comes from the
                      loaded local inventory, not a remote model request.
                    </Text>
                  </details>
                  {effective.model && !provider && (
                    <Flex gap="2" align="center" wrap="wrap" mt="2">
                      <Text size="2">
                        Configuration status unknown; remote authentication not checked here.
                      </Text>
                      <Button color="gray" type="button" variant="soft" onClick={onProviders}>
                        Review authentication configuration
                      </Button>
                    </Flex>
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
                  <Text className="draft-context" as="p" size="2" color="gray">
                    {preview ? "Policy draft preview — not yet saved." : "Saved policy."}{" "}
                    Authentication and MCP status reflect the loaded inventory.
                  </Text>
                  {preview && (
                    <Text as="p" size="2">
                      Saved access: {saved.enabled ? "Approved and enabled" : "Blocked by policy"} ·
                      Saved model: {saved.model ?? "No allowed model"}
                    </Text>
                  )}
                  <Tabs.Content value="overview" forceMount hidden={tab !== "overview"}>
                    <Heading size="3" mb="3">
                      Effective settings
                    </Heading>
                    <DataList.Root className="overview-settings" orientation="horizontal">
                      <DataList.Item align="center">
                        <DataList.Label>Access</DataList.Label>
                        <DataList.Value>
                          <Flex gap="3" align="center" justify="between" wrap="wrap" width="100%">
                            <div>
                              {effective.enabled ? "Approved and enabled" : "Blocked by policy"}
                              <small>
                                Approval {approved ? "granted" : "not granted"} · Chat{" "}
                                {override?.enabled === false ? "disabled" : "enabled"}
                              </small>
                            </div>
                            <Button
                              color="gray"
                              type="button"
                              variant="ghost"
                              onClick={() => changeTab("access")}
                            >
                              Manage access
                            </Button>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item align="center">
                        <DataList.Label>Model</DataList.Label>
                        <DataList.Value>
                          <Flex gap="3" align="center" justify="between" wrap="wrap" width="100%">
                            <div>
                              {effective.model ?? "No allowed model"}
                              <small>
                                <StatusBadge
                                  status={
                                    effective.sources.model === "chat" ? "overridden" : "inherited"
                                  }
                                >
                                  {effective.sources.model === "chat"
                                    ? "Chat override"
                                    : "Shared default"}
                                </StatusBadge>
                              </small>
                            </div>
                            <Button
                              color="gray"
                              type="button"
                              variant="ghost"
                              onClick={() => changeTab("configuration")}
                            >
                              Change model
                            </Button>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item align="center">
                        <DataList.Label>Tools</DataList.Label>
                        <DataList.Value>
                          <Flex gap="3" align="center" justify="between" wrap="wrap" width="100%">
                            <div>
                              {effective.tools.length} allowed
                              <small>
                                <StatusBadge
                                  status={
                                    effective.sources.tools === "chat" ? "overridden" : "inherited"
                                  }
                                >
                                  {effective.sources.tools === "chat"
                                    ? "Explicit override"
                                    : "Inherited"}
                                </StatusBadge>
                              </small>
                            </div>
                            <Button
                              color="gray"
                              type="button"
                              variant="ghost"
                              onClick={() => changeTab("configuration")}
                            >
                              View tool permissions
                            </Button>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                    </DataList.Root>
                    {unavailableTools.length > 0 && (
                      <div className="blocker">
                        <Text size="2">
                          Selected tools excluded by global policy: {unavailableTools.join(", ")}
                        </Text>
                        <Button
                          color="gray"
                          type="button"
                          variant="soft"
                          onClick={() => changeTab("configuration")}
                        >
                          Review tool permissions
                        </Button>
                      </div>
                    )}
                    <details className="permission-details">
                      <summary>Advanced configuration / Check details</summary>
                      <DataList.Root className="effective-settings" orientation="horizontal">
                        <DataList.Item>
                          <DataList.Label>Tools</DataList.Label>
                          <DataList.Value>
                            {effective.tools.join(", ") || "None"} ·{" "}
                            <StatusBadge
                              status={
                                effective.sources.tools === "chat" ? "overridden" : "inherited"
                              }
                            >
                              {effective.sources.tools === "chat"
                                ? "Explicit override"
                                : "Inherited"}
                            </StatusBadge>
                          </DataList.Value>
                        </DataList.Item>
                        <DataList.Item>
                          <DataList.Label>MCP servers</DataList.Label>
                          <DataList.Value>
                            {effective.servers.join(", ") || "None"} ·{" "}
                            <StatusBadge
                              status={
                                effective.sources.servers === "chat" ? "overridden" : "inherited"
                              }
                            >
                              {effective.sources.servers === "chat"
                                ? "Explicit override"
                                : "Inherited"}
                            </StatusBadge>
                          </DataList.Value>
                        </DataList.Item>
                        <DataList.Item>
                          <DataList.Label>Thinking</DataList.Label>
                          <DataList.Value>
                            {effective.thinking} ·{" "}
                            <StatusBadge
                              status={
                                effective.sources.thinking === "chat" ? "overridden" : "inherited"
                              }
                            >
                              {effective.sources.thinking === "chat"
                                ? "Explicit override"
                                : "Inherited"}
                            </StatusBadge>
                          </DataList.Value>
                        </DataList.Item>
                      </DataList.Root>
                      <Text as="p" size="2">
                        Remote authentication and runtime availability are not verified here.
                        Connection checks require an explicit action.
                      </Text>
                      <Flex gap="3" wrap="wrap" mt="2">
                        <Button color="gray" type="button" variant="soft" onClick={onProviders}>
                          Manage authentication
                        </Button>
                        <Button color="gray" type="button" variant="soft" onClick={onTools}>
                          Manage tool permissions
                        </Button>
                        <Button
                          color="gray"
                          type="button"
                          variant="soft"
                          onClick={() => changeTab("configuration")}
                        >
                          Review chat overrides
                        </Button>
                      </Flex>
                    </details>
                  </Tabs.Content>
                  <Tabs.Content value="access" forceMount hidden={tab !== "access"}>
                    <Panel>
                      <Heading size="3">Access for this chat</Heading>
                      <Text as="p" size="2" mt="2">
                        {id > 0 ? "Private-message access" : "Group and channel access"}. Approval
                        never grants access in other chats.
                      </Text>
                      <DataList.Root className="effective-settings" orientation="horizontal">
                        <DataList.Item>
                          <DataList.Label>Saved approval</DataList.Label>
                          <DataList.Value>
                            <StatusBadge status={savedApproval ? "approved" : "disabled"}>
                              {savedApproval ? "Approved" : "Not approved"}
                            </StatusBadge>
                          </DataList.Value>
                        </DataList.Item>
                        <DataList.Item>
                          <DataList.Label>Draft approval</DataList.Label>
                          <DataList.Value>
                            <StatusBadge
                              status={
                                accessPending ? "pending" : approved ? "approved" : "disabled"
                              }
                            >
                              {approved ? "Approved" : "Not approved"}
                            </StatusBadge>
                          </DataList.Value>
                        </DataList.Item>
                        <DataList.Item>
                          <DataList.Label>Policy access</DataList.Label>
                          <DataList.Value>
                            {effective.enabled ? "Approved and enabled" : "Blocked by policy"}
                            {override?.enabled === false
                              ? " · Chat disabled independently of approval"
                              : ""}
                          </DataList.Value>
                        </DataList.Item>
                      </DataList.Root>
                      <Text as="p" role="status">
                        {accessPending ? (
                          <StatusBadge status="pending">
                            {approved ? "Pending access grant" : "Pending access revocation"}
                          </StatusBadge>
                        ) : (
                          "No pending approval change for this chat."
                        )}
                      </Text>
                      <Flex gap="3" wrap="wrap" mt="3">
                        <Button
                          color={approved ? "red" : "gray"}
                          variant="soft"
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
                            color="gray"
                            variant="soft"
                            onClick={() =>
                              onPolicyChange(withChatAccess(policy, id, savedApproval))
                            }
                          >
                            Undo pending grant
                          </Button>
                        )}
                        <Button color="gray" variant="ghost" onClick={onAccess}>
                          Open global Access
                        </Button>
                      </Flex>
                      <Text as="p" size="2" color="gray" mt="3">
                        These actions stage access changes for this chat only. Granting approval
                        does not enable a disabled chat or configure authentication.
                      </Text>
                    </Panel>
                  </Tabs.Content>
                  <Tabs.Content value="configuration" forceMount hidden={tab !== "configuration"}>
                    <Heading size="3">Model &amp; Tools</Heading>
                    <DataList.Root className="effective-settings" orientation="horizontal">
                      <DataList.Item>
                        <DataList.Label>Effective model</DataList.Label>
                        <DataList.Value>
                          {effective.model ?? "No allowed model"} ·{" "}
                          <StatusBadge
                            status={effective.sources.model === "chat" ? "overridden" : "inherited"}
                          >
                            {effective.sources.model === "chat"
                              ? "Chat override"
                              : "Shared default"}
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Chat model override</DataList.Label>
                        <DataList.Value>
                          <StatusBadge status={override?.model ? "overridden" : "inherited"}>
                            {override?.model ?? "Inherit from defaults"}
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Tools</DataList.Label>
                        <DataList.Value>
                          {effective.tools.join(", ") || "None"} ·{" "}
                          <StatusBadge
                            status={effective.sources.tools === "chat" ? "overridden" : "inherited"}
                          >
                            {effective.sources.tools === "chat" ? "Explicit override" : "Inherited"}
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>MCP servers</DataList.Label>
                        <DataList.Value>
                          {effective.servers.join(", ") || "None"} ·{" "}
                          <StatusBadge
                            status={
                              effective.sources.servers === "chat" ? "overridden" : "inherited"
                            }
                          >
                            {effective.sources.servers === "chat"
                              ? "Explicit override"
                              : "Inherited"}
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.Label>Thinking</DataList.Label>
                        <DataList.Value>
                          {effective.thinking} ·{" "}
                          <StatusBadge
                            status={
                              effective.sources.thinking === "chat" ? "overridden" : "inherited"
                            }
                          >
                            {effective.sources.thinking === "chat"
                              ? "Explicit override"
                              : "Inherited"}
                          </StatusBadge>
                        </DataList.Value>
                      </DataList.Item>
                    </DataList.Root>
                    <Flex gap="3" wrap="wrap">
                      <Button color="gray" variant="soft" onClick={onProviders}>
                        Manage model authentication
                      </Button>
                      <Button color="gray" variant="soft" onClick={onTools}>
                        Manage tool permissions
                      </Button>
                    </Flex>
                    <Heading size="3" mt="4">
                      Chat overrides
                    </Heading>
                    {children}
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
                            ...policy.tools,
                            ...(override?.tools ?? policy.defaults.tools ?? []),
                          ]),
                        ].map((name) => (
                          <li key={name}>
                            <strong>{name}</strong> ·{" "}
                            {inventory.tools.includes(name)
                              ? "In loaded inventory"
                              : "Not in loaded inventory"}{" "}
                            ·{" "}
                            {policy.tools.includes(name)
                              ? "Globally available"
                              : "Excluded by global policy"}{" "}
                            ·{" "}
                            {(override?.tools ?? policy.defaults.tools ?? []).includes(name)
                              ? "Selected"
                              : "Not selected"}{" "}
                            ·{" "}
                            {effective.tools.includes(name)
                              ? "Tool permission allowed"
                              : "Tool permission denied"}
                          </li>
                        ))}
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
                                {server ? (
                                  <>
                                    {server.enabled === false && (
                                      <StatusBadge status="disabled">Disabled · </StatusBadge>
                                    )}
                                    <StatusBadge
                                      status={
                                        server.connection === "failed"
                                          ? "failed"
                                          : server.connection === "connected"
                                            ? "approved"
                                            : "unknown"
                                      }
                                    >
                                      {server.connection}
                                    </StatusBadge>
                                  </>
                                ) : (
                                  <StatusBadge status="unknown">
                                    Not present in loaded inventory
                                  </StatusBadge>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </Panel>
                    )}
                  </Tabs.Content>
                  <Tabs.Content value="history" forceMount hidden={tab !== "history"}>
                    <Heading size="3">Chat-targeted audit history</Heading>
                    <Text as="p" size="2" color="gray">
                      Only records explicitly targeted to this chat in the loaded audit page (up to
                      100 records). Global policy saves are not attributed to individual chats. This
                      is not a complete chat history.
                    </Text>
                    {history.length ? (
                      <SectionErrorBoundary label="Chat history">
                        <Activity entries={history} />
                      </SectionErrorBoundary>
                    ) : (
                      <EmptyState title="No chat-targeted records in the loaded audit page." />
                    )}
                    <Button color="gray" variant="soft" mt="3" onClick={onAudit}>
                      Open global Audit
                    </Button>
                  </Tabs.Content>
                </Tabs.Root>
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}
