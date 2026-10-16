import { Badge, Button, Card, Flex, Heading, Text, TextField } from "@radix-ui/themes"
import { type ReactNode, useState } from "react"
import { effectivePolicy } from "../../bot/src/admin/policy.js"
import type { Inventory, Policy } from "./api.js"
import { SearchChoice, SectionActive } from "./providers.js"

export type Chat = { id: number; name: string; type: string }
export function chatName(chat: Chat) {
  return chat.name && chat.name !== String(chat.id) ? chat.name : `Unnamed ${chat.type}`
}

export function ChatWorkspace({
  active,
  chats,
  knownChats,
  chat,
  onSelect,
  policy,
  savedPolicy,
  inventory,
  offset,
  loading,
  error,
  onPage,
  onRetry,
  onAccess,
  onProviders,
  onTools,
  children,
}: {
  active: boolean
  chats: Chat[]
  knownChats: Chat[]
  chat: string
  onSelect(value: string): void
  policy: Policy
  savedPolicy: Policy
  inventory: Inventory
  offset: number
  loading: boolean
  error: string
  onPage(offset: number): void
  onRetry(): void
  onAccess(): void
  onProviders(): void
  onTools(): void
  children: ReactNode
}) {
  const [query, setQuery] = useState("")
  const [copyStatus, setCopyStatus] = useState({ chat: "", message: "" })
  const filtered = chats.filter((c) =>
    `${chatName(c)} ${c.id} ${c.type}`.toLowerCase().includes(query.toLowerCase()),
  )
  const metadata = knownChats.find((c) => String(c.id) === chat)
  const valid = /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))
  const effective = effectivePolicy(policy, Number(chat))
  const saved = effectivePolicy(savedPolicy, Number(chat))
  const approved = (Number(chat) > 0 ? policy.privateUsers : policy.groups).includes(Number(chat))
  const configuredModel = policy.chats[chat]?.model ?? policy.defaults.model
  const provider = inventory.providers.find((p) => p.id === effective.model?.split("/")[0])
  const preview = JSON.stringify(policy) !== JSON.stringify(savedPolicy)
  return (
    <SectionActive value={active}>
      <div className="chat-workspace">
        <aside aria-label="Find a chat">
          <Heading size="3">Find a chat</Heading>
          <label htmlFor="chat-search">
            Search this page
            <TextField.Root
              id="chat-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, type, or ID"
            />
          </label>
          <Text as="p" size="2">
            Search covers this page of observed chats (up to 100). Use Next chats for more.
            Selecting a chat does not grant access.
          </Text>
          <SearchChoice
            label="Known chat"
            value={chat}
            options={chats.map((c) => ({
              id: String(c.id),
              label: chatName(c),
              detail: `${c.type} · ${c.id}`,
            }))}
            onChange={onSelect}
            disabled={loading}
          />
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
              <Text as="p">No chats match on this page. Clear the search or try another page.</Text>
            ) : null}
          </div>
          {!loading && !error && (
            <ul className="chat-list">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={chat === String(c.id) ? "true" : undefined}
                    onClick={() => onSelect(String(c.id))}
                  >
                    <strong>{chatName(c)}</strong>
                    <small>
                      {c.type} · {c.id}
                    </small>
                    <span>{effectivePolicy(policy, c.id).enabled ? "Allowed" : "Not allowed"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Flex gap="2" wrap="wrap" mt="3">
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
          </Flex>
          <Text as="p" size="2">
            Page {Math.floor(offset / 100) + 1}
          </Text>
          <details>
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
          </details>
        </aside>
        <section className="chat-detail" aria-label="Chat details">
          {!chat ? (
            <Card>
              <Heading size="4">Select a chat</Heading>
              <Text as="p">
                Choose a chat from the list to review access, effective settings, and overrides.
              </Text>
            </Card>
          ) : (
            <>
              <Heading size="4">{metadata ? chatName(metadata) : "Unobserved chat"}</Heading>
              <Flex gap="2" align="center" wrap="wrap">
                <Text size="2">
                  {metadata?.type ?? "Type not known"} · {chat}
                </Text>
                <Button
                  variant="ghost"
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
              <Text role="status" size="2">
                {copyStatus.chat === chat ? copyStatus.message : ""}
              </Text>
              {!valid ? (
                <Text as="p" role="alert">
                  Enter a valid, non-zero Telegram ID.
                </Text>
              ) : (
                <>
                  <Card>
                    <Heading size="3">Effective settings</Heading>
                    <Text as="p" size="2">
                      {preview
                        ? "Policy draft preview — not yet saved. Authentication and MCP status reflect the loaded inventory."
                        : "Saved policy. Authentication and MCP status reflect the loaded inventory."}
                    </Text>
                    {preview && (
                      <Text as="p" size="2">
                        Saved access: {saved.enabled ? "Allowed" : "Not allowed"} · Saved model:{" "}
                        {saved.model ?? "No allowed model"}
                      </Text>
                    )}
                    <dl className="effective-settings">
                      <dt>Access</dt>
                      <dd>
                        <Badge color={effective.enabled ? "green" : "orange"}>
                          {effective.enabled ? "Allowed" : "Not allowed"}
                        </Badge>{" "}
                        · Approval {approved ? "granted" : "not granted"} · Chat{" "}
                        {policy.chats[chat]?.enabled === false ? "disabled" : "enabled"}
                      </dd>
                      <dt>Model</dt>
                      <dd>
                        {effective.model ?? "No allowed model"} ·{" "}
                        {effective.sources.model === "chat" ? "Chat override" : "Shared default"}
                        {!effective.model && configuredModel
                          ? ` (configured: ${configuredModel})`
                          : ""}
                      </dd>
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
                      <dt>Allowed models</dt>
                      <dd>
                        {effective.models.join(", ") || "None"} ·{" "}
                        {effective.sources.models === "chat" ? "Explicit override" : "Inherited"}
                      </dd>
                      <dt>Thinking</dt>
                      <dd>
                        {effective.thinking} ·{" "}
                        {effective.sources.thinking === "chat" ? "Explicit override" : "Inherited"}
                      </dd>
                      <dt>Authentication</dt>
                      <dd>
                        {!effective.model
                          ? "No effective model to inspect."
                          : provider?.configured
                            ? "Configured locally; remote authentication not checked here."
                            : provider
                              ? "Model authentication is not configured."
                              : "Configuration status unknown; remote authentication not checked here."}
                      </dd>
                    </dl>
                    <Heading size="2">Blockers and next actions</Heading>
                    {!approved && <Text as="p">Access approval is missing.</Text>}
                    <Button variant="soft" onClick={onAccess}>
                      {approved ? "Manage access approval" : "Review access approval"}
                    </Button>
                    {policy.chats[chat]?.enabled === false && (
                      <Text as="p">
                        The chat is disabled. Use Chat enabled below to stage a change.
                      </Text>
                    )}
                    {(!effective.model || (provider && !provider.configured)) && (
                      <>
                        <Text as="p">
                          {!effective.model
                            ? "Select an allowed model or review model availability."
                            : "Configure model authentication. This is a separate, immediate action."}
                        </Text>
                        <Button variant="soft" onClick={onProviders}>
                          {!effective.model ? "Configure model" : "Configure authentication"}
                        </Button>
                      </>
                    )}
                    {!!effective.model && !provider && (
                      <Button variant="soft" onClick={onProviders}>
                        Review authentication configuration
                      </Button>
                    )}
                    {!!effective.servers.length && (
                      <>
                        <Text as="p" size="2">
                          MCP permissions do not confirm connection health. Review connection status
                          separately.
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
                        <Button variant="soft" onClick={onTools}>
                          Review MCP connections
                        </Button>
                      </>
                    )}
                  </Card>
                  <Heading size="3" mt="4">
                    Chat overrides
                  </Heading>
                  <Text as="p" size="2">
                    Edits remain pending until you apply policy changes. Tool and model selections
                    never grant access.
                  </Text>
                  {children}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </SectionActive>
  )
}
