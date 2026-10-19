import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  DocumentId,
  DocumentRecord,
  EntryId,
  EntryRecord,
  Page,
  Storage,
  TaskId,
} from "@earendil-works/pi-durable"
import type {
  DurableConversationItem,
  DurableDocumentItem,
  DurableDocumentProjection,
  DurableInspectionItem,
  DurableInspectionLoadedResponse,
  DurableInspectionQuery,
  DurableNumericUsage,
  DurableTaskItem,
} from "@narumitw/sumire-contracts"
import { z } from "zod"
import { AdminError } from "./store.js"

export type DurableInspectionStorage = Pick<
  Storage,
  | "conversation"
  | "scanConversations"
  | "entry"
  | "scanEntries"
  | "task"
  | "scanTasks"
  | "scanDocuments"
  | "findDocument"
  | "document"
>
export type DurableInspectionReader = (
  query: DurableInspectionQuery,
  signal: AbortSignal,
) => Promise<DurableInspectionLoadedResponse>

const maxResponseBytes = 256 * 1024
const maxStringBytes = 16 * 1024
const maxCursorBytes = 4 * 1024
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe())
const querySchema = z
  .object({
    view: z.enum(["conversations", "tasks", "documents", "entries"]).default("conversations"),
    conversationId: id.optional(),
    taskId: id.optional(),
    scope: z.enum(["session", "conversation", "task"]).optional(),
    objectId: id.optional(),
    limit: id.pipe(z.number().max(100)).default(25),
    cursor: z
      .string()
      .min(1)
      .max(maxCursorBytes)
      .refine((value) => Buffer.byteLength(value) <= maxCursorBytes)
      .optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    const documents = query.view === "documents"
    const session = documents && query.scope === "session"
    if (
      (query.view === "conversations" || session
        ? query.conversationId !== undefined
        : query.conversationId === undefined) ||
      (!documents && query.scope !== undefined) ||
      (documents && query.scope === "task"
        ? query.taskId === undefined
        : query.taskId !== undefined) ||
      (query.objectId !== undefined && query.cursor !== undefined)
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid inspection scope" })
    }
  })

export function parseDurableInspectionQuery(params: URLSearchParams): DurableInspectionQuery {
  const input: Record<string, string> = {}
  for (const [key, value] of params) {
    if (Object.hasOwn(input, key)) throw new AdminError(400, "Duplicate inspection filter")
    Object.defineProperty(input, key, { value, enumerable: true })
  }
  const parsed = querySchema.safeParse(input)
  if (!parsed.success) throw new AdminError(400, "Invalid inspection query")
  const query = parsed.data
  if (query.view === "documents") query.scope ??= "conversation"
  return query
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new AdminError(409, "Durable inspection cancelled")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class ProjectionError extends Error {
  constructor(readonly reason: "invalid-value" | "limit") {
    super(reason)
  }
}

function safeString(value: unknown): string {
  if (typeof value !== "string") throw new ProjectionError("invalid-value")
  if (Buffer.byteLength(value) > maxStringBytes) throw new ProjectionError("limit")
  return value
}

function integer(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new ProjectionError("invalid-value")
  return value
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ProjectionError("invalid-value")
  return value
}
function taskStatus(value: unknown): DurableTaskItem["status"] {
  if (
    value === "pending" ||
    value === "running" ||
    value === "waiting" ||
    value === "completing" ||
    value === "terminal"
  )
    return value
  throw new ProjectionError("invalid-value")
}
function outcomeStatus(value: unknown): NonNullable<DurableTaskItem["outcome"]> {
  if (
    value === "completed" ||
    value === "failed" ||
    value === "aborted" ||
    value === "orphaned" ||
    value === "faulted"
  )
    return value
  throw new ProjectionError("invalid-value")
}
const counters = ["input", "output", "cacheRead", "cacheWrite", "total"] as const
function numericUsage(value: unknown): DurableNumericUsage {
  if (!record(value)) throw new ProjectionError("invalid-value")
  const usage: DurableNumericUsage = {}
  for (const key of counters) {
    const number = value[key === "total" ? "totalTokens" : key]
    if (number === undefined) continue
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
      throw new ProjectionError("invalid-value")
    usage[key] = number
  }
  if (value.cost !== undefined) {
    if (!record(value.cost)) throw new ProjectionError("invalid-value")
    usage.cost = {}
    for (const key of counters) {
      const number = value.cost[key]
      if (number === undefined) continue
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
        throw new ProjectionError("invalid-value")
      usage.cost[key] = number
    }
  }
  return usage
}

function project(kind: string, value: unknown): DurableDocumentProjection {
  if (!record(value)) throw new ProjectionError("invalid-value")
  if (kind === "pi.agent") {
    const result: Extract<DurableDocumentProjection, { kind: "pi.agent" }> = { kind }
    if (value.model !== undefined) {
      if (!record(value.model)) throw new ProjectionError("invalid-value")
      result.model = {
        provider: safeString(value.model.provider),
        modelId: safeString(value.model.modelId),
      }
    }
    if (value.thinkingLevel !== undefined) result.thinkingLevel = safeString(value.thinkingLevel)
    return result
  }
  if (kind === "sumire.session") {
    const active = value.activeConversation
    if (active !== undefined && (!Number.isSafeInteger(active) || Number(active) <= 0))
      throw new ProjectionError("invalid-value")
    return { kind, ...(active === undefined ? {} : { activeConversation: Number(active) }) }
  }
  if (!record(value.models)) throw new ProjectionError("invalid-value")
  const models: Record<string, DurableNumericUsage> = Object.create(null)
  const total: DurableNumericUsage = {}
  let bytes = 0
  const add = (usage: DurableNumericUsage) => {
    for (const key of counters) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]
      if (usage.cost?.[key] !== undefined) {
        total.cost ??= {}
        total.cost[key] = (total.cost[key] ?? 0) + usage.cost[key]
      }
      if (!Number.isFinite(total[key] ?? 0) || !Number.isFinite(total.cost?.[key] ?? 0))
        throw new ProjectionError("invalid-value")
    }
  }
  for (const key of Object.keys(value.models)) {
    safeString(key)
    const usage = numericUsage(value.models[key])
    bytes += Buffer.byteLength(JSON.stringify({ [key]: usage }))
    if (bytes > maxResponseBytes - 8192) throw new ProjectionError("limit")
    models[key] = usage
    add(usage)
  }
  // Tool names and payloads are not returned; only their numeric contribution is included.
  if (value.tools !== undefined) {
    if (!record(value.tools)) throw new ProjectionError("invalid-value")
    for (const usage of Object.values(value.tools)) add(numericUsage(usage))
  }
  return { kind: "pi.usage", models, total }
}

function documentScope(scope: DocumentRecord["scope"]): DurableDocumentItem["scope"] {
  if (scope.kind === "session") return { kind: "session" }
  if (scope.kind === "conversation")
    return { kind: "conversation", conversationId: integer(scope.conversationId, true) }
  if (scope.kind === "task") return { kind: "task", taskId: integer(scope.taskId, true) }
  throw new ProjectionError("invalid-value")
}

function documentMetadata(doc: DocumentRecord): DurableDocumentItem {
  return {
    type: "document",
    id: integer(doc.id, true),
    kind: safeString(doc.kind),
    scope: documentScope(doc.scope),
    family: doc.key !== undefined,
    createdAt: integer(doc.createdAt),
    ...(doc.retiredAt === undefined ? {} : { retiredAt: integer(doc.retiredAt) }),
    valueState: "metadata-only",
  }
}

function conversationMetadata(
  value: ConversationRecord,
  active: number | undefined,
): DurableConversationItem {
  return {
    type: "conversation",
    id: integer(value.id, true),
    ...(value.parent
      ? {
          parent: {
            conversationId: integer(value.parent.conversationId, true),
            at: integer(value.parent.at, true),
          },
        }
      : {}),
    ...(value.owner
      ? {
          owner: {
            conversationId: integer(value.owner.conversationId, true),
            taskId: integer(value.owner.taskId, true),
          },
        }
      : {}),
    active: value.id === active,
  }
}

function entryMetadata(value: EntryRecord): DurableInspectionItem {
  // Role is a fixed enum, never an arbitrary message field. Message bodies stay in Storage.
  const role = value.model?.[0]?.role
  return {
    type: "entry",
    id: integer(value.id, true),
    conversationId: integer(value.conversationId, true),
    kind: safeString(value.kind),
    ...(value.byTaskId === undefined ? {} : { byTaskId: integer(value.byTaskId, true) }),
    ...(value.head === undefined ? {} : { head: integer(value.head, true) }),
    ...(value.model?.[0]?.timestamp === undefined
      ? {}
      : { timestamp: integer(value.model[0].timestamp) }),
    ...(role === "system" || role === "user" || role === "assistant" || role === "toolResult"
      ? { role }
      : {}),
  }
}

/**
 * Capture only the existing owner's public reads. Never opens, initializes, or closes storage.
 * SQLite task/entry scans materialize complete records; document() materializes a complete value.
 * Bounds apply to the projection, not native allocation. Cancellation is checked around each awaited
 * read, but cannot interrupt synchronous SQLite work. Never race a read and release its owner early.
 */
export function createDurableInspector(
  storage: DurableInspectionStorage,
  activeConversation: (context: Context) => Promise<number | undefined>,
  chatId: number,
): DurableInspectionReader {
  const key = randomBytes(32)
  let reading = false
  return async (input, signal) => {
    checkSignal(signal)
    if (reading) throw new AdminError(429, "Durable inspection already in progress")
    reading = true
    try {
      // Validate typed callers too; cursor binding uses only normalized query fields.
      const params = new URLSearchParams()
      for (const [name, value] of Object.entries(input)) {
        if (value !== undefined) params.set(name, String(value))
      }
      const query = parseDurableInspectionQuery(params)
      const context = withAbortSignal(signal, BACKGROUND_CONTEXT)
      const read = async <T>(operation: () => Promise<T>): Promise<T> => {
        checkSignal(signal)
        const result = await operation()
        checkSignal(signal)
        return result
      }
      const { cursor: encoded, ...filters } = query
      const binding = createHash("sha256")
        .update(JSON.stringify([chatId, filters]))
        .digest("hex")
      const sign = (body: string) => createHmac("sha256", key).update(body).digest("base64url")
      const encode = (native: Cursor | undefined, skip = 0): string => {
        const body = Buffer.from(JSON.stringify({ binding, native, skip })).toString("base64url")
        const result = `${body}.${sign(body)}`
        if (result.length > maxCursorBytes)
          throw new AdminError(413, "Inspection cursor exceeds limit")
        return result
      }
      let native: Cursor | undefined
      let skip = 0
      if (encoded !== undefined) {
        const parts = encoded.split(".")
        if (parts.length !== 2 || !parts[0] || !parts[1])
          throw new AdminError(400, "Invalid inspection cursor")
        const [body, signature] = parts
        const expected = Buffer.from(sign(body))
        const actual = Buffer.from(signature)
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
          throw new AdminError(400, "Invalid inspection cursor")
        const data: unknown = JSON.parse(Buffer.from(body, "base64url").toString())
        if (
          !record(data) ||
          data.binding !== binding ||
          !Number.isInteger(data.skip) ||
          Number(data.skip) < 0 ||
          Number(data.skip) >= query.limit ||
          (data.native !== undefined && !record(data.native))
        )
          throw new AdminError(400, "Invalid inspection cursor")
        native = data.native as Cursor | undefined
        skip = Number(data.skip)
      }
      const response: DurableInspectionLoadedResponse = {
        version: 1,
        state: "loaded",
        readAt: new Date().toISOString(),
        view: query.view,
        items: [],
        truncated: false,
      }
      const conversationId = query.conversationId as ConversationId
      if (
        query.conversationId !== undefined &&
        !(await read(() => storage.conversation(conversationId, context)))
      )
        return response
      const taskId = query.taskId as TaskId
      if (query.taskId !== undefined) {
        const task = await read(() => storage.task(taskId, context))
        if (!task || task.conversationId !== conversationId) return response
      }
      const scope: DocumentRecord["scope"] =
        query.scope === "session"
          ? { kind: "session" }
          : query.scope === "task"
            ? { kind: "task", taskId }
            : { kind: "conversation", conversationId }
      const sameScope = (doc: DocumentRecord) =>
        doc.scope.kind === scope.kind &&
        (doc.scope.kind === "session" ||
          (doc.scope.kind === "conversation" && doc.scope.conversationId === conversationId) ||
          (doc.scope.kind === "task" && doc.scope.taskId === taskId))
      let page: Page<DurableInspectionItem, Cursor>
      if (query.view === "conversations") {
        const active = await read(() => activeConversation(context))
        if (query.objectId !== undefined) {
          const value = await read(() =>
            storage.conversation(query.objectId as ConversationId, context),
          )
          page = { items: value ? [conversationMetadata(value, active)] : [] }
        } else {
          const values = await read(() =>
            storage.scanConversations({}, query.limit, native, context),
          )
          page = {
            items: values.items.map((value) => conversationMetadata(value, active)),
            next: values.next,
          }
        }
        const selected = page.items.find(
          (item): item is DurableConversationItem =>
            item.type === "conversation" && item.id === active,
        )
        response.selectedConversation = selected ?? null
        if (!selected && active !== undefined && active !== query.objectId) {
          const value = await read(() =>
            storage.conversation(integer(active, true) as ConversationId, context),
          )
          if (value) response.selectedConversation = conversationMetadata(value, active)
        }
      } else if (query.view === "tasks") {
        const values =
          query.objectId === undefined
            ? await read(() => storage.scanTasks({ conversationId }, query.limit, native, context))
            : { items: [await read(() => storage.task(query.objectId as TaskId, context))] }
        page = {
          next: "next" in values ? values.next : undefined,
          items: values.items.flatMap((value): DurableInspectionItem[] =>
            !value || value.conversationId !== conversationId
              ? []
              : [
                  {
                    type: "task",
                    id: integer(value.id, true),
                    conversationId: integer(value.conversationId, true),
                    kind: safeString(value.kind),
                    version: integer(value.version, true),
                    ...(value.owner === undefined
                      ? {}
                      : { ownerTaskId: integer(value.owner, true) }),
                    background: flag(value.background),
                    abortRequested: flag(value.abortRequested),
                    status: taskStatus(value.state.status),
                    ...(value.state.outcome
                      ? { outcome: outcomeStatus(value.state.outcome.status) }
                      : {}),
                    ...(value.startedAt === undefined
                      ? {}
                      : { startedAt: integer(value.startedAt) }),
                    ...(value.endedAt === undefined ? {} : { endedAt: integer(value.endedAt) }),
                  },
                ],
          ),
        }
      } else if (query.view === "entries") {
        if (query.objectId !== undefined) {
          const value = await read(() =>
            storage.entry(conversationId, query.objectId as EntryId, context),
          )
          page = { items: value ? [entryMetadata(value.entry)] : [] }
        } else {
          const values = await read(() =>
            storage.scanEntries({ conversationId }, query.limit, native, context),
          )
          page = { items: values.items.map(entryMetadata), next: values.next }
        }
      } else {
        const approvedKinds =
          scope.kind === "session"
            ? ["sumire.session"]
            : scope.kind === "conversation"
              ? ["pi.agent", "pi.usage"]
              : []
        let values: Page<DocumentRecord, Cursor>
        if (query.objectId === undefined) {
          values = await read(() =>
            storage.scanDocuments({ scope, at: "current" }, query.limit, native, context),
          )
        } else {
          // A bounded metadata gate: never scan arbitrary scopes or materialize an unknown ID.
          // Omitting key selects a singleton, so family members cannot pass this allowlist.
          let selected: DocumentRecord | undefined
          for (const kind of approvedKinds) {
            const doc = await read(() => storage.findDocument({ scope, kind }, "current", context))
            if (
              doc?.id === query.objectId &&
              sameScope(doc) &&
              doc.kind === kind &&
              doc.key === undefined &&
              doc.retiredAt === undefined
            ) {
              selected = doc
              break
            }
          }
          if (!selected) throw new AdminError(404, "Durable document retired or unavailable")
          values = { items: [selected] }
        }
        const items: DurableInspectionItem[] = []
        for (const doc of values.items) {
          if (!sameScope(doc)) continue
          const item = documentMetadata(doc)
          if (doc.key !== undefined || !approvedKinds.includes(doc.kind)) {
            item.valueState = "withheld"
            item.withheldReason = "unknown-kind"
          } else if (query.objectId !== undefined) {
            const stored = await read(() =>
              storage.document(doc.id as DocumentId, "current", context),
            )
            if (
              !stored ||
              stored.record.retiredAt !== undefined ||
              !sameScope(stored.record) ||
              stored.record.id !== doc.id ||
              stored.record.kind !== doc.kind ||
              stored.record.key !== undefined
            ) {
              item.valueState = "unavailable"
            } else {
              item.version = integer(stored.version, true)
              try {
                // Only the known definition version is approved. No arbitrary object recursion.
                if (stored.version !== 1) throw new ProjectionError("invalid-value")
                item.value = project(doc.kind, stored.value)
                item.valueState = "available"
              } catch (error) {
                if (!(error instanceof ProjectionError)) throw error
                item.valueState = "withheld"
                item.withheldReason = error.reason
                if (error.reason === "limit") response.truncated = true
              }
            }
          }
          items.push(item)
        }
        page = { items, next: values.next }
      }
      for (const [index, item] of page.items.entries()) {
        if (index < skip) continue
        response.items.push(item)
        // Reserve room for the largest permitted continuation token and envelope changes.
        if (Buffer.byteLength(JSON.stringify(response)) > maxResponseBytes - maxCursorBytes - 128) {
          response.items.pop()
          response.truncated = true
          if (response.items.length === 0 && item.type === "document") {
            delete item.value
            item.valueState = "withheld"
            item.withheldReason = "limit"
            response.items.push(item)
          } else {
            response.nextCursor = encode(native, index)
            return response
          }
        }
      }
      if (page.next) response.nextCursor = encode(page.next)
      return response
    } catch (error) {
      checkSignal(signal)
      if (error instanceof AdminError) throw error
      if (error instanceof ProjectionError)
        throw new AdminError(
          error.reason === "limit" ? 413 : 503,
          "Durable inspection metadata is unavailable",
        )
      throw new AdminError(503, "Durable inspection read failed")
    } finally {
      reading = false
    }
  }
}
