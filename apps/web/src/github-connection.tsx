import type {
  GitHubConnection as Connection,
  GitHubApplicationState,
  GitHubFlow,
} from "@narumitw/sumire-contracts"
import { AlertDialog } from "@react-spectrum/s2/AlertDialog"
import { Button } from "@react-spectrum/s2/Button"
import { CustomDialog, DialogTrigger, Heading } from "@react-spectrum/s2/CustomDialog"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { type MutableRefObject, useEffect, useId, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { Check } from "./check.js"
import {
  activeGitHubFlow,
  githubApplicationStatusLabel,
  parseGitHubApplication,
  parseGitHubConnection,
  parseGitHubFlow,
} from "./github-state.js"
import { getLocale, type MessageKey, t } from "./i18n.js"
import { parseRuntimeConfig } from "./runtime-config-state.js"
import { Panel, Prose } from "./surfaces.js"
import "./spectrum-runtime.css"

const connectionWarning = style({
  backgroundColor: "notice-subtle",
  color: "notice-1000",
  borderRadius: "default",
  padding: 12,
})
const heading = style({ font: "heading-sm", color: "title", margin: 0 })
const field = style({ width: "full" })

type Props = {
  csrf: string
  blocked: boolean
  revision: number
  application?: GitHubApplicationState
  guard: MutableRefObject<(() => boolean) | undefined>
  onPending(value: boolean): void
  onCommitted(value: GitHubApplicationState): void
  onSessionExpired(): void
  refresh(): Promise<void>
}

function awaitingApplication(flow?: GitHubFlow) {
  return flow?.receipt?.application.status === "pending"
}

/** Navigation cleanup uses only local authenticated routes, never a new authorization. */
async function abandonGitHub(csrf: string, id?: string) {
  const signal = AbortSignal.timeout(10000)
  try {
    if (!id) {
      const local = parseGitHubConnection(
        await request("github/connection", undefined, undefined, "GET", signal),
      )
      if (activeGitHubFlow(local.flow)) id = local.flow?.id
    }
    if (id) await request(`github/oauth/${id}/cancel`, csrf, {}, "POST", signal)
  } catch {
    // Logout also cancels server-owned work. An old section must not restore browser state.
  }
}

export function GitHubConnection({
  csrf,
  blocked,
  revision,
  application,
  guard,
  onPending,
  onCommitted,
  onSessionExpired,
  refresh,
}: Props) {
  const [connection, setConnection] = useState<Connection>()
  const [flow, setFlow] = useState<GitHubFlow>()
  const [open, setOpen] = useState(false)
  const [scopeConsent, setScopeConsent] = useState(false)
  const [replaceConsent, setReplaceConsent] = useState(false)
  const [clientDraft, setClientDraft] = useState<string>()
  const [disconnecting, setDisconnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<MessageKey | "">("")
  const [notice, setNotice] = useState<MessageKey | "">("")
  const authorizationDescription = useId()
  const disconnectDescription = useId()
  const alert = useRef<HTMLDivElement>(null)
  const flowPanel = useRef<HTMLElement>(null)
  const focusFlow = useRef(false)
  const generation = useRef(0)
  const controller = useRef<AbortController>(undefined)
  const polling = useRef<AbortController>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const owner = useRef<{ id?: string; unresolved: boolean }>({ unresolved: false })
  const cancelled = useRef(false)
  const completionAttempted = useRef(false)
  const reportedRevision = useRef(revision)
  reportedRevision.current = Math.max(reportedRevision.current, revision)
  const receiptSeen = useRef<string>(undefined)
  const knownRevision = useRef(revision)
  const currentFlow = useRef(flow)
  currentFlow.current = flow
  const pending =
    busy || recovery || open || disconnecting || clientDraft !== undefined || activeGitHubFlow(flow)
  const latest = useRef({ pending, onCommitted, refresh, onSessionExpired })
  latest.current = { pending, onCommitted, refresh, onSessionExpired }
  const operations = useRef({
    load: async () => {},
    cancel: async () => {},
    poll: async (_version: number, _id: string, _signal: AbortSignal) => {},
    abandon: () => {},
  })
  const stopPolling = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    polling.current?.abort()
    polling.current = undefined
  }
  const invalidate = () => {
    generation.current++
    controller.current?.abort()
    stopPolling()
    return generation.current
  }
  const valid = (version: number, signal: AbortSignal) =>
    version === generation.current && !signal.aborted
  const begin = () => {
    const version = invalidate()
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError("")
    return { version, signal: abort.signal }
  }
  const report = (value: GitHubApplicationState) => {
    if (value.revision < reportedRevision.current) return
    reportedRevision.current = value.revision
    latest.current.onCommitted(value)
  }
  const receiveFlow = (next?: GitHubFlow) => {
    // After cancellation, a failed transport must not bring a temporary code back.
    if (cancelled.current && activeGitHubFlow(next) && next)
      next = { id: next.id, status: next.status, expiresAt: next.expiresAt }
    currentFlow.current = next
    setFlow(next)
    owner.current = { id: next?.id, unresolved: activeGitHubFlow(next) }
    if (next?.status === "completed" || next?.status === "cancelled") setOpen(false)
  }
  const readLocal = async (version: number, signal: AbortSignal) => {
    const next = parseGitHubConnection(
      await request("github/connection", undefined, undefined, "GET", signal),
    )
    if (!valid(version, signal)) return
    // This read already covers the revision reported to the parent.
    knownRevision.current = Math.max(knownRevision.current, next.revision)
    setConnection({ ...next, flow: undefined })
    setUnavailable(false)
    report(next)
    const previous = currentFlow.current
    const owned = owner.current.id
    if (!owned || next.flow?.id === owned) receiveFlow(next.flow)
    else if (!activeGitHubFlow(previous) && previous?.receipt) receiveFlow(previous)
    else {
      receiveFlow(undefined)
      setNotice("github.previousUnknown")
    }
    return next
  }
  const refreshRelated = async (version: number, signal: AbortSignal) => {
    await latest.current.refresh()
    if (!valid(version, signal)) return
    await readLocal(version, signal)
  }
  const showReceipt = async (
    next: GitHubFlow | undefined,
    version: number,
    signal: AbortSignal,
  ) => {
    if (!next?.receipt || !valid(version, signal)) return
    const key = `${next.id}:${next.receipt.savedRevision}:${next.receipt.application.status}:${next.receipt.application.applied}`
    if (receiptSeen.current === key) return
    receiptSeen.current = key
    await refreshRelated(version, signal)
  }
  const failed = async (failure: unknown, version: number, signal: AbortSignal) => {
    if (!valid(version, signal)) return
    if (failure instanceof ApiError && failure.status === 401) {
      latest.current.onSessionExpired()
      return
    }
    setRecovery(true)
    // A lost reply is not proof of failure. Recover the owner-bound receipt, not a new save.
    const previous = currentFlow.current
    if (previous && activeGitHubFlow(previous))
      receiveFlow({ id: previous.id, status: previous.status, expiresAt: previous.expiresAt })
    try {
      const local = await readLocal(version, signal)
      if (!local || !valid(version, signal)) return
      const active = activeGitHubFlow(currentFlow.current)
      setRecovery((cancelled.current || completionAttempted.current) && active)
      setError(
        cancelled.current && active
          ? "github.cancelUnconfirmed"
          : completionAttempted.current && active
            ? "github.saveUnconfirmed"
            : "github.responseRecovered",
      )
      await showReceipt(currentFlow.current, version, signal)
      if (!currentFlow.current?.receipt) await refreshRelated(version, signal)
    } catch (recoveryFailure) {
      if (!valid(version, signal)) return
      if (recoveryFailure instanceof ApiError && recoveryFailure.status === 401)
        latest.current.onSessionExpired()
      else setError("github.outcomeUnknownAction")
    }
  }
  const load = async () => {
    const { version, signal } = begin()
    try {
      const local = await readLocal(version, signal)
      if (!local || !valid(version, signal)) return
      setRecovery(
        (cancelled.current || completionAttempted.current) && activeGitHubFlow(currentFlow.current),
      )
      await showReceipt(currentFlow.current, version, signal)
    } catch (failure) {
      if (!valid(version, signal)) return
      if (failure instanceof ApiError && failure.status === 401) latest.current.onSessionExpired()
      else {
        if (!owner.current.unresolved) setConnection(undefined)
        setUnavailable(!owner.current.unresolved)
        setError(owner.current.unresolved ? "github.outcomeUnknown" : "github.unavailable")
        setRecovery(owner.current.unresolved)
      }
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const start = async () => {
    if (
      !connection ||
      disabled ||
      owner.current.unresolved ||
      !scopeConsent ||
      (replacing && !replaceConsent)
    )
      return
    const { version, signal } = begin()
    cancelled.current = false
    completionAttempted.current = false
    owner.current = { unresolved: true }
    focusFlow.current = true
    setOpen(false)
    setNotice("")
    try {
      const next = parseGitHubFlow(
        await request(
          "github/oauth",
          csrf,
          { revision: connection.revision, replace: replacing && replaceConsent },
          "POST",
          signal,
        ),
      )
      if (!valid(version, signal)) return
      receiveFlow(next)
      await showReceipt(next, version, signal)
    } catch (failure) {
      await failed(failure, version, signal)
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const complete = async () => {
    if (flow?.status !== "authorized" || disabled || completionAttempted.current) return
    completionAttempted.current = true
    const id = flow.id
    const { version, signal } = begin()
    try {
      const next = parseGitHubFlow(
        await request(`github/oauth/${id}/complete`, csrf, {}, "POST", signal),
      )
      if (!valid(version, signal)) return
      if (next.id !== id) throw new Error(t("github.unexpectedInteraction"))
      receiveFlow(next)
      await showReceipt(next, version, signal)
    } catch (failure) {
      await failed(failure, version, signal)
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const cancel = async () => {
    const owned = owner.current
    const { version, signal } = begin()
    cancelled.current = true
    setOpen(false)
    setScopeConsent(false)
    setReplaceConsent(false)
    setFlow(undefined)
    currentFlow.current = undefined
    if (!owned.unresolved) {
      owner.current = { unresolved: false }
      setBusy(false)
      return
    }
    try {
      let id = owned.id
      if (!id) {
        const local = await readLocal(version, signal)
        if (!valid(version, signal)) return
        if (local?.flow?.receipt) {
          await showReceipt(local.flow, version, signal)
          return
        }
        if (activeGitHubFlow(local?.flow)) id = local?.flow?.id
      }
      if (id) {
        const next = parseGitHubFlow(
          await request(`github/oauth/${id}/cancel`, csrf, {}, "POST", signal),
        )
        if (!valid(version, signal)) return
        if (next.id !== id) throw new Error(t("github.unexpectedInteraction"))
        receiveFlow(next)
        setRecovery(activeGitHubFlow(next))
        await showReceipt(next, version, signal)
      } else {
        owner.current = { unresolved: false }
        setRecovery(false)
        setNotice("github.noActive")
      }
    } catch (failure) {
      await failed(failure, version, signal)
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const abandon = () => {
    const owned = owner.current
    invalidate()
    owner.current = { unresolved: false }
    currentFlow.current = undefined
    if (owned.unresolved) void abandonGitHub(csrf, owned.id)
  }
  guard.current = () => {
    if (latest.current.pending && !window.confirm(t("github.leaveConfirm"))) return false
    abandon()
    setFlow(undefined)
    setOpen(false)
    setDisconnecting(false)
    setClientDraft(undefined)
    setRecovery(false)
    setBusy(false)
    return true
  }
  operations.current = {
    load,
    cancel,
    abandon,
    poll: async (version, id, signal) => {
      try {
        const next = parseGitHubFlow(
          await request(`github/oauth/${id}`, undefined, undefined, "GET", signal),
        )
        if (!valid(version, signal) || owner.current.id !== id) return
        if (next.id !== id) throw new Error(t("github.unexpectedInteraction"))
        receiveFlow(next)
        await showReceipt(next, version, signal)
      } catch (failure) {
        if (!valid(version, signal)) return
        // Poll cleanup must not abort the local request that recovers a lost status response.
        const recoveryRequest = begin()
        try {
          await failed(failure, recoveryRequest.version, recoveryRequest.signal)
        } finally {
          if (valid(recoveryRequest.version, recoveryRequest.signal)) setBusy(false)
        }
      }
      if (
        valid(version, signal) &&
        ((currentFlow.current?.status === "pending" && !cancelled.current) ||
          awaitingApplication(currentFlow.current))
      )
        timer.current = setTimeout(() => void operations.current.poll(version, id, signal), 1500)
    },
  }
  useEffect(() => onPending(pending), [onPending, pending])
  useEffect(() => {
    document.getElementById("github-connection-heading")?.focus()
    void operations.current.load()
    return () => {
      operations.current.abandon()
      guard.current = undefined
      onPending(false)
    }
  }, [guard, onPending])
  useEffect(() => {
    if (knownRevision.current === revision || busy) return
    knownRevision.current = revision
    void operations.current.load()
  }, [revision, busy])
  const flowId = flow?.id
  const flowStatus = flow?.status
  const applicationPending = awaitingApplication(flow)
  useEffect(() => {
    if (busy || recovery || (flowStatus !== "pending" && !applicationPending) || !flowId) return
    const abort = new AbortController()
    polling.current = abort
    const version = generation.current
    timer.current = setTimeout(
      () => void operations.current.poll(version, flowId, abort.signal),
      1500,
    )
    return () => {
      clearTimeout(timer.current)
      abort.abort()
    }
  }, [flowId, flowStatus, busy, recovery, applicationPending])
  useEffect(() => {
    if (error && !unavailable && !open && !disconnecting) alert.current?.focus()
    else if (focusFlow.current && flowStatus) {
      focusFlow.current = false
      flowPanel.current?.focus()
    }
  }, [error, unavailable, open, disconnecting, flowStatus])
  useEffect(() => {
    if (!pending) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || !owner.current.unresolved) return
      event.preventDefault()
      void operations.current.cancel()
    }
    document.addEventListener("keydown", onEscape)
    return () => document.removeEventListener("keydown", onEscape)
  }, [pending])

  let current: GitHubApplicationState | undefined = connection
  if (application) {
    try {
      const state = parseGitHubApplication(application)
      if (!current || state.revision >= current.revision) current = state
    } catch {
      // Keep verified local metadata when shared application state is not verified.
    }
  }
  const stale = !connection || connection.revision !== revision
  const replacing = connection?.mode === "manual" || connection?.mode === "oauth"
  const disabled = busy || blocked || recovery || stale
  const ready = current?.status === "applied" && current.applied === current.revision
  const canConnect =
    !disabled &&
    ready &&
    connection?.secretStatus === "ready" &&
    Boolean(connection.clientId) &&
    connection.mode !== "invalid" &&
    clientDraft === undefined
  const saveClientId = async () => {
    if (clientDraft === undefined || disabled || !/^[a-zA-Z0-9_.-]{1,128}$/.test(clientDraft))
      return
    const { version, signal } = begin()
    try {
      const next = parseRuntimeConfig(
        await request(
          "runtime-config/GITHUB_OAUTH_CLIENT_ID",
          csrf,
          { revision, kind: "variable", value: clientDraft },
          "PUT",
          signal,
        ),
      )
      if (!valid(version, signal)) return
      if (next.revision <= revision) throw new Error(t("github.unverifiedClientSave"))
      setClientDraft(undefined)
      report(next)
      setNotice(next.status === "failed" ? "github.clientSavedFailed" : "github.clientSaved")
      await refreshRelated(version, signal)
    } catch (failure) {
      if (!valid(version, signal)) return
      // The public draft is cleared after an uncertain write, just as after a committed write.
      setClientDraft(undefined)
      await failed(failure, version, signal)
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const disconnect = async () => {
    if (!connection || disabled || connection.secretStatus !== "ready") return
    const { version, signal } = begin()
    setDisconnecting(false)
    try {
      const next = parseGitHubConnection(
        await request(
          "github/connection/disconnect",
          csrf,
          { revision: connection.revision, confirm: true },
          "POST",
          signal,
        ),
      )
      if (!valid(version, signal)) return
      if (next.revision <= connection.revision) throw new Error(t("github.unverifiedDisconnect"))
      setConnection(next)
      receiveFlow(next.flow)
      report(next)
      setNotice(next.status === "failed" ? "github.disconnectedFailed" : "github.disconnected")
      await refreshRelated(version, signal)
    } catch (failure) {
      await failed(failure, version, signal)
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const authorizationActive = activeGitHubFlow(flow) || owner.current.unresolved
  const terminalMessage =
    flow?.status === "conflict"
      ? t("github.conflict")
      : flow?.status === "expired"
        ? t("github.expired")
        : flow?.status === "failed"
          ? t("github.failed")
          : flow?.status === "cancelled"
            ? t("github.cancelled")
            : ""

  return (
    <Panel aria-label={t("github.connection")} aria-busy={busy}>
      <h2 className={heading} id="github-connection-heading" tabIndex={-1}>
        {t("github.connect")}
      </h2>
      <Prose size="2">{t("github.setupHelp")}</Prose>
      <Prose size="2">{t("github.scopeHelp")}</Prose>
      {connection && (
        <Prose size="2">
          {connection.mode === "none"
            ? t("github.noCredential")
            : connection.mode === "manual"
              ? t("github.manualCredential")
              : connection.mode === "invalid"
                ? t("github.invalidManaged")
                : t("github.accountScopes", {
                    login: connection.account?.login ?? t("settings.unknown"),
                    scopes: connection.scopes?.join(", ") || t("settings.none"),
                  })}
          {connection.reconnectRequired && t("github.reconnectRequired")}
        </Prose>
      )}
      {flow?.receipt && (
        <div role="status" aria-label={t("github.savedOutcome")}>
          <Prose weight="medium">
            {flow.receipt.application.status === "failed"
              ? t("github.savedFailed")
              : flow.receipt.application.status === "unknown"
                ? t("github.savedUnknown")
                : flow.receipt.application.status === "applied" &&
                    flow.receipt.application.applied === flow.receipt.savedRevision
                  ? t("github.savedApplied")
                  : t("github.savedPending")}
          </Prose>
          <Prose size="2">
            {t("github.receipt", {
              saved: flow.receipt.savedRevision,
              revision: flow.receipt.application.revision,
              applied: flow.receipt.application.applied,
              status: githubApplicationStatusLabel(flow.receipt.application.status),
            })}
          </Prose>
          <Prose size="2">{t("github.noResave")}</Prose>
        </div>
      )}
      {current && (
        <Prose size="2" aria-label={t("github.currentApplication")}>
          {t("github.currentRevision", {
            revision: current.revision,
            applied: current.applied,
            status: githubApplicationStatusLabel(current.status),
          })}
        </Prose>
      )}
      {terminalMessage && <Prose role="status">{terminalMessage}</Prose>}
      {notice && <Prose role="status">{t(notice)}</Prose>}
      {error && !open && (
        <div
          ref={alert}
          tabIndex={-1}
          role={unavailable ? "status" : "alert"}
          className={`runtime-notice ${connectionWarning}`}
        >
          {t(error)}
        </div>
      )}
      {busy && owner.current.unresolved && !flow && (
        <Prose role="status">{t("github.starting")}</Prose>
      )}
      {activeGitHubFlow(flow) && (
        <section ref={flowPanel} tabIndex={-1} aria-label={t("github.authorization")}>
          {flow?.status === "pending" && (
            <div className="github-flow-actions">
              <Prose role="status">{t("github.waiting")}</Prose>
              {flow.userCode && (
                <Prose>
                  {t("github.userCode")} <code>{flow.userCode}</code>
                </Prose>
              )}
              {flow.verificationUri && (
                <div>
                  <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer">
                    {t("github.openDevice")}
                  </a>
                </div>
              )}
              <Prose size="2">
                {t("github.expires", {
                  date: new Date(flow.expiresAt).toLocaleString(getLocale()),
                })}
              </Prose>
            </div>
          )}
          {flow?.status === "authorized" && flow.account && (
            <div className="github-flow-actions">
              <Prose weight="medium">
                {t("github.verifiedAccount", { login: flow.account.login, id: flow.account.id })}
              </Prose>
              <Prose>
                {t("github.actualScopes", {
                  scopes: flow.scopes?.join(", ") || t("settings.none"),
                })}
              </Prose>
              <Prose size="2">{t("github.saveAccountHelp")}</Prose>
              <Button
                variant="accent"
                isDisabled={disabled || !flow.scopes || completionAttempted.current}
                onPress={() => void complete()}
              >
                {t("github.saveAccount")}
              </Button>
            </div>
          )}
          <Prose size="2">{t("github.cancelHelp")}</Prose>
        </section>
      )}
      {connection && !connection.clientId && (
        <Prose size="2">{t("github.configureClientHelp")}</Prose>
      )}
      <div className="runtime-actions runtime-actions--spaced">
        {authorizationActive && !open ? (
          <Button variant="secondary" onPress={() => void cancel()}>
            {t("github.cancelAuthorization")}
          </Button>
        ) : (
          <DialogTrigger
            isOpen={open}
            onOpenChange={(value) => {
              if (value) {
                setScopeConsent(false)
                setReplaceConsent(false)
                setError("")
                setOpen(true)
              } else void cancel()
            }}
          >
            <Button variant="accent" isDisabled={!canConnect}>
              {connection?.mode === "oauth" ? t("github.reconnect") : t("github.connect")}
            </Button>
            <CustomDialog size="M" aria-describedby={authorizationDescription}>
              {({ close }) => (
                <>
                  <Heading slot="title" styles={heading}>
                    {t(activeGitHubFlow(flow) ? "github.authorization" : "github.connectAccount")}
                  </Heading>
                  <Prose size="2" id={authorizationDescription}>
                    {t("github.authorizeHelp")}
                  </Prose>
                  {error && (
                    <p role="alert" className={style({ color: "negative-1000" })}>
                      {t(error)}
                    </p>
                  )}
                  {!authorizationActive && (
                    <div className="github-flow-actions">
                      <Check
                        checked={scopeConsent}
                        onChange={setScopeConsent}
                        autoFocus
                        label={t("github.scopeConsent")}
                      />
                      {replacing && (
                        <Check
                          checked={replaceConsent}
                          onChange={setReplaceConsent}
                          label={t("github.replaceConsent")}
                        />
                      )}
                      <Button
                        variant="accent"
                        isDisabled={!canConnect || !scopeConsent || (replacing && !replaceConsent)}
                        onPress={() => void start()}
                      >
                        {t("github.start")}
                      </Button>
                    </div>
                  )}
                  {terminalMessage && <Prose role="status">{terminalMessage}</Prose>}
                  <div className="github-dialog-footer">
                    <Button variant="secondary" onPress={close}>
                      {t(authorizationActive ? "github.cancelAuthorization" : "settings.close")}
                    </Button>
                  </div>
                </>
              )}
            </CustomDialog>
          </DialogTrigger>
        )}
        <Button
          variant="secondary"
          isDisabled={busy || blocked || clientDraft !== undefined}
          onPress={() => void load()}
        >
          {t("github.reload")}
        </Button>
        {connection && !activeGitHubFlow(flow) && !recovery && (
          <>
            <Button
              variant="secondary"
              isDisabled={disabled || clientDraft !== undefined}
              onPress={() => setClientDraft(connection.clientId ?? "")}
            >
              {connection.clientId ? t("github.editClient") : t("github.configureClient")}
            </Button>
            {connection.mode !== "none" && (
              <DialogTrigger isOpen={disconnecting} onOpenChange={setDisconnecting}>
                <Button
                  variant="negative"
                  fillStyle="outline"
                  isDisabled={
                    disabled || clientDraft !== undefined || connection.secretStatus !== "ready"
                  }
                >
                  {connection.mode === "invalid" ? t("github.reset") : t("github.disconnect")}
                </Button>
                <AlertDialog
                  variant="destructive"
                  title={t(
                    connection.mode === "invalid"
                      ? "github.resetConfirm"
                      : "github.disconnectConfirm",
                  )}
                  aria-describedby={disconnectDescription}
                  cancelLabel={t("github.keepConnection")}
                  primaryActionLabel={t("github.deleteBoth")}
                  autoFocusButton="cancel"
                  isPrimaryActionDisabled={disabled || connection.secretStatus !== "ready"}
                  onPrimaryAction={() => void disconnect()}
                >
                  <p id={disconnectDescription}>{t("github.deleteHelp")}</p>
                </AlertDialog>
              </DialogTrigger>
            )}
          </>
        )}
      </div>
      {clientDraft !== undefined && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void saveClientId()
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault()
              setClientDraft(undefined)
            }
          }}
        >
          <TextField
            id="github-client-id"
            label={t("github.publicClient")}
            value={clientDraft}
            autoComplete="off"
            autoFocus
            isDisabled={busy}
            maxLength={128}
            onChange={setClientDraft}
            styles={field}
          />
          <Prose size="2">{t("github.publicClientHelp")}</Prose>
          <div className="runtime-actions runtime-actions--spaced">
            <Button
              type="submit"
              variant="accent"
              isDisabled={disabled || !/^[a-zA-Z0-9_.-]{1,128}$/.test(clientDraft)}
            >
              {t("github.saveClient")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              isDisabled={busy}
              onPress={() => setClientDraft(undefined)}
            >
              {t("github.discardClient")}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}
