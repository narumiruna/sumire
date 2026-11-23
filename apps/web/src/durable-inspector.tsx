import type {
  Chat,
  DurableConversationItem,
  DurableDocumentScope,
  DurableInspectionItem,
  DurableInspectionQuery,
  DurableInspectionResponse,
  DurableInspectionView,
  DurableNumericUsage,
} from "@narumitw/sumire-contracts"
import { Button } from "@react-spectrum/s2/Button"
import ChatBubbleIcon from "@react-spectrum/s2/icons/Chat"
import ChevronDownIcon from "@react-spectrum/s2/icons/ChevronDown"
import ChevronLeftIcon from "@react-spectrum/s2/icons/ChevronLeft"
import ChevronRightIcon from "@react-spectrum/s2/icons/ChevronRight"
import CopyIcon from "@react-spectrum/s2/icons/Copy"
import FileTextIcon from "@react-spectrum/s2/icons/FileText"
import EnterFullScreenIcon from "@react-spectrum/s2/icons/FullScreen"
import ExitFullScreenIcon from "@react-spectrum/s2/icons/FullScreenExit"
import LayersIcon from "@react-spectrum/s2/icons/Layers"
import ReloadIcon from "@react-spectrum/s2/icons/Refresh"
import MagnifyingGlassIcon from "@react-spectrum/s2/icons/Search"
import MixerHorizontalIcon from "@react-spectrum/s2/icons/Settings"
import PersonIcon from "@react-spectrum/s2/icons/User"
import SpeakerLoudIcon from "@react-spectrum/s2/icons/VolumeTwo"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import {
  type FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components/Tabs"
import { ApiError, request } from "./api.js"
import { chatName } from "./chat-directory.js"
import { EntryContent } from "./durable-entry-content.js"
import { DurableHistory } from "./durable-history.js"
import { type MessageKey, t } from "./i18n.js"

export { EntryContent } from "./durable-entry-content.js"

import {
  formatDurableTime,
  formatReadTime,
  recordBadge,
  recordIcon,
  recordMetadata,
  recordRoleLabel,
  recordStatusLabel,
  recordSummary,
  recordTitle,
  recordTone,
  recordTypeLabel,
  taskObservation,
} from "./durable-presentation.js"
import { DurableTree } from "./durable-tree.js"
import { navigationHref } from "./navigation.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { countText } from "./status-text.js"
import { Panel, Prose, StatusLabel } from "./surfaces.js"

const views = ["history", "conversations", "tasks", "documents", "entries"] as const
const labels = () => ({
  history: t("record.history"),
  conversations: t("record.conversations"),
  tasks: t("record.tasks"),
  documents: t("record.documents"),
  entries: t("record.entries"),
})
export type DurableLocation = Omit<DurableInspectionQuery, "limit" | "cursor">
const positiveId = (value: string | null) =>
  value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined

export function readDurableLocation(url: URL): DurableLocation {
  const raw = url.searchParams.get("view")
  const view = views.find((value) => value === raw) ?? "history"
  const conversationId = positiveId(url.searchParams.get("conversationId"))
  const taskId = positiveId(url.searchParams.get("taskId"))
  const objectId = positiveId(url.searchParams.get("objectId"))
  const rawScope = url.searchParams.get("scope")
  const scope: DurableDocumentScope =
    rawScope === "session" || rawScope === "task" ? rawScope : "conversation"
  return {
    view,
    ...(conversationId ? { conversationId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(view === "documents" ? { scope } : {}),
    ...(objectId ? { objectId } : {}),
  }
}

export function durableHref(
  chat: string,
  location: DurableLocation,
  url = new URL(window.location.href),
) {
  const next = new URL(navigationHref("Durable", chat, url), url)
  for (const key of ["view", "conversationId", "scope", "taskId", "objectId"] as const) {
    next.searchParams.delete(key)
    if (location[key] !== undefined) next.searchParams.set(key, String(location[key]))
  }
  return `${next.pathname}${next.search}${next.hash}`
}

export function inspectionPath(chat: string, location: DurableLocation, cursor?: string) {
  const query = new URLSearchParams({ view: location.view, limit: "25" })
  // Context IDs are not object filters for a session document or a conversation scan.
  if (
    location.view !== "conversations" &&
    !(location.view === "documents" && location.scope === "session")
  ) {
    if (location.conversationId) query.set("conversationId", String(location.conversationId))
  }
  if (location.view === "documents") {
    query.set("scope", location.scope ?? "conversation")
    if (location.scope === "task" && location.taskId) query.set("taskId", String(location.taskId))
  }
  if (location.objectId) query.set("objectId", String(location.objectId))
  if (cursor) query.set("cursor", cursor)
  return `chats/${encodeURIComponent(chat)}/durable?${query}`
}

function readContextLocation(location: DurableLocation): DurableLocation {
  return location.view === "history" ? { ...location, objectId: undefined } : location
}

function contextNeeded(location: DurableLocation) {
  if (
    location.view === "history" ||
    location.view === "conversations" ||
    (location.view === "documents" && location.scope === "session")
  )
    return ""
  if (!location.conversationId) return t("record.selectConversation")
  if (location.view === "documents" && location.scope === "task" && !location.taskId)
    return t("record.selectTask")
  return ""
}

type ReadBlock = {
  data?: DurableInspectionResponse
  error?: string
  errorKey?: MessageKey
  unavailable?: boolean
}
const readError = (block?: ReadBlock) => (block?.errorKey ? t(block.errorKey) : block?.error)
const chatTypeLabel = (type: Chat["type"]) => {
  const keys = {
    private: "record.chatPrivate",
    group: "record.chatGroup",
    supergroup: "record.chatSupergroup",
    channel: "record.chatChannel",
  } as const
  return Object.hasOwn(keys, type) ? t(keys[type as keyof typeof keys]) : type
}
type BlockName = "selection" | "history" | "inspection"

export function persistedSelection(
  data?: DurableInspectionResponse,
): DurableConversationItem | null | undefined {
  return data?.state === "loaded" ? data.selectedConversation : undefined
}

// One conversation page, at most one selected-conversation task page, and one requested page.
// No page scans or polling. Every block keeps its own response and read time.
export async function readDurableContext(
  chat: string,
  location: DurableLocation,
  cursor: string | undefined,
  read: (path: string) => Promise<ReadBlock>,
  publish: (name: BlockName, block: ReadBlock) => void,
) {
  const selectionPath = inspectionPath(
    chat,
    { view: "conversations" },
    location.view === "conversations" && !location.objectId ? cursor : undefined,
  )
  const selection = await read(selectionPath)
  publish("selection", selection)
  const selected = persistedSelection(selection.data)
  let history: ReadBlock | undefined
  let historyPath: string | undefined
  if (selected) {
    historyPath = inspectionPath(chat, { view: "tasks", conversationId: selected.id })
    history = await read(historyPath)
    publish("history", history)
  }
  if (contextNeeded(location)) return
  if (location.view === "history" && !location.conversationId && !selected) {
    publish("inspection", selection)
    return
  }
  const requestedPath = inspectionPath(
    chat,
    location.view === "history"
      ? {
          ...location,
          conversationId: location.conversationId ?? selected?.id,
          objectId: undefined,
        }
      : location,
    cursor,
  )
  const inspection =
    requestedPath === selectionPath || selection.data?.state === "not-loaded"
      ? selection
      : requestedPath === historyPath && history
        ? history
        : await read(requestedPath)
  publish("inspection", inspection)
}

// Serialize old and new client reads for the same chat, including component remounts.
const chatReads = new Map<string, Promise<unknown>>()
function sequenceRead<T>(chat: string, read: () => Promise<T>): Promise<T> {
  const previous = chatReads.get(chat) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(read)
  chatReads.set(chat, next)
  void next
    .finally(() => {
      if (chatReads.get(chat) === next) chatReads.delete(chat)
    })
    .catch(() => {})
  return next
}

/** Only trusted catalog placeholders are split. Link text remains a React text node. */
function linkedSentence(
  key: "record.branchedLinks" | "record.ownedLinks",
  links: Record<string, ReactNode>,
) {
  return t(key)
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = part.slice(1, -1)
      return Object.hasOwn(links, name) ? <Fragment key={part}>{links[name]}</Fragment> : part
    })
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  const [copyState, setCopyState] = useState<MessageKey>()
  const json = JSON.stringify(value, null, 2)
  return (
    <details className="durable-json">
      <summary>{label}</summary>
      <Button
        variant="secondary"
        size="S"
        onPress={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(json))
            .then(
              () => setCopyState("record.jsonCopied"),
              () => setCopyState("record.copyJsonFailed"),
            )
        }}
      >
        {t("record.copyLabel", { label })}
      </Button>
      {copyState && <Prose role="status">{t(copyState)}</Prose>}
      <pre>{json}</pre>
    </details>
  )
}

function UsageFields({ usage }: { usage: DurableNumericUsage }) {
  const fields = [
    ["input", t("record.input")],
    ["output", t("record.output")],
    ["cacheRead", t("record.cacheRead")],
    ["cacheWrite", t("record.cacheWrite")],
    ["total", t("record.total")],
  ] as const
  return (
    <dl className="durable-metadata durable-usage">
      {fields.map(([key, label]) => (
        <div className="durable-usage-field" key={key}>
          <dt>{t("record.tokens", { label })}</dt>
          <dd>{usage[key] ?? t("record.notRecorded")}</dd>
        </div>
      ))}
      {usage.cost &&
        fields.map(([key, label]) => (
          <div className="durable-usage-field" key={`cost:${key}`}>
            <dt>{t("record.cost", { label })}</dt>
            <dd>{usage.cost?.[key] ?? t("record.notRecorded")}</dd>
          </div>
        ))}
    </dl>
  )
}

export function DurableInspector({
  chat,
  metadata,
  metadataLoading,
  metadataError,
  onMetadataRetry,
  chatSelector,
  onChats,
  onSessionExpired,
}: {
  chat: string
  metadata?: Chat
  metadataLoading?: boolean
  metadataError?: string
  onMetadataRetry?(): void
  chatSelector?: ReactNode
  onChats(): void
  onSessionExpired(): void
}) {
  const [readingFocus, setReadingFocus] = useState(false)
  const [directoryCollapsed, setDirectoryCollapsed] = useState(false)
  const [location, setLocation] = useState(() => readDurableLocation(new URL(window.location.href)))
  // Browser event selection is independent of the history page's read context.
  const [readLocation, setReadLocation] = useState(() => readContextLocation(location))
  const historyTarget = useRef<{ chat: string; id: number } | undefined>(undefined)
  const [pages, setPages] = useState<(string | undefined)[]>([undefined])
  const [refresh, setRefresh] = useState(0)
  const readTreePage = useCallback(
    (path: string, signal: AbortSignal) =>
      sequenceRead(chat, () => {
        signal.throwIfAborted()
        return request<DurableInspectionResponse>(path, undefined, undefined, "GET", signal)
      }),
    [chat],
  )
  const [blocks, setBlocks] = useState<{
    key: string
    selection?: ReadBlock
    history?: ReadBlock
    inspection?: ReadBlock
  }>()
  const [detailId, setDetailId] = useState<number>()
  const browser = useRef<HTMLDetailsElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const focusDetail = useRef(false)
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches)
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)")
    const sync = () => setWide(media.matches)
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])
  const [copyIdState, setCopyIdState] = useState<MessageKey>()
  const draftConversationId =
    location.view === "conversations"
      ? (location.objectId ?? location.conversationId)
      : location.conversationId
  const [conversationDraft, setConversationDraft] = useState(String(draftConversationId ?? ""))
  const [taskDraft, setTaskDraft] = useState(String(location.taskId ?? ""))
  const [inputError, setInputError] = useState<MessageKey>()
  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href)
      const next = readDurableLocation(url)
      const target = historyTarget.current?.chat === chat ? historyTarget.current.id : undefined
      if (
        url.searchParams.get("chat") === chat &&
        next.view === "history" &&
        location.view === "history" &&
        (next.conversationId ?? target) === (location.conversationId ?? target)
      ) {
        setLocation(next)
        return
      }
      historyTarget.current = undefined
      setLocation(next)
      setReadLocation(readContextLocation(next))
      setPages([undefined])
    }
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [chat, location])
  useEffect(() => {
    setConversationDraft(String(draftConversationId ?? ""))
    setTaskDraft(String(location.taskId ?? ""))
    setInputError(undefined)
  }, [draftConversationId, location.taskId])
  const validChat = /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))
  const missing = contextNeeded(readLocation)
  const path = inspectionPath(chat, readLocation, pages.at(-1))
  const key = `${path}:${refresh}`
  useEffect(() => {
    setBlocks(undefined)
    setDetailId(undefined)
    if (!validChat) return
    const controller = new AbortController()
    const read = (nextPath: string) =>
      sequenceRead(chat, async (): Promise<ReadBlock> => {
        controller.signal.throwIfAborted()
        try {
          return {
            data: await request<DurableInspectionResponse>(
              nextPath,
              undefined,
              undefined,
              "GET",
              controller.signal,
            ),
          }
        } catch (error) {
          controller.signal.throwIfAborted()
          if (error instanceof ApiError && error.status === 401) throw error
          return {
            error: "read-failed",
            errorKey:
              error instanceof ApiError && error.status === 403
                ? "record.permissionRead"
                : "record.readRefresh",
            unavailable:
              error instanceof ApiError && error.status === 404 && nextPath.includes("objectId="),
          }
        }
      })
    const pinned = historyTarget.current?.chat === chat ? historyTarget.current.id : undefined
    const context =
      readLocation.view === "history"
        ? { ...readLocation, conversationId: readLocation.conversationId ?? pinned }
        : readLocation
    void readDurableContext(chat, context, pages.at(-1), read, (name, block) => {
      if (controller.signal.aborted) return
      if (
        name === "selection" &&
        readLocation.view === "history" &&
        (!historyTarget.current || historyTarget.current.chat !== chat)
      ) {
        const id = readLocation.conversationId ?? persistedSelection(block.data)?.id
        if (id !== undefined) historyTarget.current = { chat, id }
      }
      setBlocks((value) => ({ ...(value?.key === key ? value : { key }), [name]: block }))
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && error instanceof ApiError && error.status === 401) {
        setBlocks(undefined)
        onSessionExpired()
      }
    })
    return () => controller.abort()
  }, [key, validChat, chat, readLocation, pages, onSessionExpired])

  const navigate = (next: DurableLocation) => {
    window.history.pushState(null, "", durableHref(chat, next))
    historyTarget.current = undefined
    setLocation(next)
    setReadLocation(readContextLocation(next))
    setPages([undefined])
  }
  const link = (label: ReactNode, next: DurableLocation) => (
    <a
      href={durableHref(chat, next)}
      className={typeof label === "string" ? undefined : "durable-record-link"}
      aria-current={
        next.objectId !== undefined &&
        next.objectId === detail?.id &&
        inspectionPath(chat, next) === inspectionPath(chat, { ...location, objectId: detail?.id })
          ? "true"
          : undefined
      }
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        event.preventDefault()
        if (!wide) {
          if (browser.current) browser.current.open = false
          focusDetail.current = true
        }
        navigate(next)
      }}
    >
      {label}
    </a>
  )
  const selectContext = (event: FormEvent) => {
    event.preventDefault()
    const conversationId = positiveId(conversationDraft)
    const taskId = positiveId(taskDraft)
    if ((conversationDraft && !conversationId) || (taskDraft && !taskId)) {
      setInputError("record.invalidIds")
      return
    }
    setInputError(undefined)
    navigate({
      view: location.view,
      ...(location.scope ? { scope: location.scope } : {}),
      ...(conversationId
        ? location.view === "conversations"
          ? { objectId: conversationId }
          : { conversationId }
        : {}),
      ...(taskId ? { taskId } : {}),
    })
  }
  const activeBlocks = blocks?.key === key ? blocks : undefined
  const current = activeBlocks?.inspection
  const data = current?.data
  const selection = activeBlocks?.selection
  const history = activeBlocks?.history
  const selected = persistedSelection(selection?.data)
  const detail = data?.items.find((item) => item.id === detailId) ?? data?.items[0]
  useEffect(() => {
    if ((current || missing) && focusDetail.current && detailHeading.current) {
      detailHeading.current.focus()
      focusDetail.current = false
    }
  }, [current, missing])
  const inspectedConversation =
    location.view === "conversations"
      ? (location.objectId ??
        (detail?.type === "conversation" ? detail.id : location.conversationId))
      : (location.conversationId ??
        (location.view === "history"
          ? historyTarget.current?.chat === chat
            ? historyTarget.current.id
            : selected?.id
          : undefined))
  const readHistoryEntry = useCallback(
    (id: number, signal: AbortSignal) =>
      readTreePage(
        inspectionPath(chat, {
          view: "entries",
          conversationId: inspectedConversation,
          objectId: id,
        }),
        signal,
      ),
    [chat, inspectedConversation, readTreePage],
  )
  const sessionDocuments = location.view === "documents" && location.scope === "session"
  const conversation = sessionDocuments
    ? undefined
    : detail?.type === "conversation"
      ? detail
      : selected?.id === inspectedConversation
        ? selected
        : selection?.data?.state === "loaded"
          ? selection.data.items.find(
              (item): item is DurableConversationItem =>
                item.type === "conversation" && item.id === inspectedConversation,
            )
          : undefined
  const readTime = (block: ReadBlock | undefined) =>
    block?.data && (
      <Prose size="1" className="durable-read-time">
        {t("record.readTime")}
        <time dateTime={block.data.readAt}>{formatReadTime(block.data.readAt)}</time>
      </Prose>
    )
  const recordDetails = (item: DurableInspectionItem) => (
    <dl className="durable-metadata">
      {item.type === "conversation" && (
        <>
          <dt>{t("record.selectionMarker")}</dt>
          <dd>
            {item.active
              ? t("record.persistedSelectedConversation")
              : t("record.historicalConversation")}
          </dd>
          <dt>{t("record.parentConversation")}</dt>
          <dd>
            {item.parent ? (
              <>
                {link(t("record.conversationNumber", { id: item.parent.conversationId }), {
                  view: "conversations",
                  objectId: item.parent.conversationId,
                })}{" "}
                ·{" "}
                {link(t("record.forkEntry", { id: item.parent.at }), {
                  view: "entries",
                  conversationId: item.parent.conversationId,
                  objectId: item.parent.at,
                })}
              </>
            ) : (
              t("record.noParent")
            )}
          </dd>
          <dt>{t("record.owningTask")}</dt>
          <dd>
            {item.owner
              ? link(
                  t("record.taskInConversation", {
                    task: item.owner.taskId,
                    conversation: item.owner.conversationId,
                  }),
                  {
                    view: "tasks",
                    conversationId: item.owner.conversationId,
                    objectId: item.owner.taskId,
                  },
                )
              : t("record.noOwner")}
          </dd>
        </>
      )}
      {item.type === "task" && (
        <>
          <dt>{t("record.conversation")}</dt>
          <dd>
            {link(t("record.conversationNumber", { id: item.conversationId }), {
              view: "conversations",
              objectId: item.conversationId,
            })}
          </dd>
          <dt>{t("record.owningTask")}</dt>
          <dd>
            {item.ownerTaskId
              ? link(t("record.taskNumber", { id: item.ownerTaskId }), {
                  view: "tasks",
                  conversationId: item.conversationId,
                  objectId: item.ownerTaskId,
                })
              : t("record.noOwner")}
          </dd>
          <dt>{t("record.started")}</dt>
          <dd>{formatDurableTime(item.startedAt)}</dd>
          <dt>{t("record.ended")}</dt>
          <dd>{formatDurableTime(item.endedAt)}</dd>
        </>
      )}
      {item.type === "document" && (
        <>
          <dt>{t("record.appliesTo")}</dt>
          <dd>
            {item.scope.kind === "conversation"
              ? link(t("record.conversationNumber", { id: item.scope.conversationId }), {
                  view: "conversations",
                  objectId: item.scope.conversationId,
                })
              : item.scope.kind === "task"
                ? link(t("record.taskNumber", { id: item.scope.taskId }), {
                    view: "tasks",
                    conversationId: location.conversationId,
                    objectId: item.scope.taskId,
                  })
                : t("record.thisSession")}
          </dd>
        </>
      )}
      {item.type === "entry" && (
        <>
          <dt>{t("record.recordedAt")}</dt>
          <dd>{formatDurableTime(item.timestamp)}</dd>
          <dt>{t("record.conversation")}</dt>
          <dd>
            {link(t("record.conversationNumber", { id: item.conversationId }), {
              view: "conversations",
              objectId: item.conversationId,
            })}
          </dd>
          <dt>{t("record.recordedBy")}</dt>
          <dd>
            {item.byTaskId
              ? link(t("record.taskNumber", { id: item.byTaskId }), {
                  view: "tasks",
                  conversationId: item.conversationId,
                  objectId: item.byTaskId,
                })
              : t("record.notRecorded")}
          </dd>
          {item.toolName !== undefined && (
            <>
              <dt>{t("record.toolName")}</dt>
              <dd>{item.toolName}</dd>
            </>
          )}
          {item.isError !== undefined && (
            <>
              <dt>{t("record.recordedResultField")}</dt>
              <dd>{item.isError ? t("record.error") : t("record.notError")}</dd>
            </>
          )}
          {item.toolCallId !== undefined && (
            <>
              <dt>{t("record.callId")}</dt>
              <dd>{item.toolCallId}</dd>
            </>
          )}
          <dt>{t("record.headEntry")}</dt>
          <dd>
            {item.head
              ? link(t("record.entryNumber", { id: item.head }), {
                  view: "entries",
                  conversationId: item.conversationId,
                  objectId: item.head,
                })
              : t("record.notRecorded")}
          </dd>
        </>
      )}
    </dl>
  )
  const row = (item: DurableInspectionItem, navigation?: ReactNode) => {
    const Icon = recordIcon(item)
    return (
      <section
        key={`${item.type}:${item.id}`}
        className={`durable-detail durable-role-${recordTone(item)}`}
        aria-label={t("record.selectedItemDetails")}
      >
        <header className="durable-detail-header">
          <div className="durable-detail-identity">
            <span className="durable-detail-icon durable-role-icon">
              <Icon aria-hidden />
            </span>
            <h3
              tabIndex={-1}
              ref={detailHeading}
              className={`durable-detail-heading ${style({ font: "heading-sm" })}`}
            >
              {recordTitle(item)}
            </h3>
            <span className="durable-record-id durable-detail-record-id">
              {recordTypeLabel(item.type)} #{item.id}
            </span>
          </div>
          {navigation}
          <div className="durable-record-meta">
            {item.type === "entry" && <span>{formatDurableTime(item.timestamp)}</span>}
            {item.type === "task" && <span>{formatDurableTime(item.startedAt)}</span>}
            {item.type !== "conversation" && "conversationId" in item && (
              <span className="durable-conversation-crumb">
                {link(t("record.conversationNumber", { id: item.conversationId }), {
                  view: "conversations",
                  objectId: item.conversationId,
                })}
              </span>
            )}
            {item.type === "entry" &&
              item.byTaskId !== undefined &&
              link(t("record.taskNumber", { id: item.byTaskId }), {
                view: "tasks",
                conversationId: item.conversationId,
                objectId: item.byTaskId,
              })}
          </div>
          {item.type === "task" && <span className="durable-tree-badge">{recordBadge(item)}</span>}
        </header>
        <div className="durable-detail-content">
          {(item.type === "conversation" ||
            (item.type === "document" && item.valueState !== "available") ||
            (item.type === "entry" && !item.content)) && (
            <Prose className="durable-record-summary">{recordSummary(item)}</Prose>
          )}
          {item.type === "document" && item.valueState === "available" && !item.value && (
            <Prose>{t("record.fieldsMissing")}</Prose>
          )}
          {item.type === "document" && item.valueState === "available" && item.value && (
            <section aria-label={t("record.approvedDocumentFields")} className="durable-projection">
              <h4 className={style({ font: "heading-xs" })}>{t("record.approvedFields")}</h4>
              {item.value.kind === "pi.agent" ? (
                <dl className="durable-metadata">
                  <dt>{t("record.modelProvider")}</dt>
                  <dd>{item.value.model?.provider ?? t("record.notRecorded")}</dd>
                  <dt>{t("record.model")}</dt>
                  <dd>{item.value.model?.modelId ?? t("record.notRecorded")}</dd>
                  <dt>{t("record.thinkingLevel")}</dt>
                  <dd>{item.value.thinkingLevel ?? t("record.notRecorded")}</dd>
                </dl>
              ) : item.value.kind === "pi.usage" ? (
                <>
                  <h5 className={style({ font: "heading-xs" })}>{t("record.totalUsage")}</h5>
                  <UsageFields usage={item.value.total} />
                  <h5 className={style({ font: "heading-xs" })}>{t("record.perModelUsage")}</h5>
                  {Object.keys(item.value.models).length === 0 && (
                    <Prose size="2">{t("record.noModelUsage")}</Prose>
                  )}
                  {Object.entries(item.value.models).map(([model, usage]) => (
                    <details key={model} className="durable-model-usage">
                      <summary>
                        {model} ·{" "}
                        {usage.total === undefined
                          ? t("record.totalMissing")
                          : countText(usage.total, "total token")}
                      </summary>
                      <UsageFields usage={usage} />
                    </details>
                  ))}
                </>
              ) : (
                <dl className="durable-metadata">
                  <dt>{t("record.persistedSelectedConversation")}</dt>
                  <dd>
                    {item.value.activeConversation
                      ? link(
                          t("record.conversationNumber", { id: item.value.activeConversation }),
                          {
                            view: "conversations",
                            objectId: item.value.activeConversation,
                          },
                        )
                      : t("record.notRecorded")}
                  </dd>
                </dl>
              )}
            </section>
          )}
          {item.type === "entry" && item.content && (
            <EntryContent
              content={item.content}
              toolName={item.role === "toolResult" ? item.toolName : undefined}
            />
          )}
          <div className={`durable-links ${style({ display: "flex", flexWrap: "wrap", gap: 12 })}`}>
            {item.type === "conversation" && (
              <>
                {link(t("record.historyInConversation", { id: item.id }), {
                  view: "history",
                  conversationId: item.id,
                })}
                {link(t("record.tasksInConversation", { id: item.id }), {
                  view: "tasks",
                  conversationId: item.id,
                })}
                {link(t("record.conversationDocuments", { id: item.id }), {
                  view: "documents",
                  scope: "conversation",
                  conversationId: item.id,
                })}
                {link(t("record.entriesInConversation", { id: item.id }), {
                  view: "entries",
                  conversationId: item.id,
                })}
              </>
            )}
            {item.type === "task" &&
              link(t("record.taskDocuments", { id: item.id }), {
                view: "documents",
                scope: "task",
                conversationId: item.conversationId,
                taskId: item.id,
              })}
          </div>
        </div>
        <div className="durable-detail-disclosures">
          <details className="durable-record-details">
            <summary>{t("record.recordDetails")}</summary>
            {recordDetails(item)}
            <dl className="durable-metadata">
              {item.type !== "conversation" && (
                <>
                  <dt>{t("record.storedKind")}</dt>
                  <dd>{item.kind}</dd>
                </>
              )}
              {item.type === "task" && (
                <>
                  <dt>{t("record.version")}</dt>
                  <dd>{item.version}</dd>
                  <dt>{t("record.storedStatus")}</dt>
                  <dd>{recordStatusLabel(item.status)}</dd>
                  <dt>{t("record.background")}</dt>
                  <dd>{t(item.background ? "record.yes" : "record.no")}</dd>
                  <dt>{t("record.abortRequested")}</dt>
                  <dd>{t(item.abortRequested ? "record.yes" : "record.no")}</dd>
                </>
              )}
              {item.type === "document" && (
                <>
                  <dt>{t("record.familyMember")}</dt>
                  <dd>{item.family ? t("record.yes") : t("record.no")}</dd>
                  <dt>{t("record.createdSequence")}</dt>
                  <dd>{item.createdAt}</dd>
                  <dt>{t("record.retiredSequence")}</dt>
                  <dd>{item.retiredAt ?? t("record.notRetired")}</dd>
                  <dt>{t("record.definitionVersion")}</dt>
                  <dd>{item.version ?? t("record.notRecorded")}</dd>
                </>
              )}
              {item.type === "entry" && (
                <>
                  <dt>{t("record.storedRole")}</dt>
                  <dd>{item.role ? recordRoleLabel(item.role) : t("record.notRecorded")}</dd>
                </>
              )}
              {item.type === "conversation" && (
                <>
                  <dt>{t("record.persistedSelectionMarker")}</dt>
                  <dd>{t(item.active ? "record.yes" : "record.no")}</dd>
                </>
              )}
            </dl>
          </details>
          <details className="durable-raw-data">
            <summary>{t("record.rawData")}</summary>
            <JsonDetails
              key={`metadata:${item.type}:${item.id}`}
              label={t("record.metadataJson", { type: recordTypeLabel(item.type), id: item.id })}
              value={recordMetadata(item)}
            />
            {item.type === "entry" && item.content && (
              <JsonDetails
                key={`content:${item.id}`}
                label={t("record.contentJson", { id: item.id })}
                value={item.content}
              />
            )}
            {item.type === "document" && item.valueState === "available" && item.value && (
              <JsonDetails
                key={`value:${item.id}`}
                label={t("record.valueJson", { id: item.id })}
                value={item.value}
              />
            )}
          </details>
        </div>
        <footer className="durable-detail-footer">{t("record.persistedNotLive")}</footer>
      </section>
    )
  }

  const header = (
    <>
      <header className="durable-summary-header" data-selected={validChat}>
        {validChat && (
          <div className="durable-chat-identity">
            <span className="durable-chat-avatar" aria-hidden>
              {metadata?.type === "private" ? (
                <PersonIcon />
              ) : metadata?.type === "channel" ? (
                <SpeakerLoudIcon />
              ) : (
                <ChatBubbleIcon />
              )}
            </span>
            <div>
              <div className="durable-chat-name">
                <h2 className={style({ font: "heading-sm" })}>
                  {!validChat
                    ? t("record.chooseChat")
                    : metadataLoading
                      ? t("record.loadingChatName")
                      : metadataError
                        ? t("record.chatNameUnavailable")
                        : metadata
                          ? chatName(metadata)
                          : t("record.chatNameUnknown")}
                </h2>
                {metadata?.type && (
                  <span className="durable-chat-type">{chatTypeLabel(metadata.type)}</span>
                )}
              </div>
              {validChat && (
                <div
                  className={style({
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                  })}
                >
                  <span>
                    <code>{chat}</code>
                    {metadata ? ` · ${chatTypeLabel(metadata.type)}` : ""}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        <div
          className={`durable-header-actions ${style({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 })}`}
        >
          <span className="durable-read-only">
            <StatusLabel>{t("record.readOnly")}</StatusLabel>
          </span>
          {validChat && (
            <Button
              variant="accent"
              aria-label={t("record.refresh")}
              isDisabled={!current && !selection}
              onPress={() => {
                historyTarget.current = undefined
                setReadLocation(readContextLocation(location))
                setPages([undefined])
                setRefresh((value) => value + 1)
              }}
            >
              <ReloadIcon aria-hidden />
              <span className="durable-action-label">{t("record.refresh")}</span>
            </Button>
          )}
          <Button
            variant="secondary"
            fillStyle="outline"
            isDisabled={!validChat}
            aria-pressed={readingFocus}
            aria-label={t(readingFocus ? "record.restoreReading" : "record.expandReading")}
            onPress={() => setReadingFocus(!readingFocus)}
          >
            {readingFocus ? (
              <ExitFullScreenIcon aria-hidden />
            ) : (
              <EnterFullScreenIcon aria-hidden />
            )}
            <span className="durable-action-label">
              {t(readingFocus ? "record.restoreReading" : "record.expandReading")}
            </span>
          </Button>
        </div>
      </header>
      {validChat && (
        <div className="reading-cache-status" role="status">
          <span className="reading-cache-state">{t("record.persistedNotLive")}</span>
          {data?.readAt && (
            <span className="reading-cache-time">
              <span>{t("record.cache")}</span>{" "}
              <time
                dateTime={data.readAt}
                title={t("record.cachedAt", { time: formatReadTime(data.readAt) })}
              >
                {formatReadTime(data.readAt)}
              </time>
            </span>
          )}
        </div>
      )}
      {metadataError && (
        <div>
          <Prose role="alert">{metadataError}</Prose>
          {onMetadataRetry && (
            <Button variant="secondary" onPress={onMetadataRetry}>
              {t("record.retryMetadata")}
            </Button>
          )}
        </div>
      )}
    </>
  )
  const historyContext = (
    <>
      {validChat && (
        <Panel
          className="durable-inspection-context"
          aria-label={t("record.inspectionContext")}
          aria-live="polite"
        >
          <h3 className={style({ font: "heading-sm" })}>
            {data?.state === "not-loaded"
              ? t("record.noLoadedSessionInspect")
              : sessionDocuments
                ? t("record.inspectingSessionDocuments")
                : location.view === "conversations" && !current && !location.objectId
                  ? t("record.loadingConversationList")
                  : inspectedConversation
                    ? t("record.inspectingConversation", { id: inspectedConversation })
                    : t("record.chooseConversationInspect")}
          </h3>
          <Prose>
            {data?.state === "not-loaded"
              ? t("record.noSessionWork")
              : sessionDocuments
                ? t("record.sessionDocumentsScope")
                : inspectedConversation
                  ? selected
                    ? inspectedConversation === selected.id
                      ? t("record.selectedNotice")
                      : t("record.notPersistedSelection", { id: selected.id })
                    : t("record.selectionUnconfirmed")
                  : t("record.useConversationList")}
          </Prose>
          {conversation?.parent && (
            <Prose>
              {linkedSentence("record.branchedLinks", {
                conversation: link(
                  t("record.conversationLink", { id: conversation.parent.conversationId }),
                  {
                    view: "conversations",
                    objectId: conversation.parent.conversationId,
                  },
                ),
                entry: link(t("record.entryLink", { id: conversation.parent.at }), {
                  view: "entries",
                  conversationId: conversation.parent.conversationId,
                  objectId: conversation.parent.at,
                }),
              })}
            </Prose>
          )}
          {!sessionDocuments &&
            inspectedConversation &&
            !conversation &&
            selection?.data?.state === "loaded" && (
              <Prose size="2">{t("record.relationshipMissing")}</Prose>
            )}
          {conversation?.owner && (
            <Prose>
              {linkedSentence("record.ownedLinks", {
                owner: link(
                  t("record.taskInConversation", {
                    task: conversation.owner.taskId,
                    conversation: conversation.owner.conversationId,
                  }),
                  {
                    view: "tasks",
                    conversationId: conversation.owner.conversationId,
                    objectId: conversation.owner.taskId,
                  },
                ),
              })}
            </Prose>
          )}
        </Panel>
      )}
      {validChat && (
        <Panel className="durable-overview" aria-label={t("record.durableOverview")}>
          <h3 className={style({ font: "heading-xs" })}>{t("record.persistedSessionContext")}</h3>
          <div className="durable-overview-grid">
            <Panel
              aria-label={t("record.selectionDetails")}
              aria-live="polite"
              aria-busy={!selection}
            >
              <h4 className={style({ font: "heading-xs" })}>{t("record.selectedConversation")}</h4>
              {!selection ? (
                <Prose role="status">{t("record.loadingSelection")}</Prose>
              ) : selection.error ? (
                <Prose role="alert">{readError(selection)}</Prose>
              ) : selection.data?.state === "not-loaded" ? (
                <Prose>{t("record.noLoadedSession")}</Prose>
              ) : selected ? (
                <>
                  <Prose>{t("record.conversationNumber", { id: selected.id })}</Prose>
                  <div className={style({ display: "flex", flexWrap: "wrap", gap: 12 })}>
                    {link(t("record.inspectSelected"), {
                      view: "conversations",
                      objectId: selected.id,
                    })}
                    {link(t("record.viewSelectedTasks"), {
                      view: "tasks",
                      conversationId: selected.id,
                    })}
                  </div>
                  {(selected.parent || selected.owner) && (
                    <details className="durable-selection-relationships">
                      <summary>{t("record.selectionRelationships")}</summary>
                      <Prose size="2">
                        {selected.parent && (
                          <>
                            {t("record.parent")}{" "}
                            {link(
                              t("record.conversationLink", { id: selected.parent.conversationId }),
                              {
                                view: "conversations",
                                objectId: selected.parent.conversationId,
                              },
                            )}{" "}
                            · {t("record.fork")}{" "}
                            {link(t("record.entryLink", { id: selected.parent.at }), {
                              view: "entries",
                              conversationId: selected.parent.conversationId,
                              objectId: selected.parent.at,
                            })}
                          </>
                        )}
                        {selected.parent && selected.owner ? " · " : ""}
                        {selected.owner && (
                          <>
                            {t("record.owner")}{" "}
                            {link(t("record.taskLink", { id: selected.owner.taskId }), {
                              view: "tasks",
                              conversationId: selected.owner.conversationId,
                              objectId: selected.owner.taskId,
                            })}
                          </>
                        )}
                      </Prose>
                    </details>
                  )}
                </>
              ) : (
                <Prose>
                  {selected === null
                    ? t("record.noSelectionMetadata")
                    : t("record.selectionUnavailable")}
                </Prose>
              )}
              {readTime(selection)}
              {inspectedConversation && inspectedConversation !== selected?.id && (
                <Prose size="2">
                  {t("record.inspectionTarget", { id: inspectedConversation })}
                </Prose>
              )}
            </Panel>
            <Panel
              aria-label={t("record.selectedTaskHistory")}
              aria-live="polite"
              aria-busy={Boolean(selected && !history)}
            >
              <h4 className={style({ font: "heading-xs" })}>{t("record.persistedTaskHistory")}</h4>
              {selected ? (
                !history ? (
                  <Prose role="status">{t("record.loadingTaskHistory")}</Prose>
                ) : history.error ? (
                  <Prose role="alert">{readError(history)}</Prose>
                ) : history.data?.state === "not-loaded" ? (
                  <Prose>{t("record.sessionNoLongerLoaded")}</Prose>
                ) : (
                  <>
                    <Prose>
                      {t(
                        history.data?.nextCursor || history.data?.truncated
                          ? "record.taskPageCountMore"
                          : "record.taskPageCount",
                        { count: countText(history.data?.items.length ?? 0, "task record") },
                      )}
                    </Prose>
                    {!history.data?.items.length ? (
                      <Prose size="2">{t("record.noTaskHistory")}</Prose>
                    ) : (
                      <ul className="durable-history">
                        {history.data.items.map(
                          (item) =>
                            item.type === "task" && (
                              <li key={item.id}>
                                {link(t("record.taskNumber", { id: item.id }), {
                                  view: "tasks",
                                  conversationId: item.conversationId,
                                  objectId: item.id,
                                })}
                                {" · "}
                                {recordTitle(item)} · {taskObservation(item)}
                              </li>
                            ),
                        )}
                      </ul>
                    )}
                  </>
                )
              ) : (
                <Prose>
                  {selection?.error
                    ? t("record.selectionReadUnavailable")
                    : selected === null
                      ? t("record.noSelectionMetadataRead")
                      : t("record.taskHistoryUnavailable")}
                </Prose>
              )}
              {readTime(history)}
            </Panel>
          </div>
        </Panel>
      )}
    </>
  )
  const viewNavigation = (
    <>
      {validChat && (
        <nav className="durable-view-navigation" aria-label={t("record.recordViews")}>
          {(["history", "conversations"] as const).map((view) => {
            const target: DurableLocation =
              view === "history"
                ? { view, conversationId: inspectedConversation ?? selected?.id }
                : { view, objectId: inspectedConversation ?? selected?.id }
            return (
              <a
                key={view}
                href={durableHref(chat, target)}
                aria-current={
                  (location.view === "history") === (view === "history") ? "page" : undefined
                }
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
                  navigate(target)
                }}
              >
                {view === "history" ? t("record.history") : t("record.branchView")}
              </a>
            )
          })}
        </nav>
      )}
    </>
  )
  return (
    <section
      className="durable-inspector"
      data-reading-focus={readingFocus}
      aria-label={t("record.inspector")}
    >
      <div className="durable-chat-workspace" data-directory-collapsed={directoryCollapsed}>
        {chatSelector && (
          <aside
            className="durable-directory-pane"
            hidden={readingFocus}
            aria-label={t("record.chatDirectory")}
          >
            <Button
              variant="secondary"
              UNSAFE_className="directory-collapse"
              aria-expanded={!directoryCollapsed}
              aria-label={t(directoryCollapsed ? "record.showDirectory" : "record.hideDirectory")}
              onPress={() => setDirectoryCollapsed(!directoryCollapsed)}
            >
              {directoryCollapsed ? (
                <ChevronRightIcon aria-hidden />
              ) : (
                <ChevronLeftIcon aria-hidden />
              )}
            </Button>
            <details
              className="durable-chat-picker"
              hidden={directoryCollapsed}
              open={wide || !validChat}
            >
              <summary aria-label={t("record.findChat")}>
                <ChatBubbleIcon aria-hidden />
                <span>{validChat ? t("record.switchChat") : t("record.chooseChat")}</span>
              </summary>
              <div className="durable-chat-directory">{chatSelector}</div>
            </details>
          </aside>
        )}
        <div className="durable-reader-pane">
          {header}
          <div className="durable-record-toolbar">
            {(location.view !== "history" || !inspectedConversation) && viewNavigation}
            <div className="durable-context-bar" hidden={!validChat}>
              <section
                className="durable-context-cell"
                aria-label={t("record.inspectedConversationId")}
              >
                <span className="durable-context-icon" aria-hidden>
                  <FileTextIcon />
                </span>
                <div>
                  <span className="durable-context-key">{t("record.conversationId")}</span>
                  <strong>
                    {sessionDocuments
                      ? t("record.sessionScope")
                      : (inspectedConversation ?? t("record.notSelected"))}
                  </strong>
                </div>
              </section>
              <section
                aria-label={t("record.persistedSelection")}
                className="durable-persisted-compact"
              >
                <span className="durable-context-icon" aria-hidden>
                  <ChatBubbleIcon />
                </span>
                <div>
                  <span className="durable-context-key">{t("record.savedConversation")}</span>
                  <strong>
                    {!selection
                      ? t("record.loading")
                      : selection.error
                        ? t("record.unavailable")
                        : selected
                          ? link(t("record.conversationNumber", { id: selected.id }), {
                              view: "conversations",
                              objectId: selected.id,
                            })
                          : selection.data?.state === "not-loaded"
                            ? t("record.noLoadedSessionShort")
                            : t("record.notRecorded")}
                  </strong>
                </div>
              </section>
              <section
                className="durable-context-cell durable-inspected-compact"
                aria-label={t("record.currentTarget")}
              >
                <span className="durable-context-icon" aria-hidden>
                  <MagnifyingGlassIcon />
                </span>
                <div>
                  <span className="durable-context-key">{t("record.inspectionContext")}</span>
                  <span>
                    {sessionDocuments
                      ? t("record.inspectingSessionDocuments")
                      : inspectedConversation
                        ? t("record.inspectingConversationCapital", { id: inspectedConversation })
                        : t("record.chooseConversation")}
                  </span>
                </div>
              </section>
            </div>
          </div>
          {!validChat ? (
            <Panel
              className="durable-unselected"
              aria-label={t("record.chooseChatForConversation")}
            >
              <h2 className={style({ font: "heading-sm" })}>{t("record.chooseChat")}</h2>
              <Prose>{t("record.searchChatsNotice")}</Prose>
              <Prose>{t("record.noChatSelected")}</Prose>
            </Panel>
          ) : (
            <>
              {location.view === "history" ? (
                inspectedConversation ? (
                  <DurableHistory
                    key={`${chat}:${refresh}:${inspectedConversation}`}
                    conversationId={inspectedConversation}
                    data={data}
                    error={readError(current) ?? readError(selection)}
                    page={pages.length}
                    selectedId={location.objectId}
                    wide={wide}
                    navigation={viewNavigation}
                    entryHref={(id) =>
                      durableHref(chat, {
                        view: "history",
                        conversationId: inspectedConversation,
                        objectId: id,
                      })
                    }
                    onSelect={(id) => {
                      const next: DurableLocation = {
                        view: "history",
                        conversationId: inspectedConversation,
                        objectId: id,
                      }
                      window.history.pushState(null, "", durableHref(chat, next))
                      setLocation(next)
                    }}
                    onPrevious={() => {
                      if (location.objectId) {
                        const next = { ...location, objectId: undefined }
                        window.history.pushState(null, "", durableHref(chat, next))
                        setLocation(next)
                      }
                      setPages((value) => value.slice(0, -1))
                    }}
                    onNext={() => {
                      if (location.objectId) {
                        const next = { ...location, objectId: undefined }
                        window.history.pushState(null, "", durableHref(chat, next))
                        setLocation(next)
                      }
                      setPages((value) => [
                        ...value,
                        data?.state === "loaded" ? data.nextCursor : undefined,
                      ])
                    }}
                    readEntry={readHistoryEntry}
                    renderDetail={row}
                    onSessionExpired={onSessionExpired}
                  />
                ) : (
                  <Panel aria-live="polite">
                    {!current ? (
                      <Prose role="status">{t("record.loadingHistory")}</Prose>
                    ) : current.error ? (
                      <Prose role="alert">{readError(current)}</Prose>
                    ) : data?.state === "not-loaded" ? (
                      <>
                        <h3 className={style({ font: "heading-xs" })}>{t("record.notLoaded")}</h3>
                        <Prose>{t("record.noLoadedChat")}</Prose>
                      </>
                    ) : (
                      <Prose>{t("record.noPersistedConversation")}</Prose>
                    )}
                  </Panel>
                )
              ) : (
                <div className="durable-explorer">
                  <details ref={browser} className="durable-record-browser" open={wide}>
                    <summary className="durable-browse-trigger">
                      <LayersIcon aria-hidden />
                      <span>{t("record.browseRecords")}</span>
                      <span className="durable-browse-current">
                        {detail
                          ? `${recordTypeLabel(detail.type)} #${detail.id}`
                          : location.objectId
                            ? `${labels()[location.view]} #${location.objectId}`
                            : labels()[location.view]}
                      </span>
                      <ChevronDownIcon aria-hidden />
                    </summary>
                    <DurableTree
                      key={`${chat}:${refresh}`}
                      chat={chat}
                      conversations={[
                        ...(selection?.data?.items ?? []).filter(
                          (item): item is DurableConversationItem => item.type === "conversation",
                        ),
                        ...(selected ? [selected] : []),
                        ...(conversation ? [conversation] : []),
                      ]}
                      target={inspectedConversation}
                      selected={selected?.id}
                      nextCursor={
                        selection?.data?.state === "loaded" ? selection.data.nextCursor : undefined
                      }
                      truncated={selection?.data?.truncated}
                      link={link}
                      read={readTreePage}
                      path={(next, cursor) => inspectionPath(chat, next, cursor)}
                      onSessionExpired={onSessionExpired}
                    />
                  </details>
                  <div className="durable-selected-area">
                    <div aria-live="polite" aria-busy={!missing && !current}>
                      {(!detail ||
                        current?.error ||
                        current?.unavailable ||
                        data?.state === "not-loaded") && (
                        <h3
                          tabIndex={-1}
                          ref={detailHeading}
                          className={`durable-detail-heading durable-empty-heading ${style({ font: "heading-xs" })}`}
                        >
                          {t("record.selectedRecord")}
                        </h3>
                      )}
                      {missing ? (
                        <Prose>{missing}</Prose>
                      ) : !current ? (
                        <Prose role="status">{t("record.loadingDurable")}</Prose>
                      ) : current.unavailable ? (
                        <Prose role="status">{t("record.retiredScope")}</Prose>
                      ) : current.error ? (
                        <Prose role="alert">{readError(current)}</Prose>
                      ) : data?.state === "not-loaded" ? (
                        <div>
                          <h3 className={style({ font: "heading-xs" })}>{t("record.notLoaded")}</h3>
                          <Prose>{t("record.noLoadedChat")}</Prose>
                        </div>
                      ) : !detail ? (
                        <Prose>
                          {location.objectId
                            ? t("record.retiredUnavailable")
                            : t("record.emptyView")}
                        </Prose>
                      ) : (
                        row(detail)
                      )}
                      {data?.truncated && (
                        <Prose role="status">{t("record.serverTruncated")}</Prose>
                      )}
                      {current !== selection && current !== history && readTime(current)}
                    </div>
                    <details className="durable-raw-collections">
                      <summary>{t("record.rawCollections")}</summary>
                      <Tabs
                        selectedKey={location.view}
                        onSelectionChange={(view) =>
                          navigate({
                            view: view as DurableInspectionView,
                            ...(view === "conversations"
                              ? { objectId: inspectedConversation ?? selected?.id }
                              : { conversationId: inspectedConversation ?? selected?.id }),
                            taskId: location.taskId,
                            ...(view === "documents"
                              ? {
                                  scope:
                                    inspectedConversation || selected ? "conversation" : "session",
                                }
                              : {}),
                          })
                        }
                      >
                        <TabList aria-label={t("record.objectViews")}>
                          {views.map((view) => (
                            <Tab key={view} id={view}>
                              {labels()[view]}
                            </Tab>
                          ))}
                        </TabList>
                        <TabPanel id={location.view}>
                          {location.view === "documents" && (
                            <label htmlFor="durable-scope">
                              {t("record.documentScope")}
                              <SectionPicker
                                value={location.scope ?? "conversation"}
                                onValueChange={(scope) =>
                                  navigate({
                                    view: "documents",
                                    conversationId: location.conversationId,
                                    taskId: location.taskId,
                                    scope: scope as DurableDocumentScope,
                                  })
                                }
                                id="durable-scope"
                                aria-label={t("record.documentScope")}
                              >
                                <PickerOption id="session">{t("record.session")}</PickerOption>
                                <PickerOption id="conversation">
                                  {t("record.conversation")}
                                </PickerOption>
                                <PickerOption id="task">{t("record.task")}</PickerOption>
                              </SectionPicker>
                            </label>
                          )}
                          {location.objectId && (
                            <Prose>
                              {t("record.objectNumber", { id: location.objectId })}{" "}
                              {link(
                                t("record.backTo", {
                                  label: labels()[location.view].toLowerCase(),
                                }),
                                {
                                  ...location,
                                  objectId: undefined,
                                },
                              )}
                            </Prose>
                          )}
                          <div aria-live="polite" aria-busy={!missing && !current}>
                            {missing ? (
                              <Prose>{missing}</Prose>
                            ) : !current ? (
                              <Prose role="status">{t("record.loadingDurable")}</Prose>
                            ) : current.unavailable ? (
                              <Prose role="status">{t("record.retiredScope")}</Prose>
                            ) : current.error ? (
                              <Prose role="alert">{readError(current)}</Prose>
                            ) : (
                              data && (
                                <>
                                  {current !== selection &&
                                    current !== history &&
                                    readTime(current)}
                                  {data.state === "not-loaded" ? (
                                    <Panel>
                                      <h3 className={style({ font: "heading-xs" })}>
                                        {t("record.notLoaded")}
                                      </h3>
                                      <Prose>{t("record.noLoadedChat")}</Prose>
                                    </Panel>
                                  ) : (
                                    <>
                                      {data.truncated && (
                                        <Prose role="status">{t("record.serverTruncated")}</Prose>
                                      )}
                                      {!data.items.length ? (
                                        <Prose>
                                          {location.objectId
                                            ? t("record.retiredUnavailable")
                                            : t("record.emptyView")}
                                        </Prose>
                                      ) : (
                                        <div className="durable-browser">
                                          <ul
                                            className="durable-objects durable-compact-list"
                                            aria-label={t("record.metadataList", {
                                              label: labels()[location.view],
                                            })}
                                          >
                                            {data.items.map((item) => (
                                              <li key={`${item.type}:${item.id}`}>
                                                <button
                                                  type="button"
                                                  aria-pressed={detail?.id === item.id}
                                                  aria-label={t("record.selectRecord", {
                                                    title: recordTitle(item),
                                                    type: recordTypeLabel(item.type),
                                                    id: item.id,
                                                  })}
                                                  onClick={() => setDetailId(item.id)}
                                                  aria-describedby={`durable-summary-${item.type}-${item.id}${item.type === "task" ? " durable-history-warning" : ""}`}
                                                >
                                                  <strong>{recordTitle(item)}</strong>
                                                  <span
                                                    id={`durable-summary-${item.type}-${item.id}`}
                                                  >
                                                    {recordSummary(item)}
                                                  </span>
                                                  <span className="durable-record-id">
                                                    {recordTypeLabel(item.type)} #{item.id}
                                                  </span>
                                                </button>
                                                {item.type === "entry" &&
                                                  !item.content &&
                                                  link(t("record.inspectEntry", { id: item.id }), {
                                                    ...location,
                                                    objectId: item.id,
                                                  })}
                                                {item.type === "document" &&
                                                  item.valueState === "metadata-only" &&
                                                  !location.objectId &&
                                                  link(
                                                    t("record.inspectDocument", { id: item.id }),
                                                    {
                                                      ...location,
                                                      objectId: item.id,
                                                    },
                                                  )}
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      <div
                                        className={style({
                                          display: "flex",
                                          alignItems: "center",
                                          flexWrap: "wrap",
                                          gap: 12,
                                        })}
                                      >
                                        <Button
                                          variant="secondary"
                                          isDisabled={pages.length === 1}
                                          onPress={() => setPages((value) => value.slice(0, -1))}
                                        >
                                          {t("record.previousObjects")}
                                        </Button>
                                        <Button
                                          variant="secondary"
                                          isDisabled={!data.nextCursor}
                                          onPress={() =>
                                            setPages((value) => [...value, data.nextCursor])
                                          }
                                        >
                                          {t("record.nextObjects")}
                                        </Button>
                                        <span>{t("record.page", { page: pages.length })}</span>
                                      </div>
                                    </>
                                  )}
                                </>
                              )
                            )}
                          </div>
                        </TabPanel>
                      </Tabs>
                    </details>
                  </div>
                </div>
              )}
              <details className="durable-history-context">
                <summary>{t("record.historyContext")}</summary>
                <div
                  className={style({
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                  })}
                >
                  <Button variant="secondary" onPress={onChats}>
                    <MixerHorizontalIcon aria-hidden />
                    {t("record.openChatSettings")}
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(chat))
                        .then(
                          () => setCopyIdState("record.chatIdCopied"),
                          () => setCopyIdState("record.copyChatIdFailed"),
                        )
                    }}
                  >
                    <CopyIcon aria-hidden />
                    {t("record.copyChatId")}
                  </Button>
                  {copyIdState && <span role="status">{t(copyIdState)}</span>}
                </div>
                {historyContext}
              </details>
              <details className="durable-advanced">
                <summary>{t("record.advancedInspection")}</summary>
                <form onSubmit={selectContext} className="durable-context">
                  <label htmlFor="durable-conversation">
                    {t("record.conversationId")}
                    <input
                      className="policy-field durable-context-field"
                      id="durable-conversation"
                      inputMode="numeric"
                      value={conversationDraft}
                      onChange={(event) => setConversationDraft(event.target.value)}
                    />
                  </label>
                  <label htmlFor="durable-task">
                    {t("record.taskId")}
                    <input
                      className="policy-field durable-context-field"
                      id="durable-task"
                      inputMode="numeric"
                      value={taskDraft}
                      onChange={(event) => setTaskDraft(event.target.value)}
                    />
                  </label>
                  <Button variant="secondary" type="submit">
                    {t("record.inspectIds")}
                  </Button>
                  {inputError && <span role="alert">{t(inputError)}</span>}
                </form>
              </details>
            </>
          )}
          <details className="durable-limits">
            <summary>{t("record.dataScope")}</summary>
            <Prose id="durable-history-warning">{t("record.readOnlyNotLive")}</Prose>
            <Prose size="2">{t("record.scopeNotice")}</Prose>
          </details>
        </div>
      </div>
    </section>
  )
}
