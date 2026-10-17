import type { Chat } from "@narumitw/sumire-contracts"
import { effectivePolicy } from "@narumitw/sumire-policy"
import { CheckCircledIcon, MinusCircledIcon } from "@radix-ui/react-icons"
import { Badge, Button, Card, Flex, Heading, Tabs, Text, TextField } from "@radix-ui/themes"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Activity, type AuditEntry } from "./activity.js"
import type { Inventory, Policy } from "./api.js"
import { policyChanges, withChatAccess } from "./policy-changes.js"

export type { Chat } from "@narumitw/sumire-contracts"
export function chatName(chat: Chat) {
  return chat.name?.trim() && chat.name !== String(chat.id)
    ? chat.name
    : `Unnamed ${chat.type || "chat"} ${chat.id}`
}
function chatType(chat: Chat) {
  if (chat.type === "supergroup") return "group"
  return ["private", "group", "channel"].includes(chat.type) ? chat.type : "unknown"
}

export function ChatWorkspace({
  chats,
  knownChats,
  chat,
  onSelect,
  policy,
  savedPolicy,
  application,
  inventory,
  offset,
  loading,
  error,
  onPage,
  onRetry,
  onAccess,
  onProviders,
  onTools,
  onPolicyChange,
  audit,
  onAudit,
  children,
}: {
  chats: Chat[]
  knownChats: Chat[]
  chat: string
  onSelect(value: string): void
  policy: Policy
  savedPolicy: Policy
  application: string
  inventory: Inventory
  offset: number
  loading: boolean
  error: string
  onPage(offset: number): void
  onRetry(): void
  onAccess(): void
  onProviders(): void
  onTools(): void
  onPolicyChange(value: Policy): void
  audit: AuditEntry[]
  onAudit(): void
  children: ReactNode
}) {
  const [query, setQuery] = useState("")
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
      if (selected) {
        selected.focus({ preventScroll: true })
        window.scrollTo({ top: directoryScroll.current, behavior: "instant" })
      } else searchRef.current?.focus()
    } else headerRef.current?.focus()
  }, [showDirectory])
  const changeTab = (value: string) => {
    setTab(value)
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-view="${value}"]`)?.focus()
  }
  const [copyStatus, setCopyStatus] = useState({ chat: "", message: "" })
  const filtered = chats.filter(
    (c) =>
      `${chatName(c)} ${c.id} ${c.type}`.toLowerCase().includes(query.toLowerCase()) &&
      (type === "all" || chatType(c) === type) &&
      (access === "all" || effectivePolicy(policy, c.id).enabled === (access === "allowed")),
  )
  const metadata = knownChats.find((c) => String(c.id) === chat)
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
        <div className="directory-header">
          <Heading size="3">Chat directory</Heading>
          <label htmlFor="chat-search">
            Search these {chats.length} chats
            <TextField.Root
              id="chat-search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, type, or ID"
            />
          </label>
          <div className="directory-filters">
            <div>
              <label htmlFor="chat-type-filter">Chat type</label>
              <select id="chat-type-filter" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="all">All types</option>
                <option value="private">Private</option>
                <option value="group">Group / supergroup</option>
                <option value="channel">Channel</option>
                <option value="unknown">Unknown type</option>
              </select>
            </div>
            <div>
              <label htmlFor="chat-access-filter">Access status</label>
              <select
                id="chat-access-filter"
                value={access}
                onChange={(e) => setAccess(e.target.value)}
              >
                <option value="all">All access</option>
                <option value="allowed">Approved and enabled</option>
                <option value="denied">Not approved or disabled</option>
              </select>
            </div>
          </div>
          <details className="directory-help">
            <summary>Search scope and access labels</summary>
            <Text as="p" size="1" color="gray">
              Search and filters cover this page of observed chats (up to 100), not all chats.
              Access labels show {preview ? "the policy draft" : "saved policy"}, not verified
              runtime readiness. Names reflect observed Telegram metadata; ID-only records have no
              known name.
            </Text>
          </details>
          <div aria-live="polite">
            {loading ? (
              <Text as="p">Loading chats…</Text>
            ) : error ? (
              <>
                <Text as="p" role="alert">
                  {error}
                </Text>
                <Button onClick={onRetry}>Retry chats</Button>
              </>
            ) : !chats.length ? (
              <Text as="p">
                No chats observed on this page. Configure a Telegram ID below or return to the
                previous page.
              </Text>
            ) : !filtered.length ? (
              <>
                <Text as="p">
                  No chats match on this page. Clear the search and filters or try another page.
                </Text>
                <Button
                  variant="soft"
                  onClick={() => {
                    setQuery("")
                    setType("all")
                    setAccess("all")
                  }}
                >
                  Clear search and filters
                </Button>
              </>
            ) : (
              <Text as="p" size="1" color="gray">
                {filtered.length} of {chats.length} chats on this page
              </Text>
            )}
          </div>
        </div>
        <div className="directory-list-region">
          {!loading && !error && (
            <ul className="chat-list" aria-label="Chats on this page">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={chat === String(c.id) ? "true" : undefined}
                    onClick={() => openChat(String(c.id))}
                  >
                    <strong title={chatName(c)}>{chatName(c)}</strong>
                    <small title={`${c.type || "Type not known"} · ${c.id}`}>
                      {c.type || "Type not known"} · {c.id}
                    </small>
                    <Badge color="gray">
                      {policy[c.id > 0 ? "privateUsers" : "groups"].includes(c.id) ? (
                        <CheckCircledIcon aria-hidden="true" />
                      ) : (
                        <MinusCircledIcon aria-hidden="true" />
                      )}
                      {policy[c.id > 0 ? "privateUsers" : "groups"].includes(c.id)
                        ? "Approved"
                        : "Not approved"}
                      {policy.chats[String(c.id)]?.enabled === false ? " · Disabled" : ""}
                      {preview ? " · Draft" : ""}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="directory-footer">
          <Flex gap="2" wrap="wrap" align="center">
            <Button
              variant="soft"
              disabled={loading || offset === 0}
              onClick={() => onPage(Math.max(0, offset - 100))}
            >
              Previous chats
            </Button>
            <Button
              variant="soft"
              disabled={loading || chats.length < 100}
              onClick={() => onPage(offset + 100)}
            >
              Next chats
            </Button>
            <Text size="1" color="gray">
              Page {Math.floor(offset / 100) + 1}
            </Text>
          </Flex>
          {chat && (
            <Button
              className="mobile-directory-action"
              variant="soft"
              mt="3"
              onClick={showChatDetails}
            >
              Show selected chat
            </Button>
          )}
          <details className="configure-id">
            <summary>Configure a chat before its first message</summary>
            <Text as="p" size="2">
              This creates settings, not access approval.
            </Text>
            <label htmlFor="chat-id">
              Chat ID (can configure before first message)
              <TextField.Root
                id="chat-id"
                value={chat}
                onChange={(e) => onSelect(e.target.value)}
              />
            </label>
            <Button variant="soft" disabled={!valid} onClick={showChatDetails}>
              Open chat details
            </Button>
          </details>
        </footer>
      </aside>
      <section className="chat-detail" aria-label="Chat details">
        {!chat ? (
          <Card className="chat-initial">
            <Heading size="4">Select a chat</Heading>
            <Text as="p" color="gray">
              Choose a chat from the directory to review access, effective settings, and overrides.
              Selecting a chat does not grant access.
            </Text>
          </Card>
        ) : (
          <>
            <Button
              className="mobile-directory-action"
              variant="ghost"
              mb="3"
              onClick={() => setShowDirectory(true)}
            >
              Back to chat directory
            </Button>
            <header className="chat-header">
              <div>
                <Heading size="5" ref={headerRef} tabIndex={-1}>
                  {chatName(
                    metadata ?? { id, name: "", type: id > 0 ? "private" : "group or channel" },
                  )}
                </Heading>
                <Text size="2" color="gray">
                  {metadata?.type || "Type not known"} · <code>{chat}</code>
                </Text>
              </div>
              <Flex gap="2" align="center" wrap="wrap">
                <Button
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
            <Text role="status" size="2">
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
                      <Button type="button" variant="soft" onClick={blocker.run}>
                        {blocker.action}
                      </Button>
                    </div>
                  ))}
                  <details className="setup-details">
                    <summary>Readiness details</summary>
                    <dl className="effective-settings readiness">
                      <dt>Access</dt>
                      <dd>
                        {savedApproval ? "Approved" : "Not approved"}
                        {accessPending ? ` · Draft: ${approved ? "Approved" : "Not approved"}` : ""}
                      </dd>
                      <dt>Chat</dt>
                      <dd>
                        {override?.enabled === false ? "Disabled" : "Enabled"}
                        {preview ? " · Policy draft" : ""}
                      </dd>
                      <dt>Configuration</dt>
                      <dd>
                        {!provider
                          ? "Unknown"
                          : effective.model && provider.configured
                            ? "Configured locally"
                            : "Setup required"}
                      </dd>
                      <dt>Verification</dt>
                      <dd>Not checked — no remote model request</dd>
                      <dt>Application</dt>
                      <dd>{application}</dd>
                    </dl>
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
                      loaded local inventory, not a remote model request. Each action keeps its own
                      save boundary.
                    </Text>
                  </details>
                  {effective.model && !provider && (
                    <Flex gap="2" align="center" wrap="wrap" mt="2">
                      <Text size="2">
                        Configuration status unknown; remote authentication not checked here.
                      </Text>
                      <Button type="button" variant="soft" onClick={onProviders}>
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
                    <dl className="overview-settings">
                      <div>
                        <dt>Access</dt>
                        <dd>
                          {effective.enabled ? "Approved and enabled" : "Blocked by policy"}
                          <small>
                            Approval {approved ? "granted" : "not granted"} · Chat{" "}
                            {override?.enabled === false ? "disabled" : "enabled"}
                          </small>
                        </dd>
                        <Button type="button" variant="ghost" onClick={() => changeTab("access")}>
                          Manage access
                        </Button>
                      </div>
                      <div>
                        <dt>Model</dt>
                        <dd>
                          {effective.model ?? "No allowed model"}
                          <small>
                            {effective.sources.model === "chat"
                              ? "Chat override"
                              : "Shared default"}
                          </small>
                        </dd>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => changeTab("configuration")}
                        >
                          Change model
                        </Button>
                      </div>
                      <div>
                        <dt>Tools</dt>
                        <dd>
                          {effective.tools.length} allowed
                          <small>
                            {effective.sources.tools === "chat" ? "Explicit override" : "Inherited"}
                          </small>
                        </dd>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => changeTab("configuration")}
                        >
                          View tool permissions
                        </Button>
                      </div>
                    </dl>
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
                    <details className="permission-details">
                      <summary>Advanced configuration / Check details</summary>
                      <dl className="effective-settings">
                        <dt>Tools</dt>
                        <dd>
                          {effective.tools.join(", ") || "None"} ·{" "}
                          {effective.sources.tools === "chat" ? "Explicit override" : "Inherited"}
                        </dd>
                        <dt>MCP servers</dt>
                        <dd>
                          {effective.servers.join(", ") || "None"} ·{" "}
                          {effective.sources.servers === "chat" ? "Explicit override" : "Inherited"}
                        </dd>
                        <dt>Thinking</dt>
                        <dd>
                          {effective.thinking} ·{" "}
                          {effective.sources.thinking === "chat"
                            ? "Explicit override"
                            : "Inherited"}
                        </dd>
                      </dl>
                      <Text as="p" size="2">
                        Remote authentication and runtime availability are not verified here.
                        Connection checks require an explicit action.
                      </Text>
                      <Flex gap="3" wrap="wrap" mt="2">
                        <Button type="button" variant="soft" onClick={onProviders}>
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
                  </Tabs.Content>
                  <Tabs.Content value="access" forceMount hidden={tab !== "access"}>
                    <Card>
                      <Heading size="3">Access for this chat</Heading>
                      <Text as="p" size="2" mt="2">
                        {id > 0 ? "Private-message access" : "Group and channel access"}. Approval
                        never grants access in other chats.
                      </Text>
                      <dl className="effective-settings">
                        <dt>Saved approval</dt>
                        <dd>{savedApproval ? "Approved" : "Not approved"}</dd>
                        <dt>Draft approval</dt>
                        <dd>{approved ? "Approved" : "Not approved"}</dd>
                        <dt>Policy access</dt>
                        <dd>
                          {effective.enabled ? "Approved and enabled" : "Blocked by policy"}
                          {override?.enabled === false
                            ? " · Chat disabled independently of approval"
                            : ""}
                        </dd>
                      </dl>
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
                          Open global Access
                        </Button>
                      </Flex>
                      <Text as="p" size="2" color="gray" mt="3">
                        These actions stage policy edits only. Apply policy changes saves all
                        pending policy edits across sections, not provider authentication or MCP
                        connection drafts. Granting approval does not enable a disabled chat.
                      </Text>
                    </Card>
                  </Tabs.Content>
                  <Tabs.Content value="configuration" forceMount hidden={tab !== "configuration"}>
                    <Heading size="3">Model &amp; Tools</Heading>
                    <dl className="effective-settings">
                      <dt>Effective model</dt>
                      <dd>
                        {effective.model ?? "No allowed model"} ·{" "}
                        {effective.sources.model === "chat" ? "Chat override" : "Shared default"}
                      </dd>
                      <dt>Chat model override</dt>
                      <dd>{override?.model ?? "Inherit from defaults"}</dd>
                      <dt>Tools</dt>
                      <dd>
                        {effective.tools.join(", ") || "None"} ·{" "}
                        {effective.sources.tools === "chat" ? "Explicit override" : "Inherited"}
                      </dd>
                      <dt>MCP servers</dt>
                      <dd>
                        {effective.servers.join(", ") || "None"} ·{" "}
                        {effective.sources.servers === "chat" ? "Explicit override" : "Inherited"}
                      </dd>
                      <dt>Thinking</dt>
                      <dd>
                        {effective.thinking} ·{" "}
                        {effective.sources.thinking === "chat" ? "Explicit override" : "Inherited"}
                      </dd>
                    </dl>
                    <Flex gap="3" wrap="wrap">
                      <Button variant="soft" onClick={onProviders}>
                        Manage model authentication
                      </Button>
                      <Button variant="soft" onClick={onTools}>
                        Manage tool permissions
                      </Button>
                    </Flex>
                    <Heading size="3" mt="4">
                      Chat overrides
                    </Heading>
                    <Text as="p" size="2" color="gray">
                      Model, tool, and enabled-switch edits share the policy save boundary. Apply
                      policy changes saves these and all other staged policy changes.
                    </Text>
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
                      <Card mt="3">
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
                      </Card>
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
                      <Activity entries={history} />
                    ) : (
                      <Text as="p">No chat-targeted records in the loaded audit page.</Text>
                    )}
                    <Button variant="soft" mt="3" onClick={onAudit}>
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
