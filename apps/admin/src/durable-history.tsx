import type { DurableEntryItem, DurableInspectionResponse } from "@narumitw/sumire-contracts"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Cross2Icon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons"
import { Button, Dialog, Flex, Heading, Text, TextField } from "@radix-ui/themes"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "./api.js"
import {
  formatDurableTime,
  formatReadTime,
  recordIcon,
  recordTitle,
  recordTone,
} from "./durable-presentation.js"

export type HistoryFilter = "all" | "user" | "assistant" | "tools" | "other"
export type HistoryGroup = { id: number; userTurn: boolean; entries: DurableEntryItem[] }

/** Native pages are newest-first. Reverse the page, never sort by message timestamps. */
export function historyGroups(entries: readonly DurableEntryItem[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const entry of entries.toReversed()) {
    // Passive context and compaction can have a user role without being addressed input.
    if (entry.kind === "pi.user" || groups.length === 0)
      groups.push({ id: entry.id, userTurn: entry.kind === "pi.user", entries: [] })
    groups.at(-1)?.entries.push(entry)
  }
  return groups
}

export function matchesHistory(entry: DurableEntryItem, filter: HistoryFilter, query: string) {
  const roles =
    entry.content?.messages.map((message) => message.role) ?? (entry.role ? [entry.role] : [])
  const hasCall = entry.content?.messages.some((message) =>
    message.content.some((block) => block.type === "toolCall"),
  )
  const matchesRole =
    filter === "all" ||
    (filter === "tools"
      ? roles.includes("toolResult") || hasCall
      : filter === "other"
        ? roles.length === 0 || roles.includes("system")
        : roles.includes(filter))
  if (!matchesRole) return false
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const fields = [String(entry.id), entry.kind, entry.toolName ?? "", entry.toolCallId ?? ""]
  for (const message of entry.content?.messages ?? []) {
    fields.push(message.role, message.toolName ?? "", message.toolCallId ?? "")
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          fields.push(block.text)
          break
        case "thinking":
          fields.push(block.thinking)
          break
        case "toolCall":
          fields.push(block.id, block.name, block.arguments)
          break
        case "image":
          fields.push(block.mimeType)
          break
      }
    }
  }
  return fields.join("\n").toLowerCase().includes(needle)
}

export function entryPreview(entry: DurableEntryItem): string {
  const text = entry.content?.messages
    .flatMap((message) =>
      message.content.flatMap((block) => {
        if (block.type === "text") return [block.text]
        if (block.type === "toolCall") return [`${block.name} · Arguments`]
        if (block.type === "image")
          return [`Image omitted · ${block.mimeType}. Image bytes are not sent.`]
        return []
      }),
    )
    .join("\n")
  if (text) return text.slice(0, 320)
  if (!entry.role) return `Stored event: ${entry.kind}. Internal payloads are not exposed.`
  if (entry.content?.truncated) return "Content truncated · inspection limits were reached."
  return entry.content
    ? "No message content recorded."
    : "Message content was not included in this response."
}

type Props = {
  conversationId: number
  data?: DurableInspectionResponse
  error?: string
  page: number
  selectedId?: number
  wide: boolean
  entryHref(id: number): string
  onSelect(id: number): void
  onPrevious(): void
  onNext(): void
  readEntry(id: number, signal: AbortSignal): Promise<DurableInspectionResponse>
  renderDetail(entry: DurableEntryItem, navigation?: ReactNode): ReactNode
  onSessionExpired(): void
}

export function DurableHistory({
  conversationId,
  data,
  error,
  page,
  selectedId,
  wide,
  entryHref,
  onSelect,
  onPrevious,
  onNext,
  readEntry,
  renderDetail,
  onSessionExpired,
}: Props) {
  const [query, setQuery] = useState("")
  const [newestFirst, setNewestFirst] = useState(false)
  const [filter, setFilter] = useState<HistoryFilter>("all")
  const [open, setOpen] = useState(selectedId !== undefined)
  const [denied, setDenied] = useState(false)
  const [detailOwnerState, setDetailOwnerState] = useState<"not-loaded" | "changed">()
  const [detail, setDetail] = useState<{
    id: number
    entry?: DurableEntryItem
    readAt?: string
    error?: string
    unavailable?: boolean
  }>()
  const opener = useRef<HTMLAnchorElement | null>(null)
  const ownerState = data?.state === "not-loaded" ? "not-loaded" : detailOwnerState
  const ownerUnavailable = ownerState !== undefined
  useEffect(() => {
    setOpen(selectedId !== undefined)
  }, [selectedId])
  useEffect(() => {
    setDetail(undefined)
    if (selectedId === undefined || error || ownerUnavailable) return
    const controller = new AbortController()
    void readEntry(selectedId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        if (response.state === "not-loaded") {
          setDetailOwnerState("not-loaded")
          setDetail(undefined)
          return
        }
        const entry =
          response.state === "loaded"
            ? response.items.find(
                (item): item is DurableEntryItem => item.type === "entry" && item.id === selectedId,
              )
            : undefined
        setDetail({ id: selectedId, entry, readAt: response.readAt, unavailable: !entry })
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        if (reason instanceof ApiError && reason.status === 401) {
          setDetail(undefined)
          setDenied(true)
          onSessionExpired()
          return
        }
        const forbidden = reason instanceof ApiError && reason.status === 403
        if (forbidden) setDenied(true)
        if (reason instanceof ApiError && reason.status === 409) setDetailOwnerState("changed")
        setDetail({
          id: selectedId,
          error: forbidden
            ? "Permission denied. Refresh records to retry."
            : "Entry read failed. Refresh records to retry.",
          unavailable: reason instanceof ApiError && reason.status === 404,
        })
      })
    return () => controller.abort()
  }, [selectedId, readEntry, onSessionExpired, error, ownerUnavailable])

  const entries = useMemo(
    () =>
      data?.state === "loaded" && data.view === "history" && !error && !denied && !ownerUnavailable
        ? data.items.filter((item): item is DurableEntryItem => item.type === "entry")
        : [],
    [data, error, denied, ownerUnavailable],
  )
  const groups = useMemo(
    () =>
      historyGroups(entries)
        .map((group) => ({
          ...group,
          entries: group.entries.filter((entry) => matchesHistory(entry, filter, query)),
        }))
        .filter((group) => group.entries.length > 0),
    [entries, filter, query],
  )
  const displayedGroups = newestFirst
    ? groups.toReversed().map((group) => ({ ...group, entries: group.entries.toReversed() }))
    : groups
  const displayedEntries = displayedGroups.flatMap((group) => group.entries)
  const selectedIndex = displayedEntries.findIndex((entry) => entry.id === selectedId)
  const count = groups.reduce((sum, group) => sum + group.entries.length, 0)
  const activeDetail =
    data?.state === "loaded" && !error && !denied && !ownerUnavailable && detail?.id === selectedId
      ? detail
      : undefined
  const selectedOnPage = entries.some((entry) => entry.id === selectedId)
  const selectedVisible = groups.some((group) =>
    group.entries.some((entry) => entry.id === selectedId),
  )
  const selectAdjacent = (offset: number) => {
    const entry = displayedEntries[selectedIndex + offset]
    if (selectedIndex >= 0 && entry) onSelect(entry.id)
  }
  const detailNavigation = (
    <nav aria-label="Entry navigation" className="durable-entry-navigation durable-event-header">
      <Button
        variant="outline"
        size="1"
        disabled={selectedIndex <= 0}
        onClick={() => selectAdjacent(-1)}
      >
        <ChevronLeftIcon aria-hidden /> Previous
      </Button>
      <Button
        variant="outline"
        size="1"
        disabled={selectedIndex < 0 || selectedIndex >= displayedEntries.length - 1}
        onClick={() => selectAdjacent(1)}
      >
        Next <ChevronRightIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="1"
        aria-label="Close event details"
        onClick={() => setOpen(false)}
      >
        <Cross2Icon aria-hidden />
      </Button>
    </nav>
  )
  const detailContent = (
    <>
      {(!wide || !activeDetail?.entry) && detailNavigation}
      {denied ? (
        <Text as="p" role="alert">
          Permission denied. Refresh records to retry.
        </Text>
      ) : error ? (
        <Text as="p" role="alert">
          {error}
        </Text>
      ) : ownerUnavailable ? (
        <Text as="p" role="status">
          {ownerState === "not-loaded"
            ? "Session not loaded. Refresh records after the chat is loaded."
            : "Session or inspection changed. Refresh records to retry."}
        </Text>
      ) : !activeDetail ? (
        <Text as="p" role="status">
          Loading entry…
        </Text>
      ) : activeDetail.unavailable ? (
        <Text as="p" role="status">
          Entry unavailable in this conversation. It may have retired or the session may have
          closed.
        </Text>
      ) : activeDetail.error ? (
        <Text as="p" role="alert">
          {activeDetail.error}
        </Text>
      ) : activeDetail.entry ? (
        <>
          {!selectedOnPage && (
            <Text as="p" size="2">
              Selected entry is outside the loaded page.
            </Text>
          )}
          {selectedOnPage && !selectedVisible && (
            <Text as="p" size="2">
              Selected entry does not match the loaded-page filters.
            </Text>
          )}
          {renderDetail(activeDetail.entry, wide ? detailNavigation : undefined)}
          {activeDetail.readAt && (
            <Text as="p" size="1" className="durable-read-time">
              Entry read time: {formatReadTime(activeDetail.readAt)}
            </Text>
          )}
        </>
      ) : null}
    </>
  )

  return (
    <section
      aria-label="Conversation history"
      className="durable-history-workspace"
      data-details={open && wide}
    >
      <div className="durable-history-filters">
        <label htmlFor="durable-history-search">
          <span className="durable-search-label">Search loaded page</span>
          <TextField.Root
            id="durable-history-search"
            type="search"
            placeholder="Search messages in this conversation…"
            maxLength={512}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon aria-hidden />
            </TextField.Slot>
          </TextField.Root>
        </label>
        <label htmlFor="durable-history-role">
          Record type
          <select
            id="durable-history-role"
            value={filter}
            onChange={(event) => setFilter(event.target.value as HistoryFilter)}
          >
            <option value="all">All records</option>
            <option value="user">User</option>
            <option value="assistant">Assistant</option>
            <option value="tools">Tools</option>
            <option value="other">System & internal</option>
          </select>
        </label>
        <Text as="p" size="1" role="status" className="durable-match-count">
          {count} matching / {entries.length} loaded records
        </Text>
      </div>
      <div className="durable-history-layout">
        <section aria-label="Conversation entries" className="durable-conversation-history">
          {selectedId !== undefined && !open && (
            <Button variant="soft" onClick={() => setOpen(true)}>
              Open event details
            </Button>
          )}
          <div className="durable-entry-list-header">
            <Heading as="h3" size="3">
              Conversation entries ({entries.length})
            </Heading>
            <select
              aria-label="Entry order"
              value={newestFirst ? "newest" : "oldest"}
              onChange={(event) => setNewestFirst(event.target.value === "newest")}
            >
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select>
          </div>
          {error || denied ? (
            <Text as="p" role="alert">
              {denied ? "Permission denied. Refresh records to retry." : error}
            </Text>
          ) : !data ? (
            <Text as="p" role="status">
              Loading history…
            </Text>
          ) : ownerUnavailable ? (
            <Text as="p">
              {ownerState === "not-loaded"
                ? "Not loaded. Inspection will not open a database or start a session."
                : "Session or inspection changed. Refresh records to retry."}
            </Text>
          ) : !entries.length ? (
            <Text as="p">No saved entries on this page.</Text>
          ) : !count ? (
            <Text as="p">
              No matches on the loaded page. Change the filters or open another page.
            </Text>
          ) : (
            <div className="durable-turns">
              {displayedGroups.map((group) => (
                <section
                  key={group.id}
                  aria-label={
                    group.userTurn ? `User turn ${group.id}` : "Earlier context on this page"
                  }
                  className="durable-turn"
                >
                  <Heading as="h4" size="2">
                    {group.userTurn
                      ? `User turn · entry ${group.id}`
                      : "Earlier context on this page"}
                  </Heading>
                  {!group.userTurn && (
                    <Text as="p" size="1">
                      The preceding user turn is not on this page, or these records precede a user
                      turn.
                    </Text>
                  )}
                  {group.entries.map((entry) => {
                    const Icon = recordIcon(entry)
                    return (
                      <article
                        key={entry.id}
                        className={`durable-history-entry durable-role-${recordTone(entry)}`}
                        data-selected={entry.id === selectedId}
                      >
                        <header>
                          <a
                            href={entryHref(entry.id)}
                            aria-label={`Inspect entry ${entry.id}`}
                            aria-current={entry.id === selectedId ? "true" : undefined}
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
                              opener.current = event.currentTarget
                              setOpen(true)
                              onSelect(entry.id)
                            }}
                          >
                            <span className="durable-role-icon">
                              <Icon aria-hidden />
                            </span>
                            <span className="durable-history-row-body">
                              <span className="durable-history-entry-heading">
                                <strong>{recordTitle(entry)}</strong>
                                <span className="durable-record-id">#{entry.id}</span>
                                {entry.timestamp !== undefined && (
                                  <time>{formatDurableTime(entry.timestamp)}</time>
                                )}
                              </span>
                              <span className="durable-history-preview">{entryPreview(entry)}</span>
                              {entry.content?.truncated && (
                                <span className="durable-preview-note">
                                  Content truncated · inspection limits were reached.
                                </span>
                              )}
                              {entry.conversationId !== conversationId && (
                                <span className="durable-preview-note">
                                  Inherited from conversation {entry.conversationId}
                                </span>
                              )}
                            </span>
                          </a>
                        </header>
                      </article>
                    )
                  })}
                </section>
              ))}
            </div>
          )}
          <header className="durable-history-heading">
            <Heading as="h3" size="4">
              History · conversation {conversationId}
            </Heading>
            <Text as="p" size="2">
              Saved model-facing messages, not a Telegram archive or captured request. Entries read
              in {newestFirst ? "newest-first" : "oldest-first"} order within this page. Filters
              search this page only.
            </Text>
          </header>
          {data?.truncated && (
            <Text as="p" role="status">
              History truncated · content or page limits were reached. Use Event details or Older
              records for available saved data.
            </Text>
          )}
          <Flex gap="3" wrap="wrap" align="center" className="durable-history-pages">
            <Button
              variant="soft"
              disabled={page === 1 || !data || Boolean(error) || denied || ownerUnavailable}
              onClick={onPrevious}
            >
              Newer records
            </Button>
            <Button
              variant="soft"
              disabled={
                data?.state !== "loaded" ||
                !data.nextCursor ||
                Boolean(error) ||
                denied ||
                ownerUnavailable
              }
              onClick={onNext}
            >
              Older records
            </Button>
            <Text size="2">
              Page {page}
              {page === 1 ? " · latest records" : " · older records"}
            </Text>
          </Flex>
          {data && (
            <Text as="p" size="1" className="durable-read-time">
              History read time: {formatReadTime(data.readAt)}
            </Text>
          )}
        </section>
        {wide && (
          <aside aria-label="Event details" className="durable-event-details">
            {open && selectedId !== undefined ? (
              detailContent
            ) : (
              <div className="durable-event-placeholder">
                <Heading as="h3" size="3">
                  Entry details
                </Heading>
                <Text as="p">Select a conversation entry to read its saved content.</Text>
              </div>
            )}
          </aside>
        )}
      </div>
      {!wide && (
        <Dialog.Root open={open && selectedId !== undefined} onOpenChange={setOpen}>
          <Dialog.Content
            className="durable-inspector durable-history-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              const target = opener.current
              if (target?.isConnected && target.checkVisibility()) target.focus()
              else document.getElementById("durable-history-search")?.focus()
            }}
          >
            <Dialog.Title>Event details</Dialog.Title>
            <Dialog.Description size="1">
              Saved entry in inspected conversation {conversationId}. Viewing does not change the
              persisted selection.
            </Dialog.Description>
            {detailContent}
          </Dialog.Content>
        </Dialog.Root>
      )}
    </section>
  )
}
