import type { Issue, IssuePage, IssueState } from "@narumitw/sumire-issues"
import { Badge, Button, Callout, Flex, Heading, Table, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { t } from "./i18n.js"
import { IssueAnalysisPanel } from "./issue-analysis.js"

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
  const [listError, setListError] = useState("")
  const [detailError, setDetailError] = useState("")
  const [screenshotFailed, setScreenshotFailed] = useState(false)
  const [screenshotAttempt, setScreenshotAttempt] = useState(0)
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
      setNotice(created.id)
      onConsumedRef.current()
      setSelected(created)
      setDetailError("")
      setScreenshotFailed(false)
      setCursors([])
      setFilter("")
      setRefresh((value) => value + 1)
    }
  }, [created])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh invalidates the bounded issue page.
  useEffect(() => {
    const controller = new AbortController()
    setPage(undefined)
    setListError("")
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
        else setListError(error instanceof Error ? error.message : "無法讀取回饋。")
      })
    return () => controller.abort()
  }, [filter, cursors, refresh])
  async function operate(work: (isCurrent: () => boolean) => Promise<void>) {
    if (busy) return
    const version = generation.current
    const isCurrent = () => alive.current && version === generation.current
    setBusy(true)
    setDetailError("")
    try {
      await work(isCurrent)
    } catch (error) {
      if (!alive.current) return
      if (error instanceof ApiError && error.status === 401) onExpiredRef.current()
      else if (isCurrent())
        setDetailError(error instanceof Error ? error.message : "操作失敗，請重新整理確認狀態。")
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  function detail(id: number) {
    return operate(async (isCurrent) => {
      const issue = await request<Issue>(
        `issues/${id}`,
        undefined,
        undefined,
        "GET",
        requests.current.signal,
      )
      if (!isCurrent()) return
      setSelected(issue)
      if (selected?.id === id && issue.hasScreenshot) setScreenshotAttempt((value) => value + 1)
      else setScreenshotFailed(false)
    })
  }
  const error = detailError || (selected ? "" : listError)
  return (
    <section aria-label="Issues" className="issues-workspace">
      <Text as="p">{t("issues.pageHelp")}</Text>
      {notice && (
        <Text as="p" role="status">
          回饋 #{notice} 已儲存。
        </Text>
      )}
      {error && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {selected ? (
        <>
          <Flex gap="3" wrap="wrap" align="center">
            <Button
              variant="soft"
              disabled={busy}
              onClick={() => {
                generation.current++
                setSelected(undefined)
                setDetailError("")
                setScreenshotFailed(false)
              }}
            >
              返回列表
            </Button>
            <Button variant="soft" disabled={busy} onClick={() => void detail(selected.id)}>
              重新整理回饋
            </Button>
          </Flex>
          <Heading as="h2" size="4">
            #{selected.id} {selected.title}
          </Heading>
          <Text as="p">
            <Badge color={selected.state === "open" ? "green" : "gray"}>
              {selected.state === "open" ? "開啟中" : "已關閉"}
            </Badge>
            　{selected.section} · {date(selected.createdAt)}
          </Text>
          <Text as="p" size="2">
            回報時視窗：{selected.source.viewport.width} × {selected.source.viewport.height} ·
            更新：{date(selected.updatedAt)}
          </Text>
          {selected.description ? (
            <p className="issue-description">{selected.description}</p>
          ) : (
            <Text as="p" color="gray">
              未提供文字描述。
            </Text>
          )}
          {selected.hasScreenshot && (
            <img
              key={`${selected.id}:${screenshotAttempt}`}
              className="issue-screenshot"
              src={`/api/issues/${selected.id}/screenshot?attempt=${screenshotAttempt}`}
              alt={`回饋 #${selected.id} 的標註截圖`}
              hidden={screenshotFailed}
              onError={() => setScreenshotFailed(true)}
              onLoad={() => setScreenshotFailed(false)}
            />
          )}
          {selected.hasScreenshot && screenshotFailed && (
            <Callout.Root color="red" role="alert">
              <Callout.Text>截圖無法載入，請確認登入狀態後重新整理。</Callout.Text>
            </Callout.Root>
          )}
          <IssueAnalysisPanel
            key={selected.id}
            issue={selected}
            csrf={csrf}
            onExpired={onExpired}
          />
          <Flex gap="3" wrap="wrap">
            <Button
              disabled={busy}
              onClick={() =>
                void operate(async (isCurrent) => {
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
                  if (isCurrent()) setSelected(issue)
                  if (alive.current) setRefresh((value) => value + 1)
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
                void operate(async (isCurrent) => {
                  await request(
                    `issues/${selected.id}`,
                    csrf,
                    { revision: selected.revision },
                    "DELETE",
                    requests.current.signal,
                  )
                  if (isCurrent()) {
                    setSelected(undefined)
                    setScreenshotFailed(false)
                    setCursors([])
                  }
                  if (alive.current) setRefresh((value) => value + 1)
                })
              }}
            >
              永久刪除
            </Button>
          </Flex>
        </>
      ) : (
        <>
          <Flex gap="3" wrap="wrap" align="center">
            <label>
              狀態{" "}
              <select
                aria-label="篩選回饋狀態"
                value={filter}
                disabled={busy}
                onChange={(event) => {
                  setFilter(event.target.value as IssueState | "")
                  setCursors([])
                }}
              >
                <option value="">全部</option>
                <option value="open">開啟中</option>
                <option value="closed">已關閉</option>
              </select>
            </label>
            <Button variant="soft" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
              重新整理列表
            </Button>
          </Flex>
          {!page ? (
            <Text as="p" role="status">
              {listError ? "尚未載入回饋。" : "載入中…"}
            </Text>
          ) : (
            <>
              <Table.Root variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>編號／標題</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>來源頁面</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>狀態</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>更新時間</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {page.issues.map((issue) => (
                    <Table.Row key={issue.id}>
                      <Table.Cell>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void detail(issue.id)}
                        >
                          #{issue.id} {issue.title}
                        </Button>
                        {issue.hasScreenshot && (
                          <Text as="span" size="2">
                            {" "}
                            · 附截圖
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>{issue.section}</Table.Cell>
                      <Table.Cell>{issue.state === "open" ? "開啟中" : "已關閉"}</Table.Cell>
                      <Table.Cell>{date(issue.updatedAt)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
              {!page.issues.length && (
                <Text as="p">目前沒有符合條件的回饋。使用左下角的回饋按鈕新增。</Text>
              )}
              <Flex gap="3">
                <Button
                  variant="soft"
                  disabled={busy || !cursors.length}
                  onClick={() => setCursors((value) => value.slice(0, -1))}
                >
                  上一頁
                </Button>
                <Button
                  variant="soft"
                  disabled={busy || !page.next}
                  onClick={() => {
                    if (page.next) setCursors((value) => [...value, page.next as number])
                  }}
                >
                  下一頁
                </Button>
              </Flex>
            </>
          )}
        </>
      )}
    </section>
  )
}
