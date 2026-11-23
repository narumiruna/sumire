import type { Chat, Schedule, ScheduleInput, ScheduleList } from "@narumitw/sumire-contracts"
import { Button } from "@react-spectrum/s2/Button"
import { Heading } from "@react-spectrum/s2/Heading"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import Add from "@react-spectrum/s2/icons/Add"
import AlertDiamond from "@react-spectrum/s2/icons/AlertDiamond"
import Calendar from "@react-spectrum/s2/icons/Calendar"
import ChevronDown from "@react-spectrum/s2/icons/ChevronDown"
import Refresh from "@react-spectrum/s2/icons/Refresh"
import { iconStyle, style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextArea, type TextFieldRef } from "@react-spectrum/s2/TextArea"
import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { errorMessage, LocalizedError, t } from "./i18n.js"
import { formatScheduleTime, localScheduleTime, parseScheduleTime } from "./schedule-time.js"
import { Disclosure, Panel, Prose, StatusLabel } from "./surfaces.js"

const workspaceStyles = style({
  font: "body",
  color: "body",
  "--schedule-muted": { type: "color", value: "neutral-subdued" },
  "--schedule-link": { type: "color", value: "accent-1000" },
  "--schedule-preview": { type: "backgroundColor", value: "accent-subtle" },
  "--schedule-notice": { type: "backgroundColor", value: "notice-subtle" },
  "--schedule-surface": { type: "backgroundColor", value: "layer-2" },
  "--schedule-divider": { type: "borderColor", value: "gray-300" },
  "--schedule-border": { type: "borderColor", value: "gray-500" },
  "--schedule-focus": { type: "outlineColor", value: "focus-ring" },
  "--schedule-radius": { type: "borderRadius", value: "default" },
})
const headingStyles = style({ font: "heading-sm", color: "title" })
const cardHeadingStyles = style({ font: "heading-xs", color: "title" })
const labelStyles = style({ font: "ui", color: "body" })
const successStyles = style({ color: "positive-1000" })
const errorStyles = style({ color: "negative-1000" })

// A native select preserves the combobox role, form validation, and OS picker.
function ScheduleSelect(props: ComponentProps<"select">) {
  return (
    <div className="schedule-select">
      <select {...props} className="schedule-input" />
      <ChevronDown />
    </div>
  )
}

// InlineAlert always has role="alert"; these notices are ordinary contextual help.
function ScheduleNotice({ children }: { children: ReactNode }) {
  return (
    <div className="schedule-notice">
      <AlertDiamond styles={iconStyle({ color: "notice" })} />
      <p>{children}</p>
    </div>
  )
}

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
  const pauseHelpId = useId()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [task, setTask] = useState("")
  const defaultChatId = String(allowedIds[0] ?? "")
  const [chatId, setChatId] = useState(() =>
    allowedIds.includes(Number(selectedChat)) ? selectedChat : defaultChatId,
  )
  if (chatId !== defaultChatId && !allowedIds.includes(Number(chatId))) {
    setChatId(defaultChatId)
  }
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
  const taskInput = useRef<TextFieldRef<HTMLTextAreaElement>>(null)
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
    <div className={`schedule-workspace ${workspaceStyles}`} aria-busy={busy}>
      <div className="schedule-toolbar">
        <Button
          variant="accent"
          isDisabled={
            busy ||
            editing ||
            !ready ||
            allowedIds.length === 0 ||
            (result !== undefined && result.items.length >= result.limit)
          }
          onPress={() => {
            setEditing(true)
            setNotice(false)
          }}
        >
          <Add />
          {t("schedule.add")}
        </Button>
        <Button
          variant="secondary"
          fillStyle="outline"
          isDisabled={busy}
          onPress={() => {
            setError("")
            setRefresh((value) => value + 1)
          }}
        >
          <Refresh />
          {t("schedule.refresh")}
        </Button>
        <span className="schedule-muted">
          {t("schedule.count", { count: result?.items.length ?? 0, limit: result?.limit ?? 100 })}
        </span>
      </div>
      {!ready && <ScheduleNotice>{t("schedule.policyPending")}</ScheduleNotice>}
      {ready && allowedIds.length === 0 && <p>{t("schedule.noChats")}</p>}
      {error && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Content>{errorMessage(error)}</Content>
        </InlineAlert>
      )}
      {notice && (
        <p className={successStyles} role="status">
          {t("schedule.saved")}
        </p>
      )}
      {editing && (
        <Panel className="schedule-editor" aria-labelledby="schedule-editor-title">
          <Heading level={2} styles={headingStyles} id="schedule-editor-title">
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
              <TextArea
                UNSAFE_className="schedule-task-field "
                ref={taskInput}
                id="schedule-task-input"
                label={t("schedule.task")}
                description={<span id="schedule-task-help">{t("schedule.taskHelp")}</span>}
                isRequired
                validationBehavior="native"
                isDisabled={busy}
                maxLength={8000}
                value={task}
                onChange={setTask}
                placeholder={t("schedule.taskPlaceholder")}
              />
              <div className="schedule-form-grid">
                <div className="schedule-field">
                  <label className={labelStyles} htmlFor="schedule-chat">
                    {t("schedule.chat")}
                  </label>
                  <ScheduleSelect
                    id="schedule-chat"
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
                  </ScheduleSelect>
                </div>
                <div className="schedule-field">
                  <label className={labelStyles} htmlFor="schedule-time">
                    {t("schedule.when")}
                  </label>
                  {/* Keep the wall-clock string used by the schedule serializer. */}
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
                  <label className={labelStyles} htmlFor="schedule-repeat">
                    {t("schedule.repeat")}
                  </label>
                  <ScheduleSelect
                    id="schedule-repeat"
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
                  </ScheduleSelect>
                </div>
              </div>
              <p id="schedule-time-help">{t("schedule.timeHelp", { zone: timeZone })}</p>
              {preview && chatId && (
                <p className="schedule-preview">
                  {t("schedule.preview", { time: preview, chat: name(Number(chatId)) })}
                </p>
              )}
              <p className="schedule-muted">{t("schedule.repeatHelp")}</p>
              <div className="schedule-actions">
                <Button
                  type="submit"
                  variant="accent"
                  isDisabled={
                    busy || !ready || !task.trim() || !allowedIds.includes(Number(chatId))
                  }
                >
                  {t("schedule.create")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    if (!task.trim() || window.confirm(t("schedule.discard"))) resetDraft()
                  }}
                >
                  {t("schedule.cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Panel>
      )}
      <div className="schedule-list-heading">
        <Heading level={2} styles={headingStyles}>
          {t("schedule.list")}
        </Heading>
        <div className="schedule-filter">
          <label className={labelStyles} htmlFor="schedule-filter">
            {t("schedule.filter")}
          </label>
          <ScheduleSelect
            id="schedule-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Schedule["state"] | "all")}
          >
            <option value="all">{t("schedule.all")}</option>
            <option value="active">{t("schedule.state.active")}</option>
            <option value="paused">{t("schedule.state.paused")}</option>
            <option value="completed">{t("schedule.state.completed")}</option>
          </ScheduleSelect>
        </div>
      </div>
      {!result ? (
        <span role="status">{t("schedule.loading")}</span>
      ) : items?.length === 0 ? (
        <Panel className="schedule-empty">
          <Calendar styles={iconStyle({ color: "accent" })} />
          <Heading level={3} styles={headingStyles}>
            {t(result.items.length ? "schedule.noMatches" : "schedule.empty")}
          </Heading>
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
              <div className="schedule-card-heading">
                <Heading level={3} styles={cardHeadingStyles} id={`schedule-${schedule.id}`}>
                  {t("schedule.entry", { id: schedule.id.slice(0, 8) })}
                </Heading>
                <StatusLabel tone={schedule.state === "active" ? "success" : "neutral"}>
                  {t(`schedule.state.${schedule.state}`)}
                </StatusLabel>
              </div>
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
                <ScheduleNotice>{t("schedule.interruptedHelp")}</ScheduleNotice>
              )}
              {schedule.lastOutcome === "failed" && (
                <p className={errorStyles}>{t("schedule.failedHelp")}</p>
              )}
              {schedule.state === "active" && schedule.lastOutcome === "running" && (
                <p id={`${pauseHelpId}-${schedule.id}`}>{t("schedule.pauseRunningHelp")}</p>
              )}
              <div className="schedule-actions schedule-card-actions">
                {schedule.state === "active" && (
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    aria-describedby={
                      schedule.lastOutcome === "running"
                        ? `${pauseHelpId}-${schedule.id}`
                        : undefined
                    }
                    onPress={() =>
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
                    variant="secondary"
                    isDisabled={
                      busy ||
                      !ready ||
                      schedule.lastOutcome === "running" ||
                      schedule.lastOutcome === "interrupted" ||
                      schedule.nextRunAt === null
                    }
                    onPress={() => {
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
                  variant="negative"
                  fillStyle="outline"
                  isDisabled={busy}
                  onPress={() => {
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
              </div>
            </Panel>
          ))}
        </div>
      )}
      <Disclosure title={t("schedule.executionDetails")}>
        <Prose size="2" color="gray">
          {t("schedule.executionHelp")}
        </Prose>
      </Disclosure>
    </div>
  )
}
