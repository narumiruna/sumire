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
import { ReadingEntries } from "./durable-reading.js"
import { type MessageKey, t } from "./i18n.js"

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
        if (block.type === "toolCall") return [t("record.argumentsForTool", { name: block.name })]
        if (block.type === "image") return [t("record.imageOmitted", { mimeType: block.mimeType })]
        return []
      }),
    )
    .join("\n")
  if (text) return text.slice(0, 320)
  if (!entry.role) return t("record.storedEvent", { kind: entry.kind })
  if (entry.content?.truncated) return t("record.contentTruncated")
  return entry.content ? t("record.noMessages") : t("record.contentMissing")
}

type Props = {
  conversationId: number
  data?: DurableInspectionResponse
  error?: string
  page: number
  selectedId?: number
  wide: boolean
  navigation?: ReactNode
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
  wide: viewportWide,
  navigation,
  entryHref,
  onSelect,
  onPrevious,
  onNext,
  readEntry,
  renderDetail,
  onSessionExpired,
}: Props) {
  const [mode, setMode] = useState<"reading" | "events">(() => {
    try {
      return window.sessionStorage.getItem("sumire.admin.history-mode") === "events"
        ? "events"
        : "reading"
    } catch {
      return "reading"
    }
  })
  const wide = viewportWide && mode === "events"
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
    error?: MessageKey
    unavailable?: boolean
  }>()
  const opener = useRef<HTMLAnchorElement | null>(null)
  const previousButton = useRef<HTMLButtonElement>(null)
  const nextButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const navigationFocus = useRef<
    | {
        id: number
        control: "previous" | "next" | "close"
      }
    | undefined
  >(undefined)
  useEffect(() => {
    const trackFocus = (event: FocusEvent) => {
      const pending = navigationFocus.current
      if (!pending) return
      if (event.target === previousButton.current) pending.control = "previous"
      else if (event.target === nextButton.current) pending.control = "next"
      else if (event.target === closeButton.current) pending.control = "close"
      else if (event.target !== document.body) navigationFocus.current = undefined
    }
    document.addEventListener("focusin", trackFocus)
    return () => document.removeEventListener("focusin", trackFocus)
  }, [])
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
          error: forbidden ? "record.permissionRefresh" : "record.entryReadFailed",
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
  useEffect(() => {
    const pending = navigationFocus.current
    if (!pending) return
    if (!wide || !open || selectedId !== pending.id) {
      navigationFocus.current = undefined
      return
    }
    if (activeDetail || error || denied || ownerUnavailable) navigationFocus.current = undefined
    if (document.activeElement !== document.body) return
    const buttons =
      pending.control === "previous"
        ? [previousButton.current, nextButton.current, closeButton.current]
        : pending.control === "next"
          ? [nextButton.current, previousButton.current, closeButton.current]
          : [closeButton.current, previousButton.current, nextButton.current]
    buttons.find((button) => button && !button.disabled)?.focus({ preventScroll: true })
  }, [activeDetail, selectedId, error, denied, ownerUnavailable, wide, open])
  const selectAdjacent = (offset: number, button: HTMLButtonElement) => {
    const entry = displayedEntries[selectedIndex + offset]
    if (selectedIndex < 0 || !entry) return
    navigationFocus.current =
      wide && document.activeElement === button
        ? { id: entry.id, control: offset < 0 ? "previous" : "next" }
        : undefined
    onSelect(entry.id)
  }
  const detailNavigation = (
    <nav
      aria-label={t("record.entryNavigation")}
      className="durable-entry-navigation durable-event-header"
    >
      <Button
        variant="outline"
        size="1"
        ref={previousButton}
        disabled={selectedIndex <= 0}
        onClick={(event) => selectAdjacent(-1, event.currentTarget)}
      >
        <ChevronLeftIcon aria-hidden />
        {t("record.previous")}
      </Button>
      <Button
        variant="outline"
        size="1"
        ref={nextButton}
        disabled={selectedIndex < 0 || selectedIndex >= displayedEntries.length - 1}
        onClick={(event) => selectAdjacent(1, event.currentTarget)}
      >
        {t("record.next")}
        <ChevronRightIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="1"
        aria-label={t("record.closeDetails")}
        ref={closeButton}
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
          {t("record.permissionRefresh")}
        </Text>
      ) : error ? (
        <Text as="p" role="alert">
          {error}
        </Text>
      ) : ownerUnavailable ? (
        <Text as="p" role="status">
          {ownerState === "not-loaded" ? t("record.sessionRefresh") : t("record.sessionChanged")}
        </Text>
      ) : !activeDetail ? (
        <Text as="p" role="status">
          {t("record.loadingEntry")}
        </Text>
      ) : activeDetail.unavailable ? (
        <Text as="p" role="status">
          {t("record.entryUnavailable")}
        </Text>
      ) : activeDetail.error ? (
        <Text as="p" role="alert">
          {t(activeDetail.error)}
        </Text>
      ) : activeDetail.entry ? (
        <>
          {!selectedOnPage && (
            <Text as="p" size="2">
              {t("record.outsidePage")}
            </Text>
          )}
          {selectedOnPage && !selectedVisible && (
            <Text as="p" size="2">
              {t("record.filteredEntry")}
            </Text>
          )}
          {renderDetail(activeDetail.entry, wide ? detailNavigation : undefined)}
          {activeDetail.readAt && (
            <Text as="p" size="1" className="durable-read-time">
              {t("record.entryReadTime", { time: formatReadTime(activeDetail.readAt) })}
            </Text>
          )}
        </>
      ) : null}
    </>
  )

  return (
    <section
      aria-label={t("record.conversationHistory")}
      className="durable-history-workspace"
      data-details={open && wide}
      data-mode={mode}
    >
      <fieldset className="history-mode-switch" aria-label={t("record.historyMode")}>
        {(["reading", "events"] as const).map((value) => (
          <Button
            key={value}
            variant="ghost"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value)
              try {
                window.sessionStorage.setItem("sumire.admin.history-mode", value)
              } catch {
                /* The current view still works without session storage. */
              }
            }}
          >
            {t(value === "reading" ? "record.readingMode" : "record.eventsMode")}
          </Button>
        ))}
        {navigation}
      </fieldset>
      <div className="durable-history-filters">
        <label htmlFor="durable-history-search">
          <span className="durable-search-label">{t("record.searchPage")}</span>
          <TextField.Root
            id="durable-history-search"
            type="search"
            placeholder={t("record.searchPlaceholder")}
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
          {t("record.recordType")}
          <select
            id="durable-history-role"
            value={filter}
            onChange={(event) => setFilter(event.target.value as HistoryFilter)}
          >
            <option value="all">{t("record.allRecords")}</option>
            <option value="user">{t("record.user")}</option>
            <option value="assistant">{t("record.assistant")}</option>
            <option value="tools">{t("record.tools")}</option>
            <option value="other">{t("record.systemInternal")}</option>
          </select>
        </label>
        <Text as="p" size="1" role="status" className="durable-match-count">
          {t("record.matchesCount", { count, loaded: entries.length })}
        </Text>
      </div>
      <div className="durable-history-layout">
        <section
          aria-label={t("record.conversationEntries")}
          className="durable-conversation-history"
        >
          {selectedId !== undefined && !open && (
            <Button variant="soft" onClick={() => setOpen(true)}>
              {t("record.openDetails")}
            </Button>
          )}
          <div className="durable-entry-list-header">
            <Heading as="h3" size="3">
              {t("record.entriesHeading", { count: entries.length })}
            </Heading>
            <select
              aria-label={t("record.entryOrder")}
              value={newestFirst ? "newest" : "oldest"}
              onChange={(event) => setNewestFirst(event.target.value === "newest")}
            >
              <option value="oldest">{t("record.oldestFirst")}</option>
              <option value="newest">{t("record.newestFirst")}</option>
            </select>
          </div>
          {error || denied ? (
            <Text as="p" role="alert">
              {denied ? t("record.permissionRefresh") : error}
            </Text>
          ) : !data ? (
            <Text as="p" role="status">
              {t("record.loadingHistory")}
            </Text>
          ) : ownerUnavailable ? (
            <Text as="p">
              {ownerState === "not-loaded"
                ? t("record.notLoadedNotice")
                : t("record.sessionChanged")}
            </Text>
          ) : !entries.length ? (
            <Text as="p">{t("record.noEntries")}</Text>
          ) : !count ? (
            <Text as="p">{t("record.noMatches")}</Text>
          ) : (
            <div className="durable-turns">
              {displayedGroups.map((group) => (
                <section
                  key={group.id}
                  aria-label={
                    group.userTurn
                      ? t("record.userTurn", { id: group.id })
                      : t("record.earlierContext")
                  }
                  className="durable-turn"
                >
                  <Heading as="h4" size="2">
                    {group.userTurn
                      ? t("record.userTurnEntry", { id: group.id })
                      : t("record.earlierContext")}
                  </Heading>
                  {!group.userTurn && (
                    <Text as="p" size="1">
                      {t("record.precedingTurn")}
                    </Text>
                  )}
                  {mode === "reading" ? (
                    <ReadingEntries
                      entries={group.entries}
                      conversationId={conversationId}
                      selectedId={selectedId}
                      entryHref={entryHref}
                      preview={entryPreview}
                      onInspect={(id, anchor) => {
                        opener.current = anchor
                        setOpen(true)
                        onSelect(id)
                      }}
                    />
                  ) : (
                    group.entries.map((entry) => {
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
                              aria-label={t("record.inspectEntry", { id: entry.id })}
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
                                <span className="durable-history-preview">
                                  {entryPreview(entry)}
                                </span>
                                {entry.content?.truncated && (
                                  <span className="durable-preview-note">
                                    {t("record.contentTruncated")}
                                  </span>
                                )}
                                {entry.conversationId !== conversationId && (
                                  <span className="durable-preview-note">
                                    {t("record.inherited", { id: entry.conversationId })}
                                  </span>
                                )}
                              </span>
                            </a>
                          </header>
                        </article>
                      )
                    })
                  )}
                </section>
              ))}
            </div>
          )}
          <header className="durable-history-heading">
            <Heading as="h3" size="4">
              {t("record.historyHeading", { id: conversationId })}
            </Heading>
            <Text as="p" size="2">
              {t(
                newestFirst ? "record.historyDescriptionNewest" : "record.historyDescriptionOldest",
              )}
            </Text>
          </header>
          {data?.truncated && (
            <Text as="p" role="status">
              {t("record.historyTruncated")}
            </Text>
          )}
          <Flex gap="3" wrap="wrap" align="center" className="durable-history-pages">
            <Button
              variant="soft"
              disabled={page === 1 || !data || Boolean(error) || denied || ownerUnavailable}
              onClick={onPrevious}
            >
              {t("record.newerRecords")}
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
              {t("record.olderRecords")}
            </Button>
            <Text size="2">
              {t(page === 1 ? "record.latestPage" : "record.olderPage", { page })}
            </Text>
          </Flex>
          {data && (
            <Text as="p" size="1" className="durable-read-time">
              {t("record.historyReadTime", { time: formatReadTime(data.readAt) })}
            </Text>
          )}
        </section>
        {wide && (
          <aside aria-label={t("record.eventDetails")} className="durable-event-details">
            {open && selectedId !== undefined ? (
              detailContent
            ) : (
              <div className="durable-event-placeholder">
                <Heading as="h3" size="3">
                  {t("record.entryDetails")}
                </Heading>
                <Text as="p">{t("record.selectEntry")}</Text>
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
            <Dialog.Title>{t("record.eventDetails")}</Dialog.Title>
            <Dialog.Description size="1">
              {t("record.dialogDescription", { id: conversationId })}
            </Dialog.Description>
            {detailContent}
          </Dialog.Content>
        </Dialog.Root>
      )}
    </section>
  )
}
