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
import {
  Button,
  DataList,
  Flex,
  Heading,
  Link,
  Spinner,
  Tabs,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, request } from "./api.js"
import { chatName } from "./chat-directory.js"
import {
  formatDurableTime,
  formatReadTime,
  recordSummary,
  recordTitle,
  taskObservation,
} from "./durable-presentation.js"
import { navigationHref } from "./navigation.js"
import { SectionSelect as Select } from "./sections.js"
import { countText } from "./status-text.js"
import { EmptyState, LoadingState, Panel, Prose } from "./surfaces.js"

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
        color="gray"
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
      <Text as="p" className="copy-confirmation" role="status">
        {copyState}
      </Text>
      <pre>{json}</pre>
    </details>
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
    <DataList.Root className="durable-metadata durable-usage" orientation="horizontal">
      {fields.map(([key, label]) => (
        <DataList.Item className="durable-usage-field" key={key}>
          <DataList.Label>{label} tokens</DataList.Label>
          <DataList.Value>{usage[key] ?? "Not recorded"}</DataList.Value>
        </DataList.Item>
      ))}
      {usage.cost &&
        fields.map(([key, label]) => (
          <DataList.Item className="durable-usage-field" key={`cost:${key}`}>
            <DataList.Label>{label} cost (reported)</DataList.Label>
            <DataList.Value>{usage.cost?.[key] ?? "Not recorded"}</DataList.Value>
          </DataList.Item>
        ))}
    </DataList.Root>
  )
}

export function DurableInspector({
  chat,
  metadata,
  metadataLoading,
  metadataError,
  onMetadataRetry,
  onChats,
  onSessionExpired,
}: {
  chat: string
  metadata?: Chat
  metadataLoading?: boolean
  metadataError?: string
  onMetadataRetry?(): void
  onChats(): void
  onSessionExpired(): void
}) {
  const [location, setLocation] = useState(() => readDurableLocation(new URL(window.location.href)))
  const [pages, setPages] = useState<(string | undefined)[]>([undefined])
  const [refresh, setRefresh] = useState(0)
  const [blocks, setBlocks] = useState<{
    key: string
    selection?: ReadBlock
    history?: ReadBlock
    inspection?: ReadBlock
  }>()
  const [detailId, setDetailId] = useState<number>()
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
  const detailName = !validChat
    ? "Choose a chat"
    : metadataLoading
      ? "Loading chat name…"
      : metadataError
        ? "Chat name unavailable"
        : metadata
          ? chatName(metadata)
          : "Chat name unknown"
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
  const link = (label: string, next: DurableLocation) => (
    <Link
      href={durableHref(chat, next)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        event.preventDefault()
        navigate(next)
      }}
    >
      {label}
    </Link>
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
  const row = (item: DurableInspectionItem) => (
    <Panel
      key={`${item.type}:${item.id}`}
      className="durable-detail"
      aria-label="Selected item details"
    >
      <Heading as="h3" size="4">
        {recordTitle(item)}
      </Heading>
      <Text as="p" size="2" className="durable-record-id">
        {item.type} #{item.id}
      </Text>
      <Text as="p" className="durable-record-summary">
        {recordSummary(item)}
      </Text>
      <DataList.Root className="durable-metadata" orientation="horizontal">
        {item.type === "conversation" && (
          <>
            <DataList.Item>
              <DataList.Label>Selection marker</DataList.Label>
              <DataList.Value>
                {item.active ? "Persisted selected conversation" : "Historical conversation"}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Parent conversation</DataList.Label>
              <DataList.Value>
                {item.parent ? (
                  <span>
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
                  </span>
                ) : (
                  "No parent recorded"
                )}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Owning task</DataList.Label>
              <DataList.Value>
                {item.owner
                  ? link(`Task ${item.owner.taskId} in conversation ${item.owner.conversationId}`, {
                      view: "tasks",
                      conversationId: item.owner.conversationId,
                      objectId: item.owner.taskId,
                    })
                  : "No owner recorded"}
              </DataList.Value>
            </DataList.Item>
          </>
        )}
        {item.type === "task" && (
          <>
            <DataList.Item>
              <DataList.Label>Conversation</DataList.Label>
              <DataList.Value>
                {link(`Conversation ${item.conversationId}`, {
                  view: "conversations",
                  objectId: item.conversationId,
                })}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Owning task</DataList.Label>
              <DataList.Value>
                {item.ownerTaskId
                  ? link(`Task ${item.ownerTaskId}`, {
                      view: "tasks",
                      conversationId: item.conversationId,
                      objectId: item.ownerTaskId,
                    })
                  : "No owner recorded"}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Started</DataList.Label>
              <DataList.Value>{formatDurableTime(item.startedAt)}</DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Ended</DataList.Label>
              <DataList.Value>{formatDurableTime(item.endedAt)}</DataList.Value>
            </DataList.Item>
          </>
        )}
        {item.type === "document" && (
          <DataList.Item>
            <DataList.Label>Applies to</DataList.Label>
            <DataList.Value>
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
            </DataList.Value>
          </DataList.Item>
        )}
        {item.type === "entry" && (
          <>
            <DataList.Item>
              <DataList.Label>Recorded at</DataList.Label>
              <DataList.Value>{formatDurableTime(item.timestamp)}</DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Conversation</DataList.Label>
              <DataList.Value>
                {link(`Conversation ${item.conversationId}`, {
                  view: "conversations",
                  objectId: item.conversationId,
                })}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Recorded by</DataList.Label>
              <DataList.Value>
                {item.byTaskId
                  ? link(`Task ${item.byTaskId}`, {
                      view: "tasks",
                      conversationId: item.conversationId,
                      objectId: item.byTaskId,
                    })
                  : "Not recorded"}
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>Head entry</DataList.Label>
              <DataList.Value>
                {item.head
                  ? link(`Entry ${item.head}`, {
                      view: "entries",
                      conversationId: item.conversationId,
                      objectId: item.head,
                    })
                  : "Not recorded"}
              </DataList.Value>
            </DataList.Item>
          </>
        )}
      </DataList.Root>
      {item.type === "document" && item.valueState === "available" && !item.value && (
        <Text as="p">Approved fields were not included in this response.</Text>
      )}
      {item.type === "document" && item.valueState === "available" && item.value && (
        <Panel aria-label="Approved document fields" className="durable-projection">
          <Heading as="h4" size="3">
            Approved fields
          </Heading>
          {item.value.kind === "pi.agent" ? (
            <DataList.Root className="durable-metadata" orientation="horizontal">
              <DataList.Item>
                <DataList.Label>Model provider</DataList.Label>
                <DataList.Value>{item.value.model?.provider ?? "Not recorded"}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Model</DataList.Label>
                <DataList.Value>{item.value.model?.modelId ?? "Not recorded"}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Thinking level</DataList.Label>
                <DataList.Value>{item.value.thinkingLevel ?? "Not recorded"}</DataList.Value>
              </DataList.Item>
            </DataList.Root>
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
            <DataList.Root className="durable-metadata" orientation="horizontal">
              <DataList.Item>
                <DataList.Label>Persisted selected conversation</DataList.Label>
                <DataList.Value>
                  {item.value.activeConversation
                    ? link(`Conversation ${item.value.activeConversation}`, {
                        view: "conversations",
                        objectId: item.value.activeConversation,
                      })
                    : "Not recorded"}
                </DataList.Value>
              </DataList.Item>
            </DataList.Root>
          )}
        </Panel>
      )}
      <Flex gap="3" wrap="wrap" className="durable-links">
        {item.type === "conversation" && (
          <>
            {link(`Tasks in conversation ${item.id}`, { view: "tasks", conversationId: item.id })}
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
      <details className="durable-technical">
        <summary>Technical details</summary>
        <DataList.Root className="durable-metadata" orientation="horizontal">
          {item.type !== "conversation" && (
            <DataList.Item>
              <DataList.Label>Stored kind</DataList.Label>
              <DataList.Value>{item.kind}</DataList.Value>
            </DataList.Item>
          )}
          {item.type === "task" && (
            <>
              <DataList.Item>
                <DataList.Label>Version</DataList.Label>
                <DataList.Value>{item.version}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Stored status</DataList.Label>
                <DataList.Value>{item.status}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Background</DataList.Label>
                <DataList.Value>{String(item.background)}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Abort requested</DataList.Label>
                <DataList.Value>{String(item.abortRequested)}</DataList.Value>
              </DataList.Item>
            </>
          )}
          {item.type === "document" && (
            <>
              <DataList.Item>
                <DataList.Label>Family member</DataList.Label>
                <DataList.Value>{item.family ? "Yes" : "No"}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Created sequence</DataList.Label>
                <DataList.Value>{item.createdAt}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Retired sequence</DataList.Label>
                <DataList.Value>{item.retiredAt ?? "Not retired"}</DataList.Value>
              </DataList.Item>
              <DataList.Item>
                <DataList.Label>Definition version</DataList.Label>
                <DataList.Value>{item.version ?? "Not recorded"}</DataList.Value>
              </DataList.Item>
            </>
          )}
          {item.type === "entry" && (
            <DataList.Item>
              <DataList.Label>Stored role</DataList.Label>
              <DataList.Value>{item.role ?? "Not recorded"}</DataList.Value>
            </DataList.Item>
          )}
          {item.type === "conversation" && (
            <DataList.Item>
              <DataList.Label>Persisted selection marker</DataList.Label>
              <DataList.Value>{String(item.active)}</DataList.Value>
            </DataList.Item>
          )}
        </DataList.Root>
      </details>
      <JsonDetails
        key={`metadata:${item.type}:${item.id}`}
        label={`Metadata JSON for ${item.type} ${item.id}`}
        value={item.type === "document" ? { ...item, value: undefined } : item}
      />
      {item.type === "document" && item.valueState === "available" && item.value && (
        <JsonDetails
          key={`value:${item.id}`}
          label={`Approved value JSON for document ${item.id}`}
          value={item.value}
        />
      )}
    </Panel>
  )

  return (
    <section className="durable-inspector" aria-label="Durable Inspector">
      <header className="durable-summary-header">
        <div>
          <Heading as="h2" size="5" title={detailName}>
            {validChat && metadataLoading && <Spinner aria-hidden="true" mr="2" />}
            {detailName}
          </Heading>
          {validChat && (
            <Flex gap="2" align="center" wrap="wrap">
              <Text size="2">
                <code>{chat}</code>
                {metadata ? ` · ${metadata.type}` : ""}
              </Text>
              <Button
                color="gray"
                size="1"
                variant="ghost"
                onClick={() => {
                  void Promise.resolve()
                    .then(() => navigator.clipboard.writeText(chat))
                    .then(
                      () => setCopyIdState("Chat ID copied."),
                      () => setCopyIdState("Copy failed. Select and copy the chat ID."),
                    )
                }}
              >
                Copy chat ID
              </Button>
            </Flex>
          )}
          {validChat && (
            <Text as="p" className="copy-confirmation" role="status" size="1">
              {copyIdState}
            </Text>
          )}
        </div>
        <Flex gap="3" wrap="wrap" align="center">
          {validChat && (
            <Button color="gray" variant="ghost" onClick={onChats}>
              Open chat settings
            </Button>
          )}
          <Button
            color="gray"
            variant="soft"
            disabled={!validChat || (!current && !selection)}
            onClick={() => {
              setPages([undefined])
              setRefresh((value) => value + 1)
            }}
          >
            Refresh Durable
          </Button>
        </Flex>
      </header>
      {metadataError && (
        <div>
          <Text as="p" className="error-state" data-status="failed" role="alert">
            {metadataError}
          </Text>
          {onMetadataRetry && (
            <Button color="gray" variant="soft" onClick={onMetadataRetry}>
              Retry chat metadata
            </Button>
          )}
        </div>
      )}
      <Prose size="2" className="durable-notice" id="durable-history-warning">
        Read-only persisted data; not live execution state
      </Prose>
      {validChat && (
        <Panel
          className="durable-inspection-context"
          aria-label="Inspection context"
          aria-live="polite"
        >
          <Heading as="h3" size="4">
            {data?.state !== "not-loaded" &&
              !sessionDocuments &&
              location.view === "conversations" &&
              !current &&
              !location.objectId && <Spinner aria-hidden="true" mr="2" />}
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
                  : "Use the conversation list or a related-record link. Message content is not included."}
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
            <Panel aria-label="Persisted selection" aria-live="polite" aria-busy={!selection}>
              <Heading as="h4" size="2">
                Selected conversation
              </Heading>
              {!selection ? (
                <LoadingState label="Loading selection…" />
              ) : selection.error ? (
                <Text as="p" className="error-state" data-status="failed" role="alert">
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
                  <LoadingState label="Loading task history…" />
                ) : history.error ? (
                  <Text as="p" className="error-state" data-status="failed" role="alert">
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
                      <EmptyState title="No task history on this page." />
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
      {!validChat ? (
        <EmptyState title="Select a chat" description="Select a chat above to inspect Durable." />
      ) : (
        <>
          <Heading as="h3" size="3">
            Explore related records
          </Heading>
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
                  <LoadingState label="Loading Durable…" />
                ) : current.unavailable ? (
                  <Text as="p" role="status">
                    Retired or unavailable. The object is no longer available in this scope.
                  </Text>
                ) : current.error ? (
                  <Text as="p" className="error-state" data-status="failed" role="alert">
                    {current.error}
                  </Text>
                ) : (
                  data && (
                    <>
                      {current !== selection && current !== history && readTime(current)}
                      {data.state === "not-loaded" ? (
                        <EmptyState
                          title="Not loaded"
                          description="This chat has no loaded session. Inspection will not open its database or start a session."
                        />
                      ) : (
                        <>
                          {data.truncated && (
                            <Text as="p" role="status">
                              Truncated · the server read limit was reached. Some records are not
                              shown.
                            </Text>
                          )}
                          {!data.items.length ? (
                            <EmptyState
                              title={
                                location.objectId
                                  ? "Retired or unavailable"
                                  : "Empty · no records in this view."
                              }
                            />
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
                              {detail && row(detail)}
                            </div>
                          )}
                          <Flex gap="3" wrap="wrap" align="center">
                            <Button
                              color="gray"
                              variant="soft"
                              disabled={pages.length === 1}
                              onClick={() => setPages((value) => value.slice(0, -1))}
                            >
                              Previous objects
                            </Button>
                            <Button
                              color="gray"
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
              <Button color="gray" variant="soft" type="submit">
                Inspect IDs
              </Button>
              {inputError && (
                <Text className="error-state" data-status="failed" role="alert">
                  {inputError}
                </Text>
              )}
            </form>
          </details>
        </>
      )}
      <details className="durable-limits">
        <summary>Data scope and limits</summary>
        <Text as="p" size="2">
          Inspection does not load chats or start work. Refresh is manual; there is no polling. Each
          context or refresh reads at most one conversation page, one selected-conversation task
          page, and one requested inspection page, in sequence. Pages contain at most 25 records.
          Reads are separate, not one atomic snapshot. Active marks persisted selection, not running
          work. Task status and outcome are historical observations, not live scheduling state.
          Retired task documents can be unavailable. Message bodies and tool output are excluded.
        </Text>
      </details>
    </section>
  )
}
