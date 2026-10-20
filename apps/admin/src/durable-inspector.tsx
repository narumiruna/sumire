import type {
  Chat,
  DurableConversationItem,
  DurableDocumentScope,
  DurableEntryItem,
  DurableInspectionItem,
  DurableInspectionQuery,
  DurableInspectionResponse,
  DurableInspectionView,
  DurableNumericUsage,
} from "@narumitw/sumire-contracts"
import {
  ChevronDownIcon,
  CopyIcon,
  LayersIcon,
  MixerHorizontalIcon,
  ReloadIcon,
} from "@radix-ui/react-icons"
import { Button, Flex, Heading, Tabs, Text, TextField } from "@radix-ui/themes"
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { chatName } from "./chat-directory.js"
import {
  formatDurableTime,
  formatReadTime,
  recordBadge,
  recordIcon,
  recordMetadata,
  recordSummary,
  recordTitle,
  recordTone,
  taskObservation,
} from "./durable-presentation.js"
import { DurableTree } from "./durable-tree.js"
import { navigationHref } from "./navigation.js"
import { SectionSelect as Select } from "./sections.js"
import { countText } from "./status-text.js"
import { Panel } from "./surfaces.js"

const views = ["conversations", "tasks", "documents", "entries"] as const
const labels = {
  conversations: "Conversations",
  tasks: "Tasks",
  documents: "Documents",
  entries: "Entries",
}
export type DurableLocation = Omit<DurableInspectionQuery, "limit" | "cursor">
const positiveId = (value: string | null) =>
  value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined

export function readDurableLocation(url: URL): DurableLocation {
  const raw = url.searchParams.get("view")
  const view = views.find((value) => value === raw) ?? "conversations"
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

function contextNeeded(location: DurableLocation) {
  if (
    location.view === "conversations" ||
    (location.view === "documents" && location.scope === "session")
  )
    return ""
  if (!location.conversationId) return "Select a conversation to inspect this view."
  if (location.view === "documents" && location.scope === "task" && !location.taskId)
    return "Select a task to inspect task documents."
  return ""
}

type ReadBlock = {
  data?: DurableInspectionResponse
  error?: string
  unavailable?: boolean
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
  const requestedPath = inspectionPath(chat, location, cursor)
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

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  const [copyState, setCopyState] = useState("")
  const json = JSON.stringify(value, null, 2)
  return (
    <details className="durable-json">
      <summary>{label}</summary>
      <Button
        variant="soft"
        size="1"
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(json))
            .then(
              () => setCopyState("JSON copied."),
              () => setCopyState("Copy failed. Select and copy the JSON below."),
            )
        }}
      >
        Copy {label}
      </Button>
      {copyState && (
        <Text as="p" role="status">
          {copyState}
        </Text>
      )}
      <pre>{json}</pre>
    </details>
  )
}

export function EntryContent({
  content,
  toolName,
}: {
  content: NonNullable<DurableEntryItem["content"]>
  toolName?: string
}) {
  const roles = {
    system: "System",
    user: "User",
    assistant: "Assistant",
    toolResult: "Tool result",
  }
  return (
    <section aria-label="Entry content" className="durable-entry-content">
      {content.truncated && (
        <Text as="p" role="status">
          Content truncated · inspection limits were reached. Messages, blocks, or text may be
          incomplete.
        </Text>
      )}
      {content.messages.length === 0 && (
        <Text as="p">
          {content.truncated
            ? "No message content included in this response."
            : "No message content recorded."}
        </Text>
      )}
      {content.messages.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A read-only message snapshot has no message IDs.
        <section key={index} aria-label={`Message ${index + 1}`} className="durable-entry-message">
          <div className="durable-message-heading">
            <Heading as="h4" size="2">
              {content.messages.length > 1
                ? roles[message.role]
                : message.role === "toolResult"
                  ? "Output"
                  : "Message"}
            </Heading>
            {message.toolName !== undefined &&
              (content.messages.length > 1 || message.toolName !== toolName) && (
                <span>{message.toolName}</span>
              )}
            {(message.role === "toolResult" || message.isError !== undefined) && (
              <span className="durable-tree-badge">
                {message.isError === undefined
                  ? "Result not recorded"
                  : message.isError
                    ? "Recorded error"
                    : "Recorded result · not an error"}
              </span>
            )}
          </div>
          {message.content.length === 0 && (
            <Text as="p">
              {content.truncated
                ? "No content blocks included in this response."
                : "No content blocks recorded."}
            </Text>
          )}
          {message.content.map((block, blockIndex) => {
            switch (block.type) {
              case "text":
                return message.role === "toolResult" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs in this snapshot.
                  <pre className="durable-tool-output" key={blockIndex}>
                    {block.text}
                  </pre>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs in this snapshot.
                  <p className="durable-message-text" key={blockIndex}>
                    {block.text}
                  </p>
                )
              case "thinking":
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <details key={blockIndex}>
                    <summary>Thinking</summary>
                    <p className="durable-message-text">{block.thinking}</p>
                  </details>
                )
              case "toolCall":
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <section key={blockIndex} aria-label="Tool call">
                    <div className="durable-message-heading">
                      <Heading as="h5" size="2">
                        {block.name} · Arguments
                      </Heading>
                      <span>JSON text</span>
                    </div>
                    <pre className="durable-arguments">{block.arguments}</pre>
                    <details className="durable-message-details">
                      <summary>Tool call details</summary>
                      <dl className="durable-metadata">
                        <dt>Tool name</dt>
                        <dd>{block.name}</dd>
                        <dt>Call ID</dt>
                        <dd>{block.id}</dd>
                      </dl>
                    </details>
                  </section>
                )
              case "image":
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <Text as="p" key={blockIndex}>
                    Image omitted · {block.mimeType}. Image bytes are not sent.
                  </Text>
                )
              default:
                return null
            }
          })}
          {message.toolCallId !== undefined && (
            <details className="durable-message-details">
              <summary>Message details</summary>
              <dl className="durable-metadata">
                <dt>Call ID</dt>
                <dd>{message.toolCallId}</dd>
              </dl>
            </details>
          )}
        </section>
      ))}
    </section>
  )
}

function UsageFields({ usage }: { usage: DurableNumericUsage }) {
  const fields = [
    ["input", "Input"],
    ["output", "Output"],
    ["cacheRead", "Cache read"],
    ["cacheWrite", "Cache write"],
    ["total", "Total"],
  ] as const
  return (
    <dl className="durable-metadata durable-usage">
      {fields.map(([key, label]) => (
        <div className="durable-usage-field" key={key}>
          <dt>{label} tokens</dt>
          <dd>{usage[key] ?? "Not recorded"}</dd>
        </div>
      ))}
      {usage.cost &&
        fields.map(([key, label]) => (
          <div className="durable-usage-field" key={`cost:${key}`}>
            <dt>{label} cost (reported)</dt>
            <dd>{usage.cost?.[key] ?? "Not recorded"}</dd>
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
  const [location, setLocation] = useState(() => readDurableLocation(new URL(window.location.href)))
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
  const [copyIdState, setCopyIdState] = useState("")
  const draftConversationId =
    location.view === "conversations"
      ? (location.objectId ?? location.conversationId)
      : location.conversationId
  const [conversationDraft, setConversationDraft] = useState(String(draftConversationId ?? ""))
  const [taskDraft, setTaskDraft] = useState(String(location.taskId ?? ""))
  const [inputError, setInputError] = useState("")
  useEffect(() => {
    const restore = () => {
      setLocation(readDurableLocation(new URL(window.location.href)))
      setPages([undefined])
    }
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [])
  useEffect(() => {
    setConversationDraft(String(draftConversationId ?? ""))
    setTaskDraft(String(location.taskId ?? ""))
    setInputError("")
  }, [draftConversationId, location.taskId])
  const validChat = /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))
  const missing = contextNeeded(location)
  const path = inspectionPath(chat, location, pages.at(-1))
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
            error:
              error instanceof ApiError && error.status === 403
                ? "Permission denied. This data could not be read."
                : "Read failed. Refresh to retry.",
            unavailable:
              error instanceof ApiError && error.status === 404 && nextPath.includes("objectId="),
          }
        }
      })
    void readDurableContext(chat, location, pages.at(-1), read, (name, block) => {
      if (!controller.signal.aborted)
        setBlocks((value) => ({ ...(value?.key === key ? value : { key }), [name]: block }))
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && error instanceof ApiError && error.status === 401) {
        setBlocks(undefined)
        onSessionExpired()
      }
    })
    return () => controller.abort()
  }, [key, validChat, chat, location, pages, onSessionExpired])

  const navigate = (next: DurableLocation) => {
    window.history.pushState(null, "", durableHref(chat, next))
    setLocation(next)
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
      setInputError("Enter positive whole-number object IDs without leading zeros.")
      return
    }
    setInputError("")
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
      : location.conversationId
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
      <Text as="p" size="1" className="durable-read-time">
        Read time: <time dateTime={block.data.readAt}>{formatReadTime(block.data.readAt)}</time>
      </Text>
    )
  const recordDetails = (item: DurableInspectionItem) => (
    <dl className="durable-metadata">
      {item.type === "conversation" && (
        <>
          <dt>Selection marker</dt>
          <dd>{item.active ? "Persisted selected conversation" : "Historical conversation"}</dd>
          <dt>Parent conversation</dt>
          <dd>
            {item.parent ? (
              <>
                {link(`Conversation ${item.parent.conversationId}`, {
                  view: "conversations",
                  objectId: item.parent.conversationId,
                })}{" "}
                ·{" "}
                {link(`Fork entry ${item.parent.at}`, {
                  view: "entries",
                  conversationId: item.parent.conversationId,
                  objectId: item.parent.at,
                })}
              </>
            ) : (
              "No parent recorded"
            )}
          </dd>
          <dt>Owning task</dt>
          <dd>
            {item.owner
              ? link(`Task ${item.owner.taskId} in conversation ${item.owner.conversationId}`, {
                  view: "tasks",
                  conversationId: item.owner.conversationId,
                  objectId: item.owner.taskId,
                })
              : "No owner recorded"}
          </dd>
        </>
      )}
      {item.type === "task" && (
        <>
          <dt>Conversation</dt>
          <dd>
            {link(`Conversation ${item.conversationId}`, {
              view: "conversations",
              objectId: item.conversationId,
            })}
          </dd>
          <dt>Owning task</dt>
          <dd>
            {item.ownerTaskId
              ? link(`Task ${item.ownerTaskId}`, {
                  view: "tasks",
                  conversationId: item.conversationId,
                  objectId: item.ownerTaskId,
                })
              : "No owner recorded"}
          </dd>
          <dt>Started</dt>
          <dd>{formatDurableTime(item.startedAt)}</dd>
          <dt>Ended</dt>
          <dd>{formatDurableTime(item.endedAt)}</dd>
        </>
      )}
      {item.type === "document" && (
        <>
          <dt>Applies to</dt>
          <dd>
            {item.scope.kind === "conversation"
              ? link(`Conversation ${item.scope.conversationId}`, {
                  view: "conversations",
                  objectId: item.scope.conversationId,
                })
              : item.scope.kind === "task"
                ? link(`Task ${item.scope.taskId}`, {
                    view: "tasks",
                    conversationId: location.conversationId,
                    objectId: item.scope.taskId,
                  })
                : "This session"}
          </dd>
        </>
      )}
      {item.type === "entry" && (
        <>
          <dt>Recorded at</dt>
          <dd>{formatDurableTime(item.timestamp)}</dd>
          <dt>Conversation</dt>
          <dd>
            {link(`Conversation ${item.conversationId}`, {
              view: "conversations",
              objectId: item.conversationId,
            })}
          </dd>
          <dt>Recorded by</dt>
          <dd>
            {item.byTaskId
              ? link(`Task ${item.byTaskId}`, {
                  view: "tasks",
                  conversationId: item.conversationId,
                  objectId: item.byTaskId,
                })
              : "Not recorded"}
          </dd>
          {item.toolName !== undefined && (
            <>
              <dt>Tool name</dt>
              <dd>{item.toolName}</dd>
            </>
          )}
          {item.isError !== undefined && (
            <>
              <dt>Recorded result</dt>
              <dd>{item.isError ? "Error" : "Not an error"}</dd>
            </>
          )}
          {item.toolCallId !== undefined && (
            <>
              <dt>Call ID</dt>
              <dd>{item.toolCallId}</dd>
            </>
          )}
          <dt>Head entry</dt>
          <dd>
            {item.head
              ? link(`Entry ${item.head}`, {
                  view: "entries",
                  conversationId: item.conversationId,
                  objectId: item.head,
                })
              : "Not recorded"}
          </dd>
        </>
      )}
    </dl>
  )
  const row = (item: DurableInspectionItem) => {
    const Icon = recordIcon(item)
    return (
      <section
        key={`${item.type}:${item.id}`}
        className={`durable-detail durable-role-${recordTone(item)}`}
        aria-label="Selected item details"
      >
        <header className="durable-detail-header">
          <div className="durable-detail-identity">
            <span className="durable-detail-icon durable-role-icon">
              <Icon aria-hidden />
            </span>
            <Heading
              as="h3"
              size="4"
              tabIndex={-1}
              ref={detailHeading}
              className="durable-detail-heading"
            >
              {recordTitle(item)}
            </Heading>
          </div>
          <div className="durable-record-meta">
            <span className="durable-record-id durable-detail-record-id">
              {item.type} #{item.id}
            </span>
            {item.type === "entry" && <span>{formatDurableTime(item.timestamp)}</span>}
            {item.type === "task" && <span>{formatDurableTime(item.startedAt)}</span>}
            {item.type !== "conversation" && "conversationId" in item && (
              <span className="durable-conversation-crumb">
                {link(`Conversation ${item.conversationId}`, {
                  view: "conversations",
                  objectId: item.conversationId,
                })}
              </span>
            )}
            {item.type === "entry" &&
              item.byTaskId !== undefined &&
              link(`Task ${item.byTaskId}`, {
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
            <Text as="p" className="durable-record-summary">
              {recordSummary(item)}
            </Text>
          )}
          {item.type === "document" && item.valueState === "available" && !item.value && (
            <Text as="p">Approved fields were not included in this response.</Text>
          )}
          {item.type === "document" && item.valueState === "available" && item.value && (
            <section aria-label="Approved document fields" className="durable-projection">
              <Heading as="h4" size="3">
                Approved fields
              </Heading>
              {item.value.kind === "pi.agent" ? (
                <dl className="durable-metadata">
                  <dt>Model provider</dt>
                  <dd>{item.value.model?.provider ?? "Not recorded"}</dd>
                  <dt>Model</dt>
                  <dd>{item.value.model?.modelId ?? "Not recorded"}</dd>
                  <dt>Thinking level</dt>
                  <dd>{item.value.thinkingLevel ?? "Not recorded"}</dd>
                </dl>
              ) : item.value.kind === "pi.usage" ? (
                <>
                  <Heading as="h5" size="2">
                    Total usage
                  </Heading>
                  <UsageFields usage={item.value.total} />
                  <Heading as="h5" size="2">
                    Per-model usage
                  </Heading>
                  {Object.keys(item.value.models).length === 0 && (
                    <Text as="p" size="2">
                      No per-model usage recorded.
                    </Text>
                  )}
                  {Object.entries(item.value.models).map(([model, usage]) => (
                    <details key={model} className="durable-model-usage">
                      <summary>
                        {model} ·{" "}
                        {usage.total === undefined
                          ? "Total not recorded"
                          : countText(usage.total, "total token")}
                      </summary>
                      <UsageFields usage={usage} />
                    </details>
                  ))}
                </>
              ) : (
                <dl className="durable-metadata">
                  <dt>Persisted selected conversation</dt>
                  <dd>
                    {item.value.activeConversation
                      ? link(`Conversation ${item.value.activeConversation}`, {
                          view: "conversations",
                          objectId: item.value.activeConversation,
                        })
                      : "Not recorded"}
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
          <Flex gap="3" wrap="wrap" className="durable-links">
            {item.type === "conversation" && (
              <>
                {link(`Tasks in conversation ${item.id}`, {
                  view: "tasks",
                  conversationId: item.id,
                })}
                {link(`Documents in conversation ${item.id}`, {
                  view: "documents",
                  scope: "conversation",
                  conversationId: item.id,
                })}
                {link(`Entries in conversation ${item.id}`, {
                  view: "entries",
                  conversationId: item.id,
                })}
              </>
            )}
            {item.type === "task" &&
              link(`Documents for task ${item.id}`, {
                view: "documents",
                scope: "task",
                conversationId: item.conversationId,
                taskId: item.id,
              })}
          </Flex>
        </div>
        <div className="durable-detail-disclosures">
          <details className="durable-record-details">
            <summary>Record details</summary>
            {recordDetails(item)}
            <dl className="durable-metadata">
              {item.type !== "conversation" && (
                <>
                  <dt>Stored kind</dt>
                  <dd>{item.kind}</dd>
                </>
              )}
              {item.type === "task" && (
                <>
                  <dt>Version</dt>
                  <dd>{item.version}</dd>
                  <dt>Stored status</dt>
                  <dd>{item.status}</dd>
                  <dt>Background</dt>
                  <dd>{String(item.background)}</dd>
                  <dt>Abort requested</dt>
                  <dd>{String(item.abortRequested)}</dd>
                </>
              )}
              {item.type === "document" && (
                <>
                  <dt>Family member</dt>
                  <dd>{item.family ? "Yes" : "No"}</dd>
                  <dt>Created sequence</dt>
                  <dd>{item.createdAt}</dd>
                  <dt>Retired sequence</dt>
                  <dd>{item.retiredAt ?? "Not retired"}</dd>
                  <dt>Definition version</dt>
                  <dd>{item.version ?? "Not recorded"}</dd>
                </>
              )}
              {item.type === "entry" && (
                <>
                  <dt>Stored role</dt>
                  <dd>{item.role ?? "Not recorded"}</dd>
                </>
              )}
              {item.type === "conversation" && (
                <>
                  <dt>Persisted selection marker</dt>
                  <dd>{String(item.active)}</dd>
                </>
              )}
            </dl>
          </details>
          <details className="durable-raw-data">
            <summary>Raw data</summary>
            <JsonDetails
              key={`metadata:${item.type}:${item.id}`}
              label={`Metadata JSON for ${item.type} ${item.id}`}
              value={recordMetadata(item)}
            />
            {item.type === "entry" && item.content && (
              <JsonDetails
                key={`content:${item.id}`}
                label={`Content JSON for entry ${item.id}`}
                value={item.content}
              />
            )}
            {item.type === "document" && item.valueState === "available" && item.value && (
              <JsonDetails
                key={`value:${item.id}`}
                label={`Approved value JSON for document ${item.id}`}
                value={item.value}
              />
            )}
          </details>
        </div>
        <footer className="durable-detail-footer">
          Read-only persisted record · not live execution state
        </footer>
      </section>
    )
  }

  const header = (
    <>
      <header className="durable-summary-header">
        <div>
          <Heading as="h2" size="5">
            {!validChat
              ? "Choose a chat"
              : metadataLoading
                ? "Loading chat name…"
                : metadataError
                  ? "Chat name unavailable"
                  : metadata
                    ? chatName(metadata)
                    : "Chat name unknown"}
          </Heading>
          {validChat && (
            <Flex gap="2" align="center" wrap="wrap">
              <Text size="2">
                <code>{chat}</code>
                {metadata ? ` · ${metadata.type}` : ""}
              </Text>
            </Flex>
          )}
        </div>
        {chatSelector}
        <Flex gap="2" wrap="wrap" align="center" className="durable-header-actions">
          <Button
            variant="soft"
            aria-label="Refresh Durable"
            disabled={!validChat || (!current && !selection)}
            onClick={() => {
              setPages([undefined])
              setRefresh((value) => value + 1)
            }}
          >
            <ReloadIcon aria-hidden />
            <span className="durable-action-label">Refresh</span>
          </Button>
        </Flex>
      </header>
      {metadataError && (
        <div>
          <Text as="p" role="alert">
            {metadataError}
          </Text>
          {onMetadataRetry && (
            <Button variant="soft" onClick={onMetadataRetry}>
              Retry chat metadata
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
          aria-label="Inspection context"
          aria-live="polite"
        >
          <Heading as="h3" size="4">
            {data?.state === "not-loaded"
              ? "No loaded session to inspect"
              : sessionDocuments
                ? "Inspecting session documents"
                : location.view === "conversations" && !current && !location.objectId
                  ? "Loading conversation list…"
                  : inspectedConversation
                    ? `Inspecting conversation ${inspectedConversation}`
                    : "Choose a conversation to inspect"}
          </Heading>
          <Text as="p">
            {data?.state === "not-loaded"
              ? "Inspection will not load a session or start work."
              : sessionDocuments
                ? "These documents apply to the session, not one conversation."
                : inspectedConversation
                  ? selected
                    ? inspectedConversation === selected.id
                      ? "This is the persisted selected conversation. Selection does not mean work is running."
                      : "This is not the persisted selected conversation (conversation " +
                        selected.id +
                        "). Inspecting it does not change selection."
                    : "Persisted selection cannot be confirmed from the available metadata."
                  : "Use the conversation list or a related-record link. Inspect an entry to read message content."}
          </Text>
          {conversation?.parent && (
            <Text as="p">
              Branched from{" "}
              {link(`conversation ${conversation.parent.conversationId}`, {
                view: "conversations",
                objectId: conversation.parent.conversationId,
              })}{" "}
              at{" "}
              {link(`entry ${conversation.parent.at}`, {
                view: "entries",
                conversationId: conversation.parent.conversationId,
                objectId: conversation.parent.at,
              })}
              .
            </Text>
          )}
          {!sessionDocuments &&
            inspectedConversation &&
            !conversation &&
            selection?.data?.state === "loaded" && (
              <Text as="p" size="2">
                Relationship metadata is not on the loaded conversation page.
              </Text>
            )}
          {conversation?.owner && (
            <Text as="p">
              Owned by{" "}
              {link(
                "task " +
                  conversation.owner.taskId +
                  " in conversation " +
                  conversation.owner.conversationId,
                {
                  view: "tasks",
                  conversationId: conversation.owner.conversationId,
                  objectId: conversation.owner.taskId,
                },
              )}
              .
            </Text>
          )}
        </Panel>
      )}
      {validChat && (
        <Panel className="durable-overview" aria-label="Durable overview">
          <Heading as="h3" size="3">
            Persisted session context
          </Heading>
          <div className="durable-overview-grid">
            <Panel
              aria-label="Persisted selection details"
              aria-live="polite"
              aria-busy={!selection}
            >
              <Heading as="h4" size="2">
                Selected conversation
              </Heading>
              {!selection ? (
                <Text as="p" role="status">
                  Loading selection…
                </Text>
              ) : selection.error ? (
                <Text as="p" role="alert">
                  {selection.error}
                </Text>
              ) : selection.data?.state === "not-loaded" ? (
                <Text as="p">No loaded session.</Text>
              ) : selected ? (
                <>
                  <Text as="p">Conversation {selected.id}</Text>
                  <Flex gap="3" wrap="wrap">
                    {link("Inspect selected conversation", {
                      view: "conversations",
                      objectId: selected.id,
                    })}
                    {link("View selected tasks", { view: "tasks", conversationId: selected.id })}
                  </Flex>
                  {(selected.parent || selected.owner) && (
                    <details className="durable-selection-relationships">
                      <summary>Selection relationships</summary>
                      <Text as="p" size="2">
                        {selected.parent && (
                          <>
                            Parent{" "}
                            {link(`conversation ${selected.parent.conversationId}`, {
                              view: "conversations",
                              objectId: selected.parent.conversationId,
                            })}{" "}
                            · fork{" "}
                            {link(`entry ${selected.parent.at}`, {
                              view: "entries",
                              conversationId: selected.parent.conversationId,
                              objectId: selected.parent.at,
                            })}
                          </>
                        )}
                        {selected.parent && selected.owner ? " · " : ""}
                        {selected.owner && (
                          <>
                            Owner{" "}
                            {link(`task ${selected.owner.taskId}`, {
                              view: "tasks",
                              conversationId: selected.owner.conversationId,
                              objectId: selected.owner.taskId,
                            })}
                          </>
                        )}
                      </Text>
                    </details>
                  )}
                </>
              ) : (
                <Text as="p">
                  {selected === null
                    ? "No selected-conversation metadata available."
                    : "Selection data unavailable."}
                </Text>
              )}
              {readTime(selection)}
              {inspectedConversation && inspectedConversation !== selected?.id && (
                <Text as="p" size="2">
                  Inspection target: conversation {inspectedConversation}. This does not change
                  persisted selection.
                </Text>
              )}
            </Panel>
            <Panel
              aria-label="Selected conversation task history"
              aria-live="polite"
              aria-busy={Boolean(selected && !history)}
            >
              <Heading as="h4" size="2">
                Task history of persisted selection
              </Heading>
              {selected ? (
                !history ? (
                  <Text as="p" role="status">
                    Loading task history…
                  </Text>
                ) : history.error ? (
                  <Text as="p" role="alert">
                    {history.error}
                  </Text>
                ) : history.data?.state === "not-loaded" ? (
                  <Text as="p">Session no longer loaded.</Text>
                ) : (
                  <>
                    <Text as="p">
                      {countText(history.data?.items.length ?? 0, "task record")} on the loaded page
                      {history.data?.nextCursor || history.data?.truncated
                        ? " · more may exist"
                        : ""}
                      .
                    </Text>
                    {!history.data?.items.length ? (
                      <Text as="p" size="2">
                        No task history on this page.
                      </Text>
                    ) : (
                      <ul className="durable-history">
                        {history.data.items.map(
                          (item) =>
                            item.type === "task" && (
                              <li key={item.id}>
                                {link(`Task ${item.id}`, {
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
                <Text as="p">
                  {selection?.error
                    ? "Unavailable: selection could not be read."
                    : selected === null
                      ? "No selected-conversation metadata to read."
                      : "Task history unavailable."}
                </Text>
              )}
              {readTime(history)}
            </Panel>
          </div>
        </Panel>
      )}
    </>
  )
  return (
    <section className="durable-inspector" aria-label="Durable Inspector">
      {header}
      <div className="durable-context-bar">
        <span>
          <span className="durable-context-key">Inspecting</span>
          <strong>
            {sessionDocuments
              ? "Session documents"
              : inspectedConversation
                ? `Conversation ${inspectedConversation}`
                : "Conversations"}
          </strong>
        </span>
        <section aria-label="Persisted selection" className="durable-persisted-compact">
          <span className="durable-context-key">Persisted selection</span>
          <strong>
            {!selection
              ? "Loading…"
              : selection.error
                ? "Unavailable"
                : selected
                  ? link(`Conversation ${selected.id}`, {
                      view: "conversations",
                      objectId: selected.id,
                    })
                  : selection.data?.state === "not-loaded"
                    ? "No loaded session"
                    : "Not recorded"}
          </strong>
        </section>
      </div>
      {!validChat ? (
        <Panel>
          <Text as="p">Select a chat above to inspect Durable.</Text>
        </Panel>
      ) : (
        <>
          <div className="durable-explorer">
            <details ref={browser} className="durable-record-browser" open={wide}>
              <summary className="durable-browse-trigger">
                <LayersIcon aria-hidden />
                <span>Browse records</span>
                <span className="durable-browse-current">
                  {detail
                    ? `${detail.type} #${detail.id}`
                    : location.objectId
                      ? `${location.view} #${location.objectId}`
                      : labels[location.view]}
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
                  <Heading
                    as="h3"
                    size="3"
                    tabIndex={-1}
                    ref={detailHeading}
                    className="durable-detail-heading durable-empty-heading"
                  >
                    Selected record
                  </Heading>
                )}
                {missing ? (
                  <Text as="p">{missing}</Text>
                ) : !current ? (
                  <Text as="p" role="status">
                    Loading Durable…
                  </Text>
                ) : current.unavailable ? (
                  <Text as="p" role="status">
                    Retired or unavailable. The object is no longer available in this scope.
                  </Text>
                ) : current.error ? (
                  <Text as="p" role="alert">
                    {current.error}
                  </Text>
                ) : data?.state === "not-loaded" ? (
                  <div>
                    <Heading as="h3" size="3">
                      Not loaded
                    </Heading>
                    <Text as="p">
                      This chat has no loaded session. Inspection will not open its database or
                      start a session.
                    </Text>
                  </div>
                ) : !detail ? (
                  <Text as="p">
                    {location.objectId
                      ? "Retired or unavailable"
                      : "Empty · no records in this view."}
                  </Text>
                ) : (
                  row(detail)
                )}
                {data?.truncated && (
                  <Text as="p" role="status">
                    Truncated · the server read limit was reached. Some records are not shown.
                  </Text>
                )}
                {current !== selection && current !== history && readTime(current)}
              </div>
              <details className="durable-raw-collections">
                <summary>Raw collections</summary>
                <Tabs.Root
                  value={location.view}
                  onValueChange={(view) =>
                    navigate({
                      view: view as DurableInspectionView,
                      ...(view === "conversations"
                        ? { objectId: inspectedConversation ?? selected?.id }
                        : { conversationId: inspectedConversation ?? selected?.id }),
                      taskId: location.taskId,
                      ...(view === "documents"
                        ? { scope: inspectedConversation || selected ? "conversation" : "session" }
                        : {}),
                    })
                  }
                >
                  <Tabs.List aria-label="Durable object views">
                    {views.map((view) => (
                      <Tabs.Trigger key={view} value={view}>
                        {labels[view]}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>
                  <Tabs.Content value={location.view}>
                    {location.view === "documents" && (
                      <label htmlFor="durable-scope">
                        Document scope
                        <Select.Root
                          value={location.scope ?? "conversation"}
                          onValueChange={(scope) =>
                            navigate({
                              view: "documents",
                              conversationId: location.conversationId,
                              taskId: location.taskId,
                              scope: scope as DurableDocumentScope,
                            })
                          }
                        >
                          <Select.Trigger id="durable-scope" aria-label="Document scope" />
                          <Select.Content>
                            <Select.Item value="session">Session</Select.Item>
                            <Select.Item value="conversation">Conversation</Select.Item>
                            <Select.Item value="task">Task</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </label>
                    )}
                    {location.objectId && (
                      <Text as="p">
                        Object #{location.objectId} ·{" "}
                        {link(`Back to ${labels[location.view].toLowerCase()}`, {
                          ...location,
                          objectId: undefined,
                        })}
                      </Text>
                    )}
                    <div aria-live="polite" aria-busy={!missing && !current}>
                      {missing ? (
                        <Text as="p">{missing}</Text>
                      ) : !current ? (
                        <Text as="p" role="status">
                          Loading Durable…
                        </Text>
                      ) : current.unavailable ? (
                        <Text as="p" role="status">
                          Retired or unavailable. The object is no longer available in this scope.
                        </Text>
                      ) : current.error ? (
                        <Text as="p" role="alert">
                          {current.error}
                        </Text>
                      ) : (
                        data && (
                          <>
                            {current !== selection && current !== history && readTime(current)}
                            {data.state === "not-loaded" ? (
                              <Panel>
                                <Heading as="h3" size="3">
                                  Not loaded
                                </Heading>
                                <Text as="p">
                                  This chat has no loaded session. Inspection will not open its
                                  database or start a session.
                                </Text>
                              </Panel>
                            ) : (
                              <>
                                {data.truncated && (
                                  <Text as="p" role="status">
                                    Truncated · the server read limit was reached. Some records are
                                    not shown.
                                  </Text>
                                )}
                                {!data.items.length ? (
                                  <Text as="p">
                                    {location.objectId
                                      ? "Retired or unavailable"
                                      : "Empty · no records in this view."}
                                  </Text>
                                ) : (
                                  <div className="durable-browser">
                                    <ul
                                      className="durable-objects durable-compact-list"
                                      aria-label={`${labels[location.view]} metadata`}
                                    >
                                      {data.items.map((item) => (
                                        <li key={`${item.type}:${item.id}`}>
                                          <button
                                            type="button"
                                            aria-pressed={detail?.id === item.id}
                                            aria-label={`Select ${recordTitle(item)} (${item.type} ${item.id})`}
                                            onClick={() => setDetailId(item.id)}
                                            aria-describedby={`durable-summary-${item.type}-${item.id}${item.type === "task" ? " durable-history-warning" : ""}`}
                                          >
                                            <strong>{recordTitle(item)}</strong>
                                            <span id={`durable-summary-${item.type}-${item.id}`}>
                                              {recordSummary(item)}
                                            </span>
                                            <span className="durable-record-id">
                                              {item.type} #{item.id}
                                            </span>
                                          </button>
                                          {item.type === "entry" &&
                                            !item.content &&
                                            link(`Inspect entry ${item.id}`, {
                                              ...location,
                                              objectId: item.id,
                                            })}
                                          {item.type === "document" &&
                                            item.valueState === "metadata-only" &&
                                            !location.objectId &&
                                            link(`Inspect document ${item.id}`, {
                                              ...location,
                                              objectId: item.id,
                                            })}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                <Flex gap="3" wrap="wrap" align="center">
                                  <Button
                                    variant="soft"
                                    disabled={pages.length === 1}
                                    onClick={() => setPages((value) => value.slice(0, -1))}
                                  >
                                    Previous objects
                                  </Button>
                                  <Button
                                    variant="soft"
                                    disabled={!data.nextCursor}
                                    onClick={() => setPages((value) => [...value, data.nextCursor])}
                                  >
                                    Next objects
                                  </Button>
                                  <Text size="2">Page {pages.length}</Text>
                                </Flex>
                              </>
                            )}
                          </>
                        )
                      )}
                    </div>
                  </Tabs.Content>
                </Tabs.Root>
              </details>
            </div>
          </div>
          <details className="durable-history-context">
            <summary>History and context</summary>
            <Flex gap="2" wrap="wrap" align="center">
              <Button variant="soft" onClick={onChats}>
                <MixerHorizontalIcon aria-hidden />
                Open chat settings
              </Button>
              <Button
                variant="soft"
                onClick={() => {
                  void Promise.resolve()
                    .then(() => navigator.clipboard.writeText(chat))
                    .then(
                      () => setCopyIdState("Chat ID copied."),
                      () => setCopyIdState("Copy failed. Select and copy the chat ID."),
                    )
                }}
              >
                <CopyIcon aria-hidden />
                Copy chat ID
              </Button>
              {copyIdState && (
                <Text role="status" size="1">
                  {copyIdState}
                </Text>
              )}
            </Flex>
            {historyContext}
          </details>
          <details className="durable-advanced">
            <summary>Advanced inspection</summary>
            <form onSubmit={selectContext} className="durable-context">
              <label htmlFor="durable-conversation">
                Conversation ID
                <TextField.Root
                  id="durable-conversation"
                  inputMode="numeric"
                  value={conversationDraft}
                  onChange={(event) => setConversationDraft(event.target.value)}
                />
              </label>
              <label htmlFor="durable-task">
                Task ID (for task documents)
                <TextField.Root
                  id="durable-task"
                  inputMode="numeric"
                  value={taskDraft}
                  onChange={(event) => setTaskDraft(event.target.value)}
                />
              </label>
              <Button variant="soft" type="submit">
                Inspect IDs
              </Button>
              {inputError && <Text role="alert">{inputError}</Text>}
            </form>
          </details>
        </>
      )}
      <details className="durable-limits">
        <summary>Data scope and limits</summary>
        <Text as="p" id="durable-history-warning">
          Read-only persisted data; not live execution state
        </Text>
        <Text as="p" size="2">
          Inspection does not load chats or start work. Refresh is manual; there is no polling. Each
          record context or refresh reads at most one conversation page, one selected-conversation
          task page, and one requested inspection page, in sequence. Tree collections read one page
          on expansion and one page per Load more action. Pages contain at most 25 records. Reads
          are separate, not one atomic snapshot. Active marks persisted selection, not running work.
          Task status and outcome are historical observations, not live scheduling state. Retired
          task documents can be unavailable. Entry lists include metadata only. Inspect an entry to
          read bounded message content and tool output. Content can be truncated. Image bytes are
          never sent.
        </Text>
      </details>
    </section>
  )
}
