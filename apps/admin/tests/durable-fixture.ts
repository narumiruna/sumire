import type {
  DurableConversationItem,
  DurableInspectionItem,
  DurableInspectionResponse,
  DurableInspectionView,
} from "@narumitw/sumire-contracts"
import type { Page } from "@playwright/test"

export const readAt = "2026-10-19T12:00:00.000Z"
export const untrusted =
  '<img src="https://untrusted.invalid/pixel" onerror="window.inspectorInjected=true">'
export const historicalConversation: DurableConversationItem = {
  type: "conversation",
  id: 9,
  active: false,
}
export const conversations: DurableInspectionItem[] = [
  {
    type: "conversation",
    id: 7,
    active: true,
    parent: { conversationId: 6, at: 60 },
    owner: { conversationId: 6, taskId: 4 },
  },
]
export const tasks: DurableInspectionItem[] = [
  {
    type: "task",
    id: 8,
    conversationId: 7,
    kind: "pi.generation",
    version: 1,
    background: false,
    abortRequested: false,
    status: "terminal",
    outcome: "completed",
    ownerTaskId: 5,
    // Durable task and entry times are Unix milliseconds; document times below are sequences.
    startedAt: Date.UTC(2026, 9, 19, 11, 59, 0),
    endedAt: Date.UTC(2026, 9, 19, 11, 59, 30),
  },
]
export const documents: DurableInspectionItem[] = [
  {
    type: "document",
    id: 101,
    kind: "pi.agent",
    scope: { kind: "conversation", conversationId: 7 },
    family: false,
    createdAt: 100,
    valueState: "metadata-only",
  },
  {
    type: "document",
    id: 102,
    kind: untrusted,
    scope: { kind: "conversation", conversationId: 7 },
    family: true,
    createdAt: 101,
    valueState: "withheld",
    withheldReason: "unknown-kind",
  },
  {
    type: "document",
    id: 103,
    kind: "pi.usage",
    scope: { kind: "conversation", conversationId: 7 },
    family: false,
    createdAt: 102,
    valueState: "metadata-only",
  },
  {
    type: "document",
    id: 201,
    kind: "sumire.session",
    scope: { kind: "session" },
    family: false,
    createdAt: 103,
    valueState: "metadata-only",
  },
]
export const entries: DurableInspectionItem[] = [
  {
    type: "entry",
    id: 70,
    conversationId: 7,
    kind: "message",
    role: "assistant",
    timestamp: Date.UTC(2026, 9, 19, 11, 59, 30),
    byTaskId: 8,
    head: 60,
  },
]
export function response(
  view: DurableInspectionView,
  items: DurableInspectionItem[],
  extra = {},
): DurableInspectionResponse {
  return { version: 1, state: "loaded", readAt, view, items, truncated: false, ...extra }
}

export async function durableFixture(page: Page, href = "/?section=Durable&chat=42") {
  const state = {
    expired: false,
    failed: false,
    empty: false,
    documentLimit: false,
    usageAvailable: false,
    usageFieldsAbsent: false,
    agentFieldsAbsent: false,
    sessionActiveAbsent: false,
    approvedValueAbsent: false,
    taskTruncated: false,
    selectedConversation: conversations[0] as DurableConversationItem | null | undefined,
    failures: new Map<DurableInspectionView, number>(),
    conversationItems: conversations,
    taskItems: tasks,
    documentItems: documents,
    entryItems: entries,
    chats: [
      { id: 42, name: "Loaded chat", type: "private" },
      { id: 43, name: "Idle chat", type: "private" },
      { id: 44, name: "Unloaded chat", type: "private" },
    ],
    requests: [] as URL[],
    methods: [] as string[],
    gates: new Map<string, Promise<void>>(),
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (state.expired) {
      await route.fulfill({ status: 401, json: { error: "Session expired" } })
      return
    }
    if (url.pathname.endsWith("/durable")) {
      state.requests.push(url)
      state.methods.push(request.method())
      const objectId = url.searchParams.get("objectId")
      const gate = state.gates.get(`${url.pathname}:${objectId ?? "list"}`)
      if (gate) await gate
      if (state.failed) {
        await route.fulfill({ status: 500, json: { error: "Read failed" } })
        return
      }
      const view = url.searchParams.get("view") as DurableInspectionView
      const failure = state.failures.get(view)
      if (failure) {
        await route.fulfill({
          status: failure,
          json: { error: failure === 403 ? "Forbidden" : "Read failed" },
        })
        return
      }
      if (url.pathname.includes("/44/")) {
        await route.fulfill({
          json: {
            version: 1,
            state: "not-loaded",
            readAt,
            view,
            items: [],
            truncated: false,
          } satisfies DurableInspectionResponse,
        })
        return
      }
      const cursor = url.searchParams.get("cursor")
      let items = {
        conversations: state.conversationItems,
        tasks: state.taskItems,
        documents: state.documentItems,
        entries: state.entryItems,
      }[view]
      if (view === "conversations") {
        if (url.pathname.includes("/43/")) items = [{ type: "conversation", id: 17, active: false }]
        else if (objectId === "9" && !items.some((item) => item.id === 9))
          items = [historicalConversation]
        else if (cursor) items = [historicalConversation]
        items = items.map((item) =>
          item.type === "conversation"
            ? { ...item, active: item.id === state.selectedConversation?.id }
            : item,
        )
      } else if (cursor) items = []
      if (view === "tasks" || view === "entries")
        items = items.filter(
          (item) =>
            (item.type === "task" || item.type === "entry") &&
            item.conversationId === Number(url.searchParams.get("conversationId")),
        )
      if (view === "documents") {
        const scope = url.searchParams.get("scope") ?? "conversation"
        items = items.filter(
          (item) =>
            item.type === "document" &&
            item.scope.kind === scope &&
            (item.scope.kind === "session" ||
              (item.scope.kind === "conversation" &&
                item.scope.conversationId === Number(url.searchParams.get("conversationId"))) ||
              (item.scope.kind === "task" &&
                item.scope.taskId === Number(url.searchParams.get("taskId")))),
        )
      }
      if (objectId) {
        items = items.filter((item) => item.id === Number(objectId))
        if (view === "documents") {
          const item = items[0]
          if (item?.type !== "document" || item.valueState === "withheld") {
            await route.fulfill({
              status: 404,
              json: { error: "Durable document retired or unavailable" },
            })
            return
          }
          if (item.id === 101)
            items = [
              {
                ...item,
                version: 1,
                ...(state.documentLimit
                  ? { valueState: "withheld", withheldReason: "limit" }
                  : {
                      valueState: "available",
                      value: {
                        kind: "pi.agent",
                        ...(state.agentFieldsAbsent
                          ? {}
                          : {
                              model: { provider: "fixture", modelId: untrusted },
                              thinkingLevel: "low",
                            }),
                      },
                    }),
              },
            ]
          if (item.id === 103)
            items = [
              state.usageAvailable
                ? {
                    ...item,
                    version: 1,
                    valueState: "available",
                    value: {
                      kind: "pi.usage",
                      total: state.usageFieldsAbsent
                        ? {}
                        : { input: 0, total: 0, cost: { total: 0 } },
                      models: state.usageFieldsAbsent
                        ? {}
                        : {
                            "fixture/model-a": {
                              input: 12,
                              output: 3,
                              total: 15,
                              cost: { input: 0.001, output: 0.002, total: 0.003 },
                            },
                            "fixture/model-b": { output: 0, cost: { output: 0 } },
                          },
                    },
                  }
                : { ...item, valueState: "unavailable" },
            ]
          if (item.id === 201)
            items = [
              {
                ...item,
                version: 1,
                valueState: "available",
                value: {
                  kind: "sumire.session",
                  ...(state.sessionActiveAbsent ? {} : { activeConversation: 7 }),
                },
              },
            ]
          if (state.approvedValueAbsent)
            items = items.map((item) =>
              item.type === "document" && item.valueState === "available"
                ? { ...item, value: undefined }
                : item,
            )
        }
      }
      await route.fulfill({
        json: response(view, state.empty ? [] : items, {
          readAt: view === "tasks" ? "2026-10-19T12:00:01.000Z" : readAt,
          ...(view === "tasks" && state.taskTruncated && !cursor
            ? { truncated: true, nextCursor: "task-history-cursor" }
            : {}),
          ...(view === "conversations"
            ? {
                selectedConversation: url.pathname.includes("/43/")
                  ? null
                  : state.selectedConversation,
              }
            : {}),
          ...(view === "conversations" && !objectId && !url.searchParams.has("cursor")
            ? { nextCursor: "opaque+/=token", truncated: true }
            : {}),
        }),
      })
      return
    }
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", actor: "42" },
      "/api/settings": {
        revision: 1,
        applied: 1,
        status: "applied",
        policy: {
          tools: [],
          servers: [],
          models: [],
          providers: [],
          defaults: { tools: [], servers: [], models: [], model: null, thinking: "off" },
          privateUsers: [42, 43, 44],
          groups: [],
          chats: {},
        },
      },
      "/api/inventory": { tools: [], builtInTools: [], mcp: [], providers: [] },
      "/api/chats": url.searchParams.has("id")
        ? state.chats.filter((chat) => String(chat.id) === url.searchParams.get("id"))
        : state.chats.filter(
            (chat) =>
              !url.searchParams.get("q") ||
              `${chat.name} ${chat.id}`
                .toLowerCase()
                .includes(url.searchParams.get("q")?.toLowerCase() ?? ""),
          ),
      "/api/audit": [],
      "/api/imports": [],
    }
    await route.fulfill({ json: data[url.pathname] ?? {} })
  })
  await page.goto(href)
  return state
}

export async function navigateSection(page: Page, name: string) {
  const link = page
    .getByRole("navigation", { name: "Administration sections" })
    .getByRole("link", { name, exact: true })
  if (!(await link.isVisible())) await page.getByRole("button", { name: /^Sections ·/ }).click()
  await link.click()
}
