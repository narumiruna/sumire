import type {
  DurableConversationItem,
  DurableInspectionItem,
  DurableInspectionResponse,
  DurableTaskItem,
} from "@narumitw/sumire-contracts"
import { ChevronRightIcon, LayersIcon } from "@radix-ui/react-icons"
import { Button, Heading, Text } from "@radix-ui/themes"
import { type ReactNode, useEffect, useState } from "react"
import { ApiError } from "./api.js"
import type { DurableLocation } from "./durable-inspector.js"
import {
  recordBadge,
  recordIcon,
  recordSummary,
  recordTitle,
  recordTone,
  recordTypeLabel,
} from "./durable-presentation.js"
import { getLocale, type MessageKey, t } from "./i18n.js"
import { countText } from "./status-text.js"

type Read = (path: string, signal: AbortSignal) => Promise<DurableInspectionResponse>
type TreeProps = {
  chat: string
  conversations: DurableConversationItem[]
  target?: number
  selected?: number
  nextCursor?: string
  truncated?: boolean
  link(label: ReactNode, location: DurableLocation): ReactNode
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
      className="durable-collection"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true)
      }}
    >
      <summary>
        <ChevronRightIcon aria-hidden />
        {label}
      </summary>
      {opened && children}
    </details>
  )
}

function RecordRow({
  props,
  item,
  location,
  label = recordTitle(item),
  persisted,
  children,
}: {
  props: TreeProps
  item: DurableInspectionItem
  location: DurableLocation
  label?: string
  persisted?: boolean
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const Icon = recordIcon(item)
  const badge = recordBadge(item)
  const withheld = item.type === "document" && item.valueState === "withheld"
  const identity = (
    <>
      <span className="durable-role-icon">
        <Icon aria-hidden />
      </span>
      <span className="durable-row-body">
        <span className="durable-row-heading">
          <span className="durable-row-label">{label}</span>
          <span className="durable-record-id">#{item.id}</span>
        </span>
        <span className="durable-row-caption">
          {persisted ? (
            <span className="durable-tree-badge">{t("record.persistedSelection")}</span>
          ) : badge ? (
            <span className="durable-tree-badge">{badge}</span>
          ) : (
            recordTypeLabel(item.type)
          )}
        </span>
      </span>
    </>
  )
  return (
    <>
      <div className={`durable-tree-row durable-role-${recordTone(item)}`}>
        {children ? (
          <button
            type="button"
            className="durable-expand"
            aria-expanded={open}
            aria-label={t(open ? "record.collapseRecord" : "record.expandRecord", {
              label,
              id: item.id,
            })}
            onClick={() => {
              setOpen(!open)
              setLoaded(true)
            }}
          >
            <ChevronRightIcon aria-hidden />
          </button>
        ) : (
          <span className="durable-chevron-space" aria-hidden />
        )}
        {withheld ? (
          <div className="durable-withheld-record">{identity}</div>
        ) : (
          props.link(identity, location)
        )}
      </div>
      {withheld && (
        <Text as="p" className="durable-tree-note">
          {recordSummary(item)}
        </Text>
      )}
      {loaded && <div hidden={!open}>{children}</div>}
    </>
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
    error?: MessageKey
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
          error: denied ? "record.permissionDenied" : "record.readFailed",
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
function CollectionStatus({
  collection,
  label: heading,
}: {
  collection: Collection
  label: string
}) {
  const label = getLocale() === "en" ? heading.toLowerCase() : heading
  return (
    <div className="durable-tree-status">
      {collection.loading && (
        <Text as="p" role="status">
          {t("record.loadingCollection", { label })}
        </Text>
      )}
      {collection.error && (
        <>
          <Text as="p" role="alert">
            {t("record.incompleteCollection", { error: t(collection.error), label })}
          </Text>
          <Button size="1" variant="soft" onClick={collection.retry}>
            {t("record.retryCollection", { label })}
          </Button>
        </>
      )}
      {collection.unloaded && <Text as="p">{t("record.unloadedCollection", { label })}</Text>}
      {!collection.loading &&
        !collection.error &&
        !collection.unloaded &&
        collection.items.length === 0 && (
          <Text as="p">{t("record.emptyCollection", { label })}</Text>
        )}
      {(collection.nextCursor || collection.truncated) && (
        <Text as="p">{t("record.partialCollection", { label })}</Text>
      )}
      {collection.nextCursor && (
        <Button size="1" variant="soft" disabled={collection.loading} onClick={collection.more}>
          {t("record.moreCollection", { label })}
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
            <RecordRow props={props} item={item} location={{ ...location, objectId: item.id }} />
          </li>
        ))}
      </ul>
      <CollectionStatus collection={collection} label={t("record.documents")} />
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
          <RecordRow
            props={props}
            item={entry}
            location={{ view: "entries", conversationId: id, objectId: entry.id }}
          />
          {taskId === undefined && entry.byTaskId !== undefined && (
            <Text as="p" size="1">
              {t("record.taskNotLoaded", { id: entry.byTaskId })}
            </Text>
          )}
        </li>
      ))
  const taskLabel = (task: DurableTaskItem) => {
    const toolName =
      task.kind === "pi.tool"
        ? entries.find((entry) => entry.byTaskId === task.id && entry.toolName)?.toolName
        : undefined
    return toolName ?? recordTitle(task)
  }
  const taskNodes = (parent?: number): ReactNode =>
    tasks
      .filter((task) => parents.get(task.id) === parent)
      .map((task) => (
        <li key={task.id}>
          <RecordRow
            props={props}
            item={task}
            label={taskLabel(task)}
            location={{ view: "tasks", conversationId: id, objectId: task.id }}
          >
            {task.ownerTaskId !== undefined && !parents.has(task.ownerTaskId) && (
              <Text as="p" size="1">
                {t("record.parentTaskMissing", { id: task.ownerTaskId })}
              </Text>
            )}
            {task.ownerTaskId !== undefined &&
              parents.has(task.ownerTaskId) &&
              parents.get(task.id) === undefined && (
                <Text as="p" size="1">
                  {t("record.taskCycle")}
                </Text>
              )}
            <ul>
              {taskNodes(task.id)}
              {entryNodes(task.id)}
            </ul>
            <Branch label={t("record.taskDocuments", { id: task.id })}>
              <Documents
                props={props}
                location={{ view: "documents", scope: "task", conversationId: id, taskId: task.id }}
              />
            </Branch>
          </RecordRow>
        </li>
      ))
  return (
    <>
      <ul>{taskNodes()}</ul>
      <CollectionStatus collection={taskPage} label={t("record.tasks")} />
      <Branch label={t("record.entriesWithoutTask")}>
        <ul>{entryNodes()}</ul>
      </Branch>
      <CollectionStatus collection={entryPage} label={t("record.entries")} />
      <Branch label={t("record.conversationDocuments", { id })}>
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
  const loadedIds = new Set(known.keys())
  if (props.target && !known.has(props.target))
    known.set(props.target, { type: "conversation", id: props.target, active: false })
  const nodes =
    conversationPage.error === "record.permissionDenied" || conversationPage.unloaded
      ? []
      : [...known.values()]
  const loadedCount = nodes.filter((item) => loadedIds.has(item.id)).length
  const roots = nodes.filter((item) => !item.parent || !known.has(item.parent.conversationId))
  const cycles = new Set<number>()
  for (const item of nodes) {
    const visited = new Set<number>()
    let parent: number | undefined = item.id
    while (parent !== undefined && known.has(parent)) {
      if (visited.has(parent)) {
        for (const id of visited) cycles.add(id)
        break
      }
      visited.add(parent)
      parent = known.get(parent)?.parent?.conversationId
    }
  }
  const rendered = new Set<number>()
  const node = (item: DurableConversationItem): ReactNode => {
    if (rendered.has(item.id)) return null
    rendered.add(item.id)
    return (
      <li key={item.id}>
        <RecordRow
          props={props}
          item={item}
          location={{ view: "conversations", objectId: item.id }}
          persisted={item.id === props.selected}
        >
          {!loadedIds.has(item.id) && (
            <Text as="p" size="1">
              {t("record.relationshipMissing")}
            </Text>
          )}
          {item.parent && (
            <Text as="p" size="1" className="durable-tree-note">
              {t("record.branchedFrom", {
                conversation: item.parent.conversationId,
                entry: item.parent.at,
              })}
              {!known.has(item.parent.conversationId) ? t("record.parentMissing") : ""}
              {cycles.has(item.id) ? t("record.parentCycle") : ""}
            </Text>
          )}
          <ConversationContents props={props} id={item.id} />
          <ul>{nodes.filter((child) => child.parent?.conversationId === item.id).map(node)}</ul>
        </RecordRow>
      </li>
    )
  }
  return (
    <section aria-label={t("record.relationshipTree")} className="durable-tree">
      <div className="durable-navigator-heading">
        <Heading as="h3" size="3">
          <LayersIcon aria-hidden />
          {t("record.records")}
        </Heading>
        <span className="durable-count">
          {t("record.conversationsLoaded", { count: countText(loadedCount, "conversation") })}
        </span>
      </div>
      <ul>
        {roots.map(node)}
        {nodes.filter((item) => !rendered.has(item.id)).map(node)}
      </ul>
      <CollectionStatus
        collection={{ ...conversationPage, items: nodes }}
        label={t("record.conversations")}
      />
      <Branch label={t("record.aboutRecords")}>
        <Text as="p" size="1">
          {t("record.treeScope")}
        </Text>
      </Branch>
      <Branch label={t("record.sessionDocuments")}>
        <Documents props={props} location={{ view: "documents", scope: "session" }} />
      </Branch>
    </section>
  )
}
