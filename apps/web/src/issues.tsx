import type { Issue, IssuePage, IssueState } from "@narumitw/sumire-issues"
import { Badge, Button, Callout, Flex, Heading, Text } from "@radix-ui/themes"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { errorMessage, LocalizedError, type MessageKey, t } from "./i18n.js"
import { IssueAnalysisPanel } from "./issue-analysis.js"
import { IssuesList } from "./issues-list.js"

const IssuesMcpGrants = lazy(() => import("./issues-mcp-grants.js"))
const date = (value: number) => new Date(value).toLocaleString("zh-TW")
export function Issues({
  csrf,
  created,
  onExpired,
  onConsumed,
}: {
  csrf: string
  created?: Issue
  onExpired(): void
  onConsumed(): void
}) {
  const [page, setPage] = useState<IssuePage>()
  const [selected, setSelected] = useState<Issue | undefined>(created)
  const [filter, setFilter] = useState<IssueState | "">("")
  const [cursors, setCursors] = useState<number[]>([])
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | string>("")
  const [listError, setListError] = useState<Error>()
  const listRef = useRef<HTMLDivElement>(null)
  const returnToIssue = useRef<number | undefined>(undefined)
  const [screenshotReload, setScreenshotReload] = useState(0)
  const generation = useRef(0)
  const alive = useRef(true)
  const requests = useRef(new AbortController())
  const [notice, setNotice] = useState<number>()
  const onConsumedRef = useRef(onConsumed)
  onConsumedRef.current = onConsumed
  const onExpiredRef = useRef(onExpired)
  onExpiredRef.current = onExpired
  useEffect(
    () => () => {
      alive.current = false
      generation.current++
      requests.current.abort()
    },
    [],
  )
  useEffect(() => {
    if (created) {
      generation.current++
      returnToIssue.current = undefined
      setError("")
      setNotice(created.id)
      onConsumedRef.current()
      setSelected(created)
      setCursors([])
      setFilter("")
      setRefresh((value) => value + 1)
    }
  }, [created])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh invalidates the bounded issue page.
  useEffect(() => {
    const controller = new AbortController()
    setPage(undefined)
    setListError(undefined)
    const query = new URLSearchParams()
    if (filter) query.set("state", filter)
    const before = cursors.at(-1)
    if (before) query.set("before", String(before))
    void request<IssuePage>(`issues?${query}`, undefined, undefined, "GET", controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPage(value)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) onExpiredRef.current()
        else
          setListError(
            error instanceof ApiError ? error : new LocalizedError("issues.list.readFailed"),
          )
      })
    return () => controller.abort()
  }, [filter, cursors, refresh])
  useEffect(() => {
    const issueId = returnToIssue.current
    const list = listRef.current
    if (issueId === undefined || !list || selected || busy || (!page && !listError)) return
    returnToIssue.current = undefined
    // Do not take focus back if the administrator moved on while the list loaded.
    if (list.ownerDocument.activeElement !== list.ownerDocument.body) return
    const row = list.querySelector<HTMLButtonElement>(`button[data-issue-id="${issueId}"]`)
    const fallback = list.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    const target = row ?? fallback
    target?.focus()
  }, [busy, listError, page, selected])
  async function operate(work: (version: number) => Promise<void>, fallback?: MessageKey) {
    if (busy) return
    setBusy(true)
    setError("")
    const version = ++generation.current
    try {
      await work(version)
    } catch (error) {
      if (!alive.current) return
      if (error instanceof ApiError && error.status === 401) onExpiredRef.current()
      else if (version === generation.current)
        setError(
          error instanceof ApiError
            ? error
            : fallback
              ? new LocalizedError(fallback)
              : error instanceof Error
                ? error
                : "操作失敗，請重新整理確認狀態。",
        )
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function detail(id: number, version: number) {
    const issue = await request<Issue>(
      `issues/${id}`,
      undefined,
      undefined,
      "GET",
      requests.current.signal,
    )
    if (alive.current && version === generation.current) {
      setSelected(issue)
      setScreenshotReload((value) => value + 1)
    }
  }
  const visibleError = error || (!selected && listError)
  return (
    <section aria-label="Issues" className="issues-workspace">
      <Text as="p">{t("issues.pageHelp")}</Text>
      {notice && (
        <Text as="p" role="status">
          回饋 #{notice} 已儲存。
        </Text>
      )}
      {visibleError && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{errorMessage(visibleError)}</Callout.Text>
        </Callout.Root>
      )}
      {selected ? (
        <article className="issue-detail" aria-labelledby="issue-detail-heading">
          <header className="issue-detail-header">
            <Heading as="h2" id="issue-detail-heading" size="6">
              #{selected.id} {selected.title}
            </Heading>
            <Badge color={selected.state === "open" ? "green" : "gray"}>
              {selected.state === "open" ? "開啟中" : "已關閉"}
            </Badge>
          </header>
          <Flex className="issue-detail-actions" gap="3" wrap="wrap" align="center">
            <Button
              variant="soft"
              disabled={busy}
              onClick={() => {
                generation.current++
                returnToIssue.current = selected.id
                setSelected(undefined)
              }}
            >
              返回列表
            </Button>
            <Button
              variant="soft"
              disabled={busy}
              onClick={() => void operate((version) => detail(selected.id, version))}
            >
              重新整理回饋
            </Button>
            <Button
              variant="soft"
              disabled={busy}
              onClick={() =>
                void operate(async (version) => {
                  const issue = await request<Issue>(
                    `issues/${selected.id}`,
                    csrf,
                    {
                      revision: selected.revision,
                      state: selected.state === "open" ? "closed" : "open",
                    },
                    "PUT",
                    requests.current.signal,
                  )
                  if (alive.current) {
                    if (version === generation.current) setSelected(issue)
                    setRefresh((value) => value + 1)
                  }
                })
              }
            >
              {selected.state === "open" ? "關閉回饋" : "重新開啟"}
            </Button>
            <Button
              color="red"
              variant="soft"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `永久刪除回饋 #${selected.id} 及其截圖？此操作無法復原；備份中的副本需另行清除。`,
                  )
                )
                  return
                void operate(async (version) => {
                  await request(
                    `issues/${selected.id}`,
                    csrf,
                    { revision: selected.revision },
                    "DELETE",
                    requests.current.signal,
                  )
                  if (alive.current) {
                    if (version === generation.current) {
                      generation.current++
                      setSelected(undefined)
                    }
                    setCursors([])
                    setRefresh((value) => value + 1)
                  }
                })
              }}
            >
              永久刪除
            </Button>
          </Flex>
          <div className="issue-detail-columns">
            <div className="issue-report">
              <div className="issue-report-meta">
                <Text as="p" size="2" color="gray">
                  {selected.section} · {date(selected.createdAt)}
                </Text>
                <Text as="p" size="2" color="gray">
                  回報時視窗：{selected.source.viewport.width} × {selected.source.viewport.height}
                  {" · "}更新：{date(selected.updatedAt)}
                </Text>
              </div>
              {selected.description ? (
                <p className="issue-description">{selected.description}</p>
              ) : (
                <Text as="p" color="gray">
                  未提供文字描述。
                </Text>
              )}
              {selected.hasScreenshot && (
                <IssueScreenshot
                  key={`image:${selected.id}`}
                  id={selected.id}
                  reload={screenshotReload}
                />
              )}
            </div>
            <IssueAnalysisPanel
              key={selected.id}
              issue={selected}
              csrf={csrf}
              onExpired={onExpired}
            />
          </div>
        </article>
      ) : (
        <IssuesList
          page={page}
          filter={filter}
          failed={Boolean(listError)}
          busy={busy}
          hasPrevious={cursors.length > 0}
          grants={
            <Suspense fallback={null}>
              <IssuesMcpGrants csrf={csrf} onExpired={onExpired} />
            </Suspense>
          }
          listRef={listRef}
          onFilter={(value) => {
            setFilter(value)
            setCursors([])
          }}
          onRefresh={() => setRefresh((value) => value + 1)}
          onPrevious={() => setCursors((value) => value.slice(0, -1))}
          onNext={(next) => setCursors((value) => [...value, next])}
          onOpen={(id) => void operate((version) => detail(id, version), "issues.list.openFailed")}
        />
      )}
    </section>
  )
}

function IssueScreenshot({ id, reload }: { id: number; reload: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <>
      {failed && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>截圖無法載入，請確認登入狀態後重新整理。</Callout.Text>
        </Callout.Root>
      )}
      <img
        key={reload}
        className="issue-screenshot"
        src={`/api/issues/${id}/screenshot?reload=${reload}`}
        alt={`回饋 #${id} 的標註截圖`}
        hidden={failed}
        onError={(event) => {
          if (event.currentTarget.isConnected) setFailed(true)
        }}
        onLoad={(event) => {
          const image = event.currentTarget
          void image.decode().then(
            () => {
              if (image.isConnected) setFailed(false)
            },
            () => {
              if (image.isConnected) setFailed(true)
            },
          )
        }}
      />
    </>
  )
}
