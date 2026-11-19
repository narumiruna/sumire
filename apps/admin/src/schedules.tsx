import type { Chat, Schedule, ScheduleInput, ScheduleList } from "@narumitw/sumire-contracts"
import { CalendarIcon, PlusIcon, ReloadIcon } from "@radix-ui/react-icons"
import { Badge, Button, Callout, Flex, Heading, Text, TextArea } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { errorMessage, LocalizedError, t } from "./i18n.js"
import { formatScheduleTime, localScheduleTime, parseScheduleTime } from "./schedule-time.js"
import { Panel } from "./surfaces.js"

export function Schedules({
  active,
  csrf,
  allowedIds,
  knownChats,
  selectedChat,
  ready,
  onExpired,
  onPending,
}: {
  active: boolean
  csrf: string
  allowedIds: number[]
  knownChats: Chat[]
  selectedChat: string
  ready: boolean
  onExpired(): void
  onPending(value: boolean): void
}) {
  const [result, setResult] = useState<ScheduleList>()
  const [error, setError] = useState<Error | string>("")
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [task, setTask] = useState("")
  const [chatId, setChatId] = useState(() =>
    allowedIds.includes(Number(selectedChat)) ? selectedChat : String(allowedIds[0] ?? ""),
  )
  const [runAt, setRunAt] = useState(() => localScheduleTime(new Date(Date.now() + 3600_000)))
  const [repeatMinutes, setRepeatMinutes] = useState<ScheduleInput["repeatMinutes"]>(null)
  const [notice, setNotice] = useState(false)
  const [filter, setFilter] = useState<Schedule["state"] | "all">("all")
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const callbacks = useRef({ onExpired, onPending })
  callbacks.current = { onExpired, onPending }
  const alive = useRef(true)
  const mutex = useRef(false)
  const readVersion = useRef(0)
  const requests = useRef(new AbortController())
  const creation = useRef<{ fingerprint: string; id: string } | undefined>(undefined)
  const taskInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    requests.current = controller
    return () => {
      alive.current = false
      controller.abort()
      callbacks.current.onPending(false)
    }
  }, [])
  useEffect(() => {
    callbacks.current.onPending(editing && Boolean(task.trim()))
  }, [editing, task])
  useEffect(() => {
    if (editing && active) taskInput.current?.focus()
  }, [editing, active])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly reloads the bounded list.
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let reading = false
    const load = async () => {
      if (reading || mutex.current || document.hidden) return
      reading = true
      const version = ++readVersion.current
      try {
        const list = await request<ScheduleList>(
          "schedules",
          undefined,
          undefined,
          "GET",
          controller.signal,
        )
        if (!controller.signal.aborted && version === readVersion.current) {
          setResult(list)
        }
      } catch (failure) {
        if (controller.signal.aborted || version !== readVersion.current) return
        if (failure instanceof ApiError && failure.status === 401) callbacks.current.onExpired()
        else
          setError(failure instanceof Error ? failure : new LocalizedError("schedule.loadFailed"))
      } finally {
        reading = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    document.addEventListener("visibilitychange", load)
    return () => {
      controller.abort()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", load)
    }
  }, [active, refresh])
  async function operate(work: () => Promise<void>) {
    if (mutex.current) return
    mutex.current = true
    readVersion.current++
    setBusy(true)
    setError("")
    setNotice(false)
    try {
      await work()
      if (alive.current) setNotice(true)
    } catch (failure) {
      if (!alive.current) return
      if (failure instanceof ApiError && failure.status === 401) callbacks.current.onExpired()
      else
        setError(
          failure instanceof ApiError || failure instanceof LocalizedError
            ? failure
            : new LocalizedError("schedule.operationFailed"),
        )
    } finally {
      mutex.current = false
      if (alive.current) {
        setBusy(false)
        setRefresh((value) => value + 1)
      }
    }
  }
  const name = (id: number) => {
    const chat = knownChats.find((chat) => chat.id === id)
    return chat?.name?.trim() && chat.name !== String(id) ? `${chat.name} · ${id}` : String(id)
  }
  let preview = ""
  try {
    preview = formatScheduleTime(parseScheduleTime(runAt), timeZone)
  } catch {
    /* Validation appears on submit. */
  }
  const items = result?.items.filter((item) => filter === "all" || item.state === filter)
  const repeatLabel = (minutes: Schedule["repeatMinutes"]) =>
    t(
      minutes === null
        ? "schedule.once"
        : minutes === 60
          ? "schedule.hourly"
          : minutes === 1440
            ? "schedule.daily"
            : "schedule.weekly",
    )
  const resetDraft = () => {
    setEditing(false)
    setTask("")
    creation.current = undefined
  }
  const replace = (schedule: Schedule) => {
    if (!alive.current) return
    setResult((previous) => ({
      limit: previous?.limit ?? 100,
      items: [schedule, ...(previous?.items ?? []).filter((item) => item.id !== schedule.id)],
    }))
  }
  return (
    <div className="schedule-workspace" aria-busy={busy}>
      <Flex gap="3" align="center" wrap="wrap" className="schedule-toolbar">
        <Button
          disabled={
            busy ||
            editing ||
            !ready ||
            allowedIds.length === 0 ||
            (result !== undefined && result.items.length >= result.limit)
          }
          onClick={() => {
            setEditing(true)
            setNotice(false)
          }}
        >
          <PlusIcon aria-hidden />
          {t("schedule.add")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setError("")
            setRefresh((value) => value + 1)
          }}
        >
          <ReloadIcon aria-hidden />
          {t("schedule.refresh")}
        </Button>
        <Text size="2" color="gray">
          {t("schedule.count", { count: result?.items.length ?? 0, limit: result?.limit ?? 100 })}
        </Text>
      </Flex>
      {!ready && (
        <Callout.Root color="orange">
          <Callout.Text>{t("schedule.policyPending")}</Callout.Text>
        </Callout.Root>
      )}
      {ready && allowedIds.length === 0 && <Text as="p">{t("schedule.noChats")}</Text>}
      {error && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{errorMessage(error)}</Callout.Text>
        </Callout.Root>
      )}
      {notice && (
        <Text as="p" role="status" color="green">
          {t("schedule.saved")}
        </Text>
      )}
      {editing && (
        <Panel className="schedule-editor" aria-labelledby="schedule-editor-title">
          <Heading as="h2" size="4" id="schedule-editor-title">
            {t("schedule.add")}
          </Heading>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void operate(async () => {
                const input: ScheduleInput = {
                  chatId: Number(chatId),
                  task: task.trim(),
                  runAt: parseScheduleTime(runAt),
                  timeZone,
                  repeatMinutes,
                }
                const fingerprint = JSON.stringify(input)
                if (creation.current?.fingerprint !== fingerprint)
                  creation.current = { fingerprint, id: crypto.randomUUID() }
                const created = await request<Schedule>(
                  "schedules",
                  csrf,
                  { ...input, requestId: creation.current.id },
                  "POST",
                  requests.current.signal,
                )
                if (alive.current) {
                  replace(created)
                  resetDraft()
                }
              })
            }}
          >
            <fieldset disabled={busy}>
              <div className="schedule-field">
                <label htmlFor="schedule-task-input">
                  <Text weight="medium">{t("schedule.task")}</Text>
                </label>
                <Text size="2" color="gray" id="schedule-task-help">
                  {t("schedule.taskHelp")}
                </Text>
                <TextArea
                  ref={taskInput}
                  id="schedule-task-input"
                  aria-describedby="schedule-task-help"
                  rows={5}
                  required
                  maxLength={8000}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder={t("schedule.taskPlaceholder")}
                />
              </div>
              <div className="schedule-form-grid">
                <div className="schedule-field">
                  <label htmlFor="schedule-chat">
                    <Text weight="medium">{t("schedule.chat")}</Text>
                  </label>
                  <select
                    id="schedule-chat"
                    className="schedule-input"
                    required
                    value={chatId}
                    onChange={(event) => setChatId(event.target.value)}
                  >
                    <option value="" disabled>
                      {t("schedule.selectChat")}
                    </option>
                    {allowedIds.map((id) => (
                      <option key={id} value={id}>
                        {name(id)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="schedule-field">
                  <label htmlFor="schedule-time">
                    <Text weight="medium">{t("schedule.when")}</Text>
                  </label>
                  <input
                    className="schedule-input"
                    id="schedule-time"
                    type="datetime-local"
                    required
                    step={60}
                    value={runAt}
                    onChange={(event) => setRunAt(event.target.value)}
                    aria-describedby="schedule-time-help"
                  />
                </div>
                <div className="schedule-field">
                  <label htmlFor="schedule-repeat">
                    <Text weight="medium">{t("schedule.repeat")}</Text>
                  </label>
                  <select
                    id="schedule-repeat"
                    className="schedule-input"
                    value={repeatMinutes ?? "once"}
                    onChange={(event) =>
                      setRepeatMinutes(
                        event.target.value === "once"
                          ? null
                          : (Number(event.target.value) as 60 | 1440 | 10080),
                      )
                    }
                  >
                    <option value="once">{t("schedule.once")}</option>
                    <option value="60">{t("schedule.hourly")}</option>
                    <option value="1440">{t("schedule.daily")}</option>
                    <option value="10080">{t("schedule.weekly")}</option>
                  </select>
                </div>
              </div>
              <Text as="p" size="2" id="schedule-time-help">
                {t("schedule.timeHelp", { zone: timeZone })}
              </Text>
              {preview && (
                <p className="schedule-preview">
                  {t("schedule.preview", { time: preview, chat: name(Number(chatId)) })}
                </p>
              )}
              <Text as="p" size="2" color="gray">
                {t("schedule.repeatHelp")}
              </Text>
              <Flex gap="3" wrap="wrap">
                <Button
                  type="submit"
                  disabled={!ready || !task.trim() || !allowedIds.includes(Number(chatId))}
                >
                  {t("schedule.create")}
                </Button>
                <Button
                  type="button"
                  variant="soft"
                  onClick={() => {
                    if (!task.trim() || window.confirm(t("schedule.discard"))) resetDraft()
                  }}
                >
                  {t("schedule.cancel")}
                </Button>
              </Flex>
            </fieldset>
          </form>
        </Panel>
      )}
      <div className="schedule-list-heading">
        <Heading as="h2" size="4">
          {t("schedule.list")}
        </Heading>
        <div className="schedule-filter">
          <label htmlFor="schedule-filter">
            <Text size="2">{t("schedule.filter")}</Text>
          </label>
          <select
            id="schedule-filter"
            className="schedule-input"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Schedule["state"] | "all")}
          >
            <option value="all">{t("schedule.all")}</option>
            <option value="active">{t("schedule.state.active")}</option>
            <option value="paused">{t("schedule.state.paused")}</option>
            <option value="completed">{t("schedule.state.completed")}</option>
          </select>
        </div>
      </div>
      {!result ? (
        <Text role="status">{t("schedule.loading")}</Text>
      ) : items?.length === 0 ? (
        <Panel className="schedule-empty">
          <CalendarIcon aria-hidden width="32" height="32" />
          <Heading as="h3" size="4">
            {t(result.items.length ? "schedule.noMatches" : "schedule.empty")}
          </Heading>
          <Text as="p" size="2" color="gray">
            {t("schedule.emptyHelp")}
          </Text>
        </Panel>
      ) : (
        <div className="schedule-list">
          {items?.map((schedule) => (
            <Panel
              key={schedule.id}
              as="section"
              className="schedule-card"
              aria-labelledby={`schedule-${schedule.id}`}
            >
              <Flex justify="between" align="center" gap="3" wrap="wrap">
                <Heading as="h3" size="3" id={`schedule-${schedule.id}`}>
                  {t("schedule.entry", { id: schedule.id.slice(0, 8) })}
                </Heading>
                <Badge color={schedule.state === "active" ? "green" : "gray"}>
                  {t(`schedule.state.${schedule.state}`)}
                </Badge>
              </Flex>
              <p className="schedule-task">{schedule.task}</p>
              <dl className="schedule-metadata">
                <div>
                  <dt>{t("schedule.chat")}</dt>
                  <dd>{name(schedule.chatId)}</dd>
                </div>
                <div>
                  <dt>{t("schedule.next")}</dt>
                  <dd>
                    {schedule.nextRunAt === null ? (
                      t("schedule.noNext")
                    ) : (
                      <time dateTime={new Date(schedule.nextRunAt).toISOString()}>
                        {formatScheduleTime(schedule.nextRunAt, schedule.timeZone)}
                      </time>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("schedule.repeat")}</dt>
                  <dd>
                    {repeatLabel(schedule.repeatMinutes)} · {schedule.timeZone}
                  </dd>
                </div>
                {schedule.lastOutcome && (
                  <div>
                    <dt>{t("schedule.last")}</dt>
                    <dd>
                      {t(`schedule.outcome.${schedule.lastOutcome}`)}
                      {schedule.lastRunAt !== null && (
                        <> · {formatScheduleTime(schedule.lastRunAt, schedule.timeZone)}</>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {schedule.lastOutcome === "interrupted" && (
                <Callout.Root color="orange">
                  <Callout.Text>{t("schedule.interruptedHelp")}</Callout.Text>
                </Callout.Root>
              )}
              {schedule.lastOutcome === "failed" && (
                <Text as="p" size="2" color="red">
                  {t("schedule.failedHelp")}
                </Text>
              )}
              <Flex gap="3" wrap="wrap" className="schedule-card-actions">
                {schedule.state === "active" && (
                  <Button
                    variant="soft"
                    disabled={busy}
                    onClick={() =>
                      void operate(async () => {
                        replace(
                          await request<Schedule>(
                            `schedules/${schedule.id}`,
                            csrf,
                            { revision: schedule.revision, action: "pause" },
                            "PUT",
                            requests.current.signal,
                          ),
                        )
                      })
                    }
                  >
                    {t("schedule.pause")}
                  </Button>
                )}
                {schedule.state === "paused" && (
                  <Button
                    variant="soft"
                    disabled={
                      busy ||
                      !ready ||
                      schedule.lastOutcome === "running" ||
                      schedule.lastOutcome === "interrupted" ||
                      schedule.nextRunAt === null
                    }
                    onClick={() => {
                      if (
                        !window.confirm(
                          t(
                            schedule.repeatMinutes === null &&
                              (schedule.nextRunAt ?? 0) <= Date.now()
                              ? "schedule.resumeOverdue"
                              : "schedule.resumeConfirm",
                          ),
                        )
                      )
                        return
                      void operate(async () => {
                        replace(
                          await request<Schedule>(
                            `schedules/${schedule.id}`,
                            csrf,
                            { revision: schedule.revision, action: "resume" },
                            "PUT",
                            requests.current.signal,
                          ),
                        )
                      })
                    }}
                  >
                    {t("schedule.resume")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  color="red"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(t("schedule.deleteConfirm"))) return
                    void operate(async () => {
                      await request(
                        `schedules/${schedule.id}`,
                        csrf,
                        { revision: schedule.revision },
                        "DELETE",
                        requests.current.signal,
                      )
                      if (alive.current)
                        setResult(
                          (previous) =>
                            previous && {
                              ...previous,
                              items: previous.items.filter((item) => item.id !== schedule.id),
                            },
                        )
                    })
                  }}
                >
                  {t("schedule.delete")}
                </Button>
              </Flex>
            </Panel>
          ))}
        </div>
      )}
      <Text as="p" size="2" color="gray" className="schedule-footnote">
        {t("schedule.executionHelp")}
      </Text>
    </div>
  )
}
