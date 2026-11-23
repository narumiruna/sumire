import type { DurableEntryItem, DurableInspectionResponse } from "@narumitw/sumire-contracts"
import { ActionButton } from "@react-spectrum/s2/ActionButton"
import { Button, Text } from "@react-spectrum/s2/Button"
import ChevronLeft from "@react-spectrum/s2/icons/ChevronLeft"
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight"
import Close from "@react-spectrum/s2/icons/Close"
import { SearchField } from "@react-spectrum/s2/SearchField"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { ToggleButton } from "@react-spectrum/s2/ToggleButton"
import {
  type ComponentRef,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { FocusScope } from "react-aria/FocusScope"
import { Overlay } from "react-aria/Overlay"
import { useModalOverlay } from "react-aria/useModalOverlay"
import { useOverlayTriggerState } from "react-stately/useOverlayTriggerState"
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
import "./durable-spectrum.css"

const dialogBackdrop = style({ backgroundColor: "transparent-black-500" })
const precedingButtonLabel = style({ order: -1 })
const dialogSurface = style({
  backgroundColor: "layer-2",
  borderRadius: "xl",
  boxShadow: "elevated",
  "--history-dialog-text": { type: "color", value: "body" },
  "--history-dialog-muted": { type: "color", value: "neutral-subdued" },
  "--history-dialog-border": { type: "borderColor", value: "gray-300" },
  "--history-dialog-panel": { type: "backgroundColor", value: "layer-1" },
  "--history-dialog-paper": { type: "backgroundColor", value: "layer-2" },
})

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
  const search = useRef<ComponentRef<typeof SearchField>>(null)
  const previousButton = useRef<ComponentRef<typeof Button>>(null)
  const nextButton = useRef<ComponentRef<typeof Button>>(null)
  const closeButton = useRef<ComponentRef<typeof ActionButton>>(null)
  const dialogId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const dialogOpen = !wide && open && selectedId !== undefined
  const wasDialogOpen = useRef(false)
  const dialogState = useOverlayTriggerState({ isOpen: dialogOpen, onOpenChange: setOpen })
  const { modalProps, underlayProps } = useModalOverlay(
    { isDismissable: true },
    dialogState,
    dialogRef,
  )
  useEffect(() => {
    const restore = wasDialogOpen.current && !dialogOpen
    wasDialogOpen.current = dialogOpen
    if (!restore) return
    const target = opener.current
    if (target?.isConnected && target.checkVisibility({ visibilityProperty: true })) target.focus()
    else search.current?.focus()
  }, [dialogOpen])
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
      if (event.target === previousButton.current?.UNSAFE_getDOMNode()) pending.control = "previous"
      else if (event.target === nextButton.current?.UNSAFE_getDOMNode()) pending.control = "next"
      else if (event.target === closeButton.current?.UNSAFE_getDOMNode()) pending.control = "close"
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
    if (!open || selectedId !== pending.id) {
      navigationFocus.current = undefined
      return
    }
    if (activeDetail || error || denied || ownerUnavailable) navigationFocus.current = undefined
    if (document.activeElement !== document.body) return
    const previous = previousButton.current?.UNSAFE_getDOMNode()
    const next = nextButton.current?.UNSAFE_getDOMNode()
    const close = closeButton.current?.UNSAFE_getDOMNode()
    const buttons =
      pending.control === "previous"
        ? [previous, next, close]
        : pending.control === "next"
          ? [next, previous, close]
          : [close, previous, next]
    buttons.find((button) => button && !button.disabled)?.focus({ preventScroll: true })
  }, [activeDetail, selectedId, error, denied, ownerUnavailable, open])
  const selectAdjacent = (offset: number) => {
    const entry = displayedEntries[selectedIndex + offset]
    if (selectedIndex < 0 || !entry) return
    const button = offset < 0 ? previousButton.current : nextButton.current
    navigationFocus.current =
      document.activeElement === button?.UNSAFE_getDOMNode()
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
        variant="secondary"
        fillStyle="outline"
        size="S"
        ref={previousButton}
        isDisabled={selectedIndex <= 0}
        onPress={() => selectAdjacent(-1)}
      >
        <ChevronLeft aria-hidden />
        <Text>{t("record.previous")}</Text>
      </Button>
      <Button
        variant="secondary"
        fillStyle="outline"
        size="S"
        ref={nextButton}
        isDisabled={selectedIndex < 0 || selectedIndex >= displayedEntries.length - 1}
        onPress={() => selectAdjacent(1)}
      >
        <Text styles={precedingButtonLabel}>{t("record.next")}</Text>
        <ChevronRight aria-hidden />
      </Button>
      <ActionButton
        isQuiet
        size="S"
        aria-label={t("record.closeDetails")}
        ref={closeButton}
        onPress={() => setOpen(false)}
      >
        <Close aria-hidden />
      </ActionButton>
    </nav>
  )
  const detailContent = (
    <>
      {(!wide || !activeDetail?.entry) && detailNavigation}
      {denied ? (
        <p role="alert">{t("record.permissionRefresh")}</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : ownerUnavailable ? (
        <p role="status">
          {ownerState === "not-loaded" ? t("record.sessionRefresh") : t("record.sessionChanged")}
        </p>
      ) : !activeDetail ? (
        <p role="status">{t("record.loadingEntry")}</p>
      ) : activeDetail.unavailable ? (
        <p role="status">{t("record.entryUnavailable")}</p>
      ) : activeDetail.error ? (
        <p role="alert">{t(activeDetail.error)}</p>
      ) : activeDetail.entry ? (
        <>
          {!selectedOnPage && <p>{t("record.outsidePage")}</p>}
          {selectedOnPage && !selectedVisible && <p>{t("record.filteredEntry")}</p>}
          {renderDetail(activeDetail.entry, wide ? detailNavigation : undefined)}
          {activeDetail.readAt && (
            <p className="durable-read-time">
              {t("record.entryReadTime", { time: formatReadTime(activeDetail.readAt) })}
            </p>
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
          <ToggleButton
            key={value}
            isQuiet
            isSelected={mode === value}
            onPress={() => {
              setMode(value)
              try {
                window.sessionStorage.setItem("sumire.admin.history-mode", value)
              } catch {
                /* The current view still works without session storage. */
              }
            }}
          >
            {t(value === "reading" ? "record.readingMode" : "record.eventsMode")}
          </ToggleButton>
        ))}
        {navigation}
      </fieldset>
      <div className="durable-history-filters">
        <SearchField
          ref={search}
          id="durable-history-search"
          UNSAFE_className="durable-history-search"
          aria-label={t("record.searchPage")}
          placeholder={t("record.searchPlaceholder")}
          maxLength={512}
          value={query}
          onChange={setQuery}
        />
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
        <p role="status" className="durable-match-count">
          {t("record.matchesCount", { count, loaded: entries.length })}
        </p>
      </div>
      <div className="durable-history-layout">
        <section
          aria-label={t("record.conversationEntries")}
          className="durable-conversation-history"
        >
          {selectedId !== undefined && !open && (
            <Button variant="secondary" onPress={() => setOpen(true)}>
              {t("record.openDetails")}
            </Button>
          )}
          <div className="durable-entry-list-header">
            <h3>{t("record.entriesHeading", { count: entries.length })}</h3>
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
            <p role="alert">{denied ? t("record.permissionRefresh") : error}</p>
          ) : !data ? (
            <p role="status">{t("record.loadingHistory")}</p>
          ) : ownerUnavailable ? (
            <p>
              {ownerState === "not-loaded"
                ? t("record.notLoadedNotice")
                : t("record.sessionChanged")}
            </p>
          ) : !entries.length ? (
            <p>{t("record.noEntries")}</p>
          ) : !count ? (
            <p>{t("record.noMatches")}</p>
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
                  <h4>
                    {group.userTurn
                      ? t("record.userTurnEntry", { id: group.id })
                      : t("record.earlierContext")}
                  </h4>
                  {!group.userTurn && <p>{t("record.precedingTurn")}</p>}
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
            <h3>{t("record.historyHeading", { id: conversationId })}</h3>
            <p>
              {t(
                newestFirst ? "record.historyDescriptionNewest" : "record.historyDescriptionOldest",
              )}
            </p>
          </header>
          {data?.truncated && <p role="status">{t("record.historyTruncated")}</p>}
          <div className="durable-history-pages">
            <Button
              variant="secondary"
              isDisabled={page === 1 || !data || Boolean(error) || denied || ownerUnavailable}
              onPress={onPrevious}
            >
              {t("record.newerRecords")}
            </Button>
            <Button
              variant="secondary"
              isDisabled={
                data?.state !== "loaded" ||
                !data.nextCursor ||
                Boolean(error) ||
                denied ||
                ownerUnavailable
              }
              onPress={onNext}
            >
              {t("record.olderRecords")}
            </Button>
            <span>{t(page === 1 ? "record.latestPage" : "record.olderPage", { page })}</span>
          </div>
          {data && (
            <p className="durable-read-time">
              {t("record.historyReadTime", { time: formatReadTime(data.readAt) })}
            </p>
          )}
        </section>
        {wide && (
          <aside aria-label={t("record.eventDetails")} className="durable-event-details">
            {open && selectedId !== undefined ? (
              detailContent
            ) : (
              <div className="durable-event-placeholder">
                <h3>{t("record.entryDetails")}</h3>
                <p>{t("record.selectEntry")}</p>
              </div>
            )}
          </aside>
        )}
      </div>
      {dialogOpen && (
        // The opener may be gone or filtered out; restore focus to it or search explicitly.
        <Overlay disableFocusManagement>
          <div className={`durable-history-backdrop ${dialogBackdrop}`} {...underlayProps}>
            <FocusScope contain autoFocus>
              <div
                {...modalProps}
                ref={dialogRef}
                className={`durable-inspector durable-history-dialog ${dialogSurface}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${dialogId}-title`}
                aria-describedby={`${dialogId}-description`}
              >
                <h2 id={`${dialogId}-title`}>{t("record.eventDetails")}</h2>
                <p id={`${dialogId}-description`}>
                  {t("record.dialogDescription", { id: conversationId })}
                </p>
                {detailContent}
              </div>
            </FocusScope>
          </div>
        </Overlay>
      )}
    </section>
  )
}
