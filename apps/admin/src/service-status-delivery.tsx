import type {
  ServiceStatusDeliveryResponse,
  ServiceStatusDiagnostic,
  ServiceStatusTestResult,
  Snapshot,
} from "@narumitw/sumire-contracts"
import { AlertDialog, Badge, Button, Code, Flex, Text } from "@radix-ui/themes"
import { useContext, useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { statusProviderNames } from "./status-notifications.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

type Application = Pick<Snapshot, "revision" | "applied" | "status">
export const statusDiagnosticText: Record<ServiceStatusDiagnostic, string> = {
  source_unavailable: "The status source is unavailable. Refresh source health later.",
  delivery_failed: "Telegram did not accept the message. Check bot delivery permissions.",
  forbidden: "Telegram denied delivery. Check bot access and posting rights.",
  chat_unavailable:
    "The destination is unavailable. Check the chat ID and whether the recipient has started the bot.",
  timeout:
    "The attempt timed out. Acceptance is not confirmed; check recent results before another test.",
  queue_full: "The pending queue is full. Review pending counts and delivery failures.",
  cancelled: "The attempt was cancelled. It was not confirmed as delivered.",
  rate_limited:
    "The attempt was rate limited. Wait at least one minute before another test to this destination.",
}

export function statusTestBlockReason(
  application: Application,
  savedChatIds: number[],
  chatId: number | undefined,
) {
  if (chatId === undefined) return "Select a saved notification destination before testing."
  if (!savedChatIds.includes(chatId))
    return "This destination exists only in the draft. Review, save, and apply it before testing."
  if (application.status !== "applied" || application.revision !== application.applied)
    return "Saved settings must be applied before testing. Check application status."
  return ""
}
const timestamp = (value: number | null) =>
  value === null ? "Not recorded" : new Date(value).toLocaleString()
function ResultTimes({
  item,
}: {
  item: {
    lastAttemptAt: number | null
    lastSuccessAt: number | null
    lastFailureAt: number | null
    lastError: ServiceStatusDiagnostic | null
  }
}) {
  return (
    <>
      <dt>Last attempt</dt>
      <dd>{timestamp(item.lastAttemptAt)}</dd>
      <dt>Last success</dt>
      <dd>{timestamp(item.lastSuccessAt)}</dd>
      <dt>Last failure</dt>
      <dd>{timestamp(item.lastFailureAt)}</dd>
      <dt>Diagnostic</dt>
      <dd>{item.lastError ? statusDiagnosticText[item.lastError] : "None recorded"}</dd>
    </>
  )
}

export function StatusDelivery({
  csrf,
  application,
  savedChatIds,
  draftChatIds,
  disabled,
  onSessionExpired,
}: {
  csrf: string
  application: Application
  savedChatIds: number[]
  draftChatIds: number[]
  disabled: boolean
  onSessionExpired(): void
}) {
  const active = useContext(SectionActive)
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<ServiceStatusDeliveryResponse>()
  const [loading, setLoading] = useState(false)
  const [readError, setReadError] = useState("")
  const [selected, setSelected] = useState<number>()
  const [confirmation, setConfirmation] = useState<{ chatId: number; revision: number }>()
  const [sending, setSending] = useState(false)
  const sendLock = useRef(false)
  const testTrigger = useRef<HTMLButtonElement>(null)
  const [conflictRevision, setConflictRevision] = useState<number>()
  const [testError, setTestError] = useState("")
  const [result, setResult] = useState<ServiceStatusTestResult>()
  const callback = useRef(onSessionExpired)
  callback.current = onSessionExpired
  const sendController = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => sendController.current?.abort(), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and refresh reload results without sending.
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    setReadError("")
    void request<ServiceStatusDeliveryResponse>(
      `service-status/deliveries?offset=${offset}&limit=100`,
      undefined,
      undefined,
      "GET",
      controller.signal,
    )
      .then(
        (response) => {
          if (!controller.signal.aborted) setData(response)
        },
        (failure) => {
          if (controller.signal.aborted) return
          if (failure instanceof ApiError && failure.status === 401) callback.current()
          else
            setReadError(
              "Could not load recent results. Refresh to try again. Reading results never sends a message.",
            )
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [active, application.revision, offset, refresh])
  const ids = [...new Set([...savedChatIds, ...draftChatIds])]
  const chatId = selected !== undefined && ids.includes(selected) ? selected : ids[0]
  const blocked = statusTestBlockReason(application, savedChatIds, chatId)
  const conflict = conflictRevision === application.revision
  const send = async () => {
    const target = confirmation
    if (!target || disabled || sendLock.current) return
    setConfirmation(undefined)
    if (
      statusTestBlockReason(application, savedChatIds, target.chatId) ||
      application.revision !== target.revision ||
      conflict
    ) {
      setTestError(
        "Saved settings changed. Reload and review settings before confirming another test. No test was sent.",
      )
      return
    }
    sendLock.current = true
    setSending(true)
    setTestError("")
    setResult(undefined)
    const controller = new AbortController()
    sendController.current = controller
    try {
      const response = await request<ServiceStatusTestResult>(
        "service-status/test",
        csrf,
        { chatId: target.chatId, revision: target.revision, confirm: true },
        "POST",
        controller.signal,
      )
      if (controller.signal.aborted) return
      setResult(response)
      setRefresh((value) => value + 1)
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof ApiError && failure.status === 401) callback.current()
      else if (failure instanceof ApiError && failure.status === 409) {
        setConflictRevision(application.revision)
        setTestError(
          "Saved settings changed. Reload and review settings before another test. The test was not retried and your draft was not saved.",
        )
      } else
        setTestError(
          "Could not confirm the test result. Check recent results before another explicit test. No automatic retry was made.",
        )
    } finally {
      sendLock.current = false
      if (!controller.signal.aborted) setSending(false)
    }
  }
  return (
    <>
      <SettingsSection
        title="Manual test"
        description="Send one fixed test message using saved, applied settings only."
      >
        <Panel className="status-test-panel">
          <Prose size="2">
            Tests use saved settings, not the browser draft. Automatic notifications may be off.
            This explicit manual test bypasses quiet hours and grouping. It does not grant Pi access
            or change incident checkpoints or pending notices.
          </Prose>
          <label className="form-field" htmlFor="status-test-destination">
            Test destination
            <Select.Root
              value={chatId === undefined ? "none" : String(chatId)}
              disabled={sending || !ids.length}
              onValueChange={(value) => setSelected(Number(value))}
            >
              <Select.Trigger id="status-test-destination" aria-label="Test destination" />
              <Select.Content>
                {!ids.length && <Select.Item value="none">No saved destinations</Select.Item>}
                {ids.map((id) => (
                  <Select.Item key={id} value={String(id)}>
                    {id} · {savedChatIds.includes(id) ? "Saved" : "Draft only"}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </label>
          {blocked && (
            <Prose size="2" id="status-test-blocked">
              {blocked}
            </Prose>
          )}
          {conflict && (
            <Prose size="2">
              Reload saved settings before another test. No automatic retry will occur.
            </Prose>
          )}
          <Button
            ref={testTrigger}
            disabled={disabled || sending || Boolean(blocked) || conflict}
            aria-describedby="status-test-blocked"
            onClick={() => {
              if (chatId !== undefined && !blocked)
                setConfirmation({ chatId, revision: application.revision })
            }}
          >
            {sending ? "Sending test…" : "Send test notification"}
          </Button>
          {testError && (
            <Prose role="alert" color="red">
              {testError}
            </Prose>
          )}
          {result && (
            <Prose role="status">
              Test for <Code>{result.chatId}</Code> at {timestamp(result.attemptedAt)}:{" "}
              {result.success
                ? "Telegram accepted the test message. This does not show that a recipient read it."
                : result.code
                  ? statusDiagnosticText[result.code]
                  : "Delivery was not confirmed."}
            </Prose>
          )}
        </Panel>
      </SettingsSection>
      <AlertDialog.Root
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined)
        }}
      >
        <AlertDialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            testTrigger.current?.focus()
          }}
        >
          <AlertDialog.Title>Send a service status test?</AlertDialog.Title>
          <AlertDialog.Description>
            Send one fixed test message to Telegram chat {confirmation?.chatId} using saved revision{" "}
            {confirmation?.revision}. This manual action bypasses automatic enablement, quiet hours,
            and grouping. No browser draft will be saved. Telegram acceptance does not prove that a
            recipient read the message. Tests are limited to one attempt per destination per minute.
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end" wrap="wrap">
            <AlertDialog.Cancel>
              <Button variant="soft">Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              disabled={
                disabled ||
                sending ||
                Boolean(blocked) ||
                conflict ||
                confirmation?.revision !== application.revision
              }
              onClick={() => void send()}
            >
              Confirm test notification
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <SettingsSection
        title="Recent delivery results"
        description="Read-only delivery and source-fetch health. Refresh never resends a message."
      >
        <Panel id="status-delivery-results" tabIndex={-1}>
          <Flex gap="3" align="center" wrap="wrap">
            <Button
              variant="soft"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh delivery results
            </Button>
            {loading && <Text role="status">Loading recent results…</Text>}
          </Flex>
          {readError && (
            <Prose color="red" role="alert">
              {readError}
            </Prose>
          )}
          {data && (
            <>
              <Prose size="2">
                Results as of {timestamp(data.serverTime)} · Next source poll:{" "}
                {timestamp(data.nextPollAt)}.
              </Prose>
              <section aria-label="Source fetch health" className="status-result-grid">
                {(data.sources ?? []).map((source) => (
                  <Panel key={source.provider}>
                    <Text as="p" weight="medium">
                      {statusProviderNames[source.provider]} source fetch
                    </Text>
                    <dl className="status-result-values">
                      <ResultTimes item={source} />
                    </dl>
                  </Panel>
                ))}
                {!data.sources?.length && <Prose size="2">No source fetch results recorded.</Prose>}
              </section>
              <section aria-label="Destination delivery results" className="status-result-grid">
                {(data.items ?? []).map((item) => (
                  <Panel key={`${item.chatId}:${item.provider}`}>
                    <Text as="p" weight="medium">
                      <Code>{item.chatId}</Code> ·{" "}
                      {item.provider === "test"
                        ? "Manual test"
                        : statusProviderNames[item.provider]}
                    </Text>
                    {item.lastError && <Badge color="orange">Delivery needs attention</Badge>}
                    <dl className="status-result-values">
                      <ResultTimes item={item} />
                      <dt>Pending notices</dt>
                      <dd>{item.pendingCount}</dd>
                      <dt>Next due</dt>
                      <dd>{timestamp(item.nextDueAt)}</dd>
                    </dl>
                  </Panel>
                ))}
                {!data.items?.length && (
                  <Prose size="2">No destination delivery results recorded.</Prose>
                )}
              </section>
              <Flex gap="3" align="center" wrap="wrap">
                <Button
                  variant="soft"
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  Previous delivery results
                </Button>
                <Text size="2">
                  {data.total
                    ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} of ${data.total}`
                    : "0 results"}
                </Text>
                <Button
                  variant="soft"
                  disabled={loading || data.offset + data.limit >= data.total}
                  onClick={() => setOffset(offset + 100)}
                >
                  Next delivery results
                </Button>
              </Flex>
            </>
          )}
          <Prose size="2">
            Last attempt, last success, and last failure are separate records. A past success is not
            proof of current permission. Success means Telegram accepted a message, not that a
            recipient read it.
          </Prose>
        </Panel>
      </SettingsSection>
    </>
  )
}
