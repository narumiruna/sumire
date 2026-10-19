import type {
  DurableDocumentScope,
  DurableInspectionItem,
  DurableInspectionQuery,
  DurableInspectionResponse,
  DurableInspectionView,
} from "@narumitw/sumire-contracts"
import { Button, Card, Flex, Heading, Tabs, Text } from "@radix-ui/themes"
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, request } from "./api.js"
import { navigationHref } from "./navigation.js"

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

export function DurableInspector({
  chat,
  onChats,
  onSessionExpired,
}: {
  chat: string
  onChats(): void
  onSessionExpired(): void
}) {
  const [location, setLocation] = useState(() => readDurableLocation(new URL(window.location.href)))
  const [pages, setPages] = useState<(string | undefined)[]>([undefined])
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<{
    key: string
    data?: DurableInspectionResponse
    error?: string
    unavailable?: boolean
  }>()
  const [conversationDraft, setConversationDraft] = useState(String(location.conversationId ?? ""))
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
    setConversationDraft(String(location.conversationId ?? ""))
    setTaskDraft(String(location.taskId ?? ""))
    setInputError("")
  }, [location.conversationId, location.taskId])
  const validChat = /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))
  const missing = contextNeeded(location)
  const path = inspectionPath(chat, location, pages.at(-1))
  const key = `${path}:${refresh}`
  useEffect(() => {
    setResult(undefined)
    if (!validChat || missing) return
    const controller = new AbortController()
    void request<DurableInspectionResponse>(
      path,
      undefined,
      undefined,
      "GET",
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, data })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) {
          setResult(undefined)
          onSessionExpired()
          return
        }
        setResult({
          key,
          error: "Read failed. Refresh to retry.",
          unavailable:
            error instanceof ApiError && error.status === 404 && location.objectId !== undefined,
        })
      },
    )
    return () => controller.abort()
  }, [key, path, validChat, missing, location.objectId, onSessionExpired])

  const navigate = (next: DurableLocation) => {
    window.history.pushState(null, "", durableHref(chat, next))
    setLocation(next)
    setPages([undefined])
  }
  const link = (label: string, next: DurableLocation) => (
    <a
      href={durableHref(chat, next)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        event.preventDefault()
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
      ...(conversationId ? { conversationId } : {}),
      ...(taskId ? { taskId } : {}),
    })
  }
  const current = result?.key === key ? result : undefined
  const data = current?.data
  const row = (item: DurableInspectionItem) => (
    <li key={`${item.type}:${item.id}`}>
      <Heading as="h3" size="3">
        {item.type} #{item.id}
      </Heading>
      <dl className="durable-metadata">
        {item.type === "conversation" && (
          <>
            <dt>Conversation marker</dt>
            <dd>{item.active ? "Active conversation" : "Historical conversation"}</dd>
            <dt>Parent</dt>
            <dd>
              {item.parent ? (
                <>
                  {link(`Conversation ${item.parent.conversationId}`, {
                    view: "conversations",
                    objectId: item.parent.conversationId,
                  })}{" "}
                  · Fork entry{" "}
                  {link(String(item.parent.at), {
                    view: "entries",
                    conversationId: item.parent.conversationId,
                    objectId: item.parent.at,
                  })}
                </>
              ) : (
                "None"
              )}
            </dd>
            <dt>Owner</dt>
            <dd>
              {item.owner
                ? link(`Task ${item.owner.taskId} in conversation ${item.owner.conversationId}`, {
                    view: "tasks",
                    conversationId: item.owner.conversationId,
                    objectId: item.owner.taskId,
                  })
                : "None"}
            </dd>
          </>
        )}
        {item.type === "task" && (
          <>
            <dt>Kind / version</dt>
            <dd>
              {item.kind} · {item.version}
            </dd>
            <dt>Status</dt>
            <dd>
              {item.status}
              {item.outcome ? ` · ${item.outcome}` : ""}
            </dd>
            <dt>Conversation</dt>
            <dd>
              {link(String(item.conversationId), {
                view: "conversations",
                objectId: item.conversationId,
              })}
            </dd>
            <dt>Owner task</dt>
            <dd>
              {item.ownerTaskId
                ? link(String(item.ownerTaskId), {
                    view: "tasks",
                    conversationId: item.conversationId,
                    objectId: item.ownerTaskId,
                  })
                : "None"}
            </dd>
            <dt>Background / abort requested</dt>
            <dd>
              {String(item.background)} / {String(item.abortRequested)}
            </dd>
            <dt>Started / ended</dt>
            <dd>
              {item.startedAt ?? "Not available"} / {item.endedAt ?? "Not available"}
            </dd>
          </>
        )}
        {item.type === "document" && (
          <>
            <dt>Kind</dt>
            <dd>{item.kind}</dd>
            <dt>Scope</dt>
            <dd>
              {item.scope.kind}
              {item.scope.kind === "conversation" ? (
                <>
                  {" "}
                  ·{" "}
                  {link(`Conversation ${item.scope.conversationId}`, {
                    view: "conversations",
                    objectId: item.scope.conversationId,
                  })}
                </>
              ) : item.scope.kind === "task" ? (
                <>
                  {" "}
                  ·{" "}
                  {link(`Task ${item.scope.taskId}`, {
                    view: "tasks",
                    conversationId: location.conversationId,
                    objectId: item.scope.taskId,
                  })}
                </>
              ) : null}
            </dd>
            <dt>Family member</dt>
            <dd>{item.family ? "Yes" : "No"}</dd>
            <dt>Created / retired</dt>
            <dd>
              {item.createdAt} / {item.retiredAt ?? "Not retired"}
            </dd>
            <dt>Version</dt>
            <dd>{item.version ?? "Not available"}</dd>
            <dt>Value</dt>
            <dd>
              {item.valueState === "withheld"
                ? `Value withheld · ${item.withheldReason === "limit" ? "Truncated: value exceeds limits" : item.withheldReason === "invalid-value" ? "Unsupported value" : "Kind is not approved"}`
                : item.valueState === "unavailable"
                  ? "Retired or unavailable"
                  : item.valueState === "metadata-only"
                    ? "Not loaded · inspect document for approved fields"
                    : "Server-approved projection"}
            </dd>
          </>
        )}
        {item.type === "entry" && (
          <>
            <dt>Kind / role</dt>
            <dd>
              {item.kind} / {item.role ?? "Not available"}
            </dd>
            <dt>Timestamp</dt>
            <dd>{item.timestamp ?? "Not available"}</dd>
            <dt>Conversation</dt>
            <dd>
              {link(String(item.conversationId), {
                view: "conversations",
                objectId: item.conversationId,
              })}
            </dd>
            <dt>Owner task</dt>
            <dd>
              {item.byTaskId
                ? link(String(item.byTaskId), {
                    view: "tasks",
                    conversationId: item.conversationId,
                    objectId: item.byTaskId,
                  })
                : "Not available"}
            </dd>
            <dt>Head entry</dt>
            <dd>
              {item.head
                ? link(String(item.head), {
                    view: "entries",
                    conversationId: item.conversationId,
                    objectId: item.head,
                  })
                : "Not available"}
            </dd>
          </>
        )}
      </dl>
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
        {item.type === "document" &&
          item.valueState === "metadata-only" &&
          !location.objectId &&
          link(`Inspect document ${item.id}`, { ...location, objectId: item.id })}
      </Flex>
      <details>
        <summary>
          Metadata JSON for {item.type} {item.id}
        </summary>
        <pre>
          {JSON.stringify(item.type === "document" ? { ...item, value: undefined } : item, null, 2)}
        </pre>
      </details>
      {item.type === "document" && item.valueState === "available" && (
        <details>
          <summary>Approved value JSON for document {item.id}</summary>
          <pre>{JSON.stringify(item.value, null, 2)}</pre>
        </details>
      )}
    </li>
  )

  return (
    <section className="durable-inspector" aria-label="Durable Inspector">
      <Flex gap="3" wrap="wrap" align="center">
        <Heading as="h2" size="4">
          Chat {chat || "not selected"}
        </Heading>
        <Button variant="soft" onClick={onChats}>
          Back to chats
        </Button>
        <Button
          variant="soft"
          disabled={!validChat || Boolean(missing) || (!current && !data)}
          onClick={() => {
            setPages([undefined])
            setRefresh((value) => value + 1)
          }}
        >
          Refresh Durable
        </Button>
      </Flex>
      <Text as="p" size="2">
        Read-only persisted metadata from an already loaded session. Inspection does not load chats
        or start work. Refresh is manual.
      </Text>
      <Text as="p" size="2">
        Panels read separately are not one atomic snapshot. Active marks the selected conversation,
        not running work. Task history is not live scheduling state. Retired task documents can be
        unavailable. Message bodies and tool output are excluded.
      </Text>
      {!validChat ? (
        <Card>
          <Text as="p">Select a chat in Chats to inspect Durable.</Text>
        </Card>
      ) : (
        <>
          <form onSubmit={selectContext} className="durable-context">
            <label htmlFor="durable-conversation">
              Conversation ID
              <input
                id="durable-conversation"
                inputMode="numeric"
                value={conversationDraft}
                onChange={(event) => setConversationDraft(event.target.value)}
              />
            </label>
            <label htmlFor="durable-task">
              Task ID (for task documents)
              <input
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
          <Tabs.Root
            value={location.view}
            onValueChange={(view) =>
              navigate({
                view: view as DurableInspectionView,
                conversationId: location.conversationId,
                taskId: location.taskId,
                ...(view === "documents"
                  ? { scope: location.conversationId ? "conversation" : "session" }
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
                  <select
                    id="durable-scope"
                    value={location.scope ?? "conversation"}
                    onChange={(event) =>
                      navigate({
                        view: "documents",
                        conversationId: location.conversationId,
                        taskId: location.taskId,
                        scope: event.target.value as DurableDocumentScope,
                      })
                    }
                  >
                    <option value="session">Session</option>
                    <option value="conversation">Conversation</option>
                    <option value="task">Task</option>
                  </select>
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
                      <Text as="p" size="2">
                        Read time: <time dateTime={data.readAt}>{data.readAt}</time>
                      </Text>
                      {data.state === "not-loaded" ? (
                        <Card>
                          <Heading as="h3" size="3">
                            Not loaded
                          </Heading>
                          <Text as="p">
                            This chat has no loaded session. Inspection will not open its database
                            or start a session.
                          </Text>
                        </Card>
                      ) : (
                        <>
                          {data.truncated && (
                            <Text as="p" role="status">
                              Truncated · the server read limit was reached. Some records are not
                              shown.
                            </Text>
                          )}
                          {!data.items.length ? (
                            <Text as="p">
                              {location.objectId
                                ? "Retired or unavailable"
                                : "Empty · no records in this view."}
                            </Text>
                          ) : (
                            <ul
                              className="durable-objects"
                              aria-label={`${labels[location.view]} metadata`}
                            >
                              {data.items.map(row)}
                            </ul>
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
        </>
      )}
    </section>
  )
}
