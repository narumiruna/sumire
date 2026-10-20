import type {
  DurableConversationItem,
  DurableInspectionItem,
  DurableInspectionResponse,
  DurableTaskItem,
} from "@narumitw/sumire-contracts"
import { Button, Heading, Text } from "@radix-ui/themes"
import { type ReactNode, useEffect, useState } from "react"
import { ApiError } from "./api.js"
import type { DurableLocation } from "./durable-inspector.js"
import { recordSummary, recordTitle, taskObservation } from "./durable-presentation.js"
import { Panel } from "./surfaces.js"

type Read = (path: string, signal: AbortSignal) => Promise<DurableInspectionResponse>
type TreeProps = {
  chat: string
  conversations: DurableConversationItem[]
  target?: number
  selected?: number
  nextCursor?: string
  truncated?: boolean
  link(label: string, location: DurableLocation): ReactNode
  read: Read
  path(location: DurableLocation, cursor?: string): string
  onSessionExpired(): void
}

// Missing parents and cycles remain visible as roots. Never follow an unchecked parent chain.
export function taskParents(tasks: DurableTaskItem[]): Map<number, number | undefined> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return new Map(
    tasks.map((task) => {
      const visited = new Set([task.id])
      let parent = task.ownerTaskId
      while (parent !== undefined && byId.has(parent)) {
        if (visited.has(parent)) return [task.id, undefined]
        visited.add(parent)
        parent = byId.get(parent)?.ownerTaskId
      }
      return [
        task.id,
        task.ownerTaskId !== undefined && byId.has(task.ownerTaskId) ? task.ownerTaskId : undefined,
      ]
    }),
  )
}

function Branch({ label, children }: { label: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false)
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true)
      }}
    >
      <summary>{label}</summary>
      {opened && children}
    </details>
  )
}

function useCollection(
  props: TreeProps,
  location: DurableLocation,
  seed?: { nextCursor?: string; truncated?: boolean },
) {
  const path = props.path(location)
  const [page, setPage] = useState<{
    path: string
    cursor?: string
    retry: number
    requested: boolean
  }>({
    path,
    retry: 0,
    requested: !seed,
  })
  const [state, setState] = useState<{
    path: string
    items: DurableInspectionItem[]
    nextCursor?: string
    truncated?: boolean
    error?: string
    unloaded?: boolean
    loading: boolean
  }>({ path, items: [], loading: true })
  const { read, onSessionExpired } = props
  useEffect(() => {
    if (!page.requested) return
    const controller = new AbortController()
    setState((value) => ({
      ...(value.path === path ? value : { path, items: [] }),
      loading: true,
      error: undefined,
    }))
    const query = new URLSearchParams(path.split("?")[1])
    if (page.path === path && page.cursor) query.set("cursor", page.cursor)
    const nextPath = `${path.split("?")[0]}?${query}`
    void read(nextPath, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setState((previous) => ({
          path,
          items:
            data.state === "not-loaded"
              ? []
              : [
                  ...new Map(
                    [...(previous.path === path ? previous.items : []), ...data.items].map(
                      (item) => [`${item.type}:${item.id}`, item],
                    ),
                  ).values(),
                ],
          nextCursor: data.state === "loaded" ? data.nextCursor : undefined,
          truncated: data.truncated,
          unloaded: data.state === "not-loaded",
          loading: false,
        }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const denied = error instanceof ApiError && (error.status === 401 || error.status === 403)
        setState((value) => ({
          ...(denied || value.path !== path ? { path, items: [] } : value),
          loading: false,
          error: denied ? "Permission denied." : "Read failed.",
        }))
        if (error instanceof ApiError && error.status === 401) onSessionExpired()
      })
    return () => controller.abort()
  }, [path, page, read, onSessionExpired])
  const activeState = !page.requested
    ? { path, items: [], loading: false, nextCursor: seed?.nextCursor, truncated: seed?.truncated }
    : state.path === path
      ? state
      : { path, items: [], loading: true }
  return {
    ...activeState,
    more: () => setPage({ path, cursor: activeState.nextCursor, retry: 0, requested: true }),
    retry: () =>
      setPage((value) => ({
        path,
        cursor: value.path === path ? value.cursor : undefined,
        retry: value.retry + 1,
        requested: true,
      })),
  }
}

type Collection = ReturnType<typeof useCollection>
function CollectionStatus({ collection, label }: { collection: Collection; label: string }) {
  return (
    <div className="durable-tree-status">
      {collection.loading && (
        <Text as="p" role="status">
          Loading {label}…
        </Text>
      )}
      {collection.error && (
        <>
          <Text as="p" role="alert">
            {collection.error} {label} may be incomplete.
          </Text>
          <Button size="1" variant="soft" onClick={collection.retry}>
            Retry {label}
          </Button>
        </>
      )}
      {collection.unloaded && <Text as="p">Session not loaded. {label} unavailable.</Text>}
      {!collection.loading &&
        !collection.error &&
        !collection.unloaded &&
        collection.items.length === 0 && <Text as="p">No {label} on the loaded page.</Text>}
      {(collection.nextCursor || collection.truncated) && (
        <Text as="p">Partial {label} · more records may exist.</Text>
      )}
      {collection.nextCursor && (
        <Button size="1" variant="soft" disabled={collection.loading} onClick={collection.more}>
          Load more {label}
        </Button>
      )}
    </div>
  )
}

function Documents({ props, location }: { props: TreeProps; location: DurableLocation }) {
  const collection = useCollection(props, location)
  return (
    <>
      <ul>
        {collection.items.map((item) => (
          <li key={item.id}>
            {item.type === "document" && item.valueState === "withheld" ? (
              <>
                <Text as="p">
                  {recordTitle(item)} · document {item.id}
                </Text>
                <Text as="p" size="1">
                  {recordSummary(item)}
                </Text>
              </>
            ) : (
              props.link(`${recordTitle(item)} · document ${item.id}`, {
                ...location,
                objectId: item.id,
              })
            )}
          </li>
        ))}
      </ul>
      <CollectionStatus collection={collection} label="documents" />
    </>
  )
}

function ConversationContents({ props, id }: { props: TreeProps; id: number }) {
  const taskPage = useCollection(props, { view: "tasks", conversationId: id })
  const entryPage = useCollection(props, { view: "entries", conversationId: id })
  const tasks = taskPage.items.filter((item): item is DurableTaskItem => item.type === "task")
  const entries = entryPage.items.filter((item) => item.type === "entry")
  const parents = taskParents(tasks)
  const entryNodes = (taskId?: number) =>
    entries
      .filter((entry) =>
        taskId === undefined
          ? entry.byTaskId === undefined || !parents.has(entry.byTaskId)
          : entry.byTaskId === taskId,
      )
      .map((entry) => (
        <li key={entry.id}>
          {props.link(`Entry ${entry.id} · ${recordTitle(entry)}`, {
            view: "entries",
            conversationId: id,
            objectId: entry.id,
          })}
          {taskId === undefined && entry.byTaskId !== undefined && (
            <Text as="p" size="1">
              Recorded by task {entry.byTaskId}, not on the loaded task pages.
            </Text>
          )}
        </li>
      ))
  const taskLabel = (task: DurableTaskItem) => {
    const toolName =
      task.kind === "pi.tool"
        ? entries.find((entry) => entry.byTaskId === task.id && entry.toolName)?.toolName
        : undefined
    return `Task ${task.id} · ${recordTitle(task)}${toolName ? ` · ${toolName}` : ""}`
  }
  const taskNodes = (parent?: number): ReactNode =>
    tasks
      .filter((task) => parents.get(task.id) === parent)
      .map((task) => (
        <li key={task.id}>
          <Branch label={taskLabel(task)}>
            {props.link(`Inspect task ${task.id}`, {
              view: "tasks",
              conversationId: id,
              objectId: task.id,
            })}
            <Text as="p" size="1">
              {taskObservation(task)}
            </Text>
            {task.ownerTaskId !== undefined && !parents.has(task.ownerTaskId) && (
              <Text as="p" size="1">
                Parent task {task.ownerTaskId} is not on the loaded pages.
              </Text>
            )}
            <ul>
              {taskNodes(task.id)}
              {entryNodes(task.id)}
            </ul>
            <Branch label={`Documents for task ${task.id}`}>
              <Documents
                props={props}
                location={{ view: "documents", scope: "task", conversationId: id, taskId: task.id }}
              />
            </Branch>
          </Branch>
        </li>
      ))
  return (
    <>
      {props.link(`Inspect conversation ${id}`, { view: "conversations", objectId: id })}
      <ul>{taskNodes()}</ul>
      <CollectionStatus collection={taskPage} label="tasks" />
      <Branch label="Entries without a loaded task">
        <ul>{entryNodes()}</ul>
      </Branch>
      <CollectionStatus collection={entryPage} label="entries" />
      <Branch label={`Documents in conversation ${id}`}>
        <Documents
          props={props}
          location={{ view: "documents", scope: "conversation", conversationId: id }}
        />
      </Branch>
    </>
  )
}

export function DurableTree(props: TreeProps) {
  const conversationPage = useCollection(
    props,
    { view: "conversations" },
    { nextCursor: props.nextCursor, truncated: props.truncated },
  )
  const [retained, setRetained] = useState<DurableConversationItem[]>([])
  useEffect(() => {
    setRetained((previous) => [
      ...new Map([...previous, ...props.conversations].map((item) => [item.id, item])).values(),
    ])
  }, [props.conversations])
  const known = new Map(
    [
      ...retained,
      ...conversationPage.items.filter(
        (item): item is DurableConversationItem => item.type === "conversation",
      ),
      ...props.conversations,
    ].map((item) => [item.id, item]),
  )
  if (props.target && !known.has(props.target))
    known.set(props.target, { type: "conversation", id: props.target, active: false })
  const nodes =
    conversationPage.error === "Permission denied." || conversationPage.unloaded
      ? []
      : [...known.values()]
  const roots = nodes.filter((item) => !item.parent || !known.has(item.parent.conversationId))
  const rendered = new Set<number>()
  const node = (item: DurableConversationItem): ReactNode => {
    if (rendered.has(item.id)) return null
    rendered.add(item.id)
    return (
      <li key={item.id}>
        <Branch
          label={`Conversation ${item.id}${item.id === props.selected ? " · persisted selection" : ""}`}
        >
          {![...retained, ...props.conversations, ...conversationPage.items].some(
            (value) => value.id === item.id,
          ) && (
            <Text as="p" size="1">
              Relationship metadata is not on the loaded conversation page.
            </Text>
          )}
          {item.parent && (
            <Text as="p" size="1">
              Branched from conversation {item.parent.conversationId} at entry {item.parent.at}.
            </Text>
          )}
          <ConversationContents props={props} id={item.id} />
          <ul>{nodes.filter((child) => child.parent?.conversationId === item.id).map(node)}</ul>
        </Branch>
      </li>
    )
  }
  return (
    <Panel aria-label="Relationship tree" className="durable-tree">
      <Heading as="h3" size="3">
        Browse relationships
      </Heading>
      <Text as="p" size="1">
        Expand a conversation to read one task page and one entry page. Expand document collections
        separately. Only loaded records are grouped; missing parents and cycles appear at the root.
      </Text>
      <ul>
        {roots.map(node)}
        {nodes.filter((item) => !rendered.has(item.id)).map(node)}
      </ul>
      <CollectionStatus collection={{ ...conversationPage, items: nodes }} label="conversations" />
      <Text as="p" size="1">
        Conversation branches outside the loaded pages are not shown. Refresh clears the tree pages.
      </Text>
      <Branch label="Session documents">
        <Documents props={props} location={{ view: "documents", scope: "session" }} />
      </Branch>
    </Panel>
  )
}
