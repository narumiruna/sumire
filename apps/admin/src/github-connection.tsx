import type {
  GitHubConnection as Connection,
  GitHubApplicationState,
  GitHubFlow,
} from "@narumitw/sumire-contracts"
import {
  AlertDialog,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Flex,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type MutableRefObject, useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import {
  activeGitHubFlow,
  parseGitHubApplication,
  parseGitHubConnection,
  parseGitHubFlow,
} from "./github-state.js"
import { parseRuntimeConfig } from "./runtime-config-state.js"
import { Panel, Prose } from "./surfaces.js"

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
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
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
      setNotice(
        "The previous authorization outcome is unknown. Current local metadata is shown. No authorization or save was repeated.",
      )
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
          ? "Cancellation could not be confirmed. The code is cleared. Check GitHub status or cancel again; no save will occur automatically."
          : completionAttempted.current && active
            ? "The save outcome is not confirmed. Reload GitHub status to recover its receipt. Do not save this authorization again."
            : "The response was lost or could not be verified. Local GitHub status was recovered. No authorization or save was repeated.",
      )
      await showReceipt(currentFlow.current, version, signal)
      if (!currentFlow.current?.receipt) await refreshRelated(version, signal)
    } catch (recoveryFailure) {
      if (!valid(version, signal)) return
      if (recoveryFailure instanceof ApiError && recoveryFailure.status === 401)
        latest.current.onSessionExpired()
      else
        setError(
          "GitHub outcome is unknown. Reload GitHub status before another action. No authorization or save will be repeated automatically.",
        )
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
        setError(
          owner.current.unresolved
            ? "GitHub outcome is unknown. Reload GitHub status. No authorization or save will be repeated automatically."
            : "GitHub connection is unavailable. Manual GH_TOKEN controls remain available.",
        )
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
      if (next.id !== id) throw new Error("Unexpected GitHub interaction")
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
        if (next.id !== id) throw new Error("Unexpected GitHub interaction")
        receiveFlow(next)
        setRecovery(activeGitHubFlow(next))
        await showReceipt(next, version, signal)
      } else {
        owner.current = { unresolved: false }
        setRecovery(false)
        setNotice("No active GitHub authorization was found. No save was repeated.")
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
    if (
      latest.current.pending &&
      !window.confirm("Cancel GitHub authorization and discard the Client ID draft before leaving?")
    )
      return false
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
        if (next.id !== id) throw new Error("Unexpected GitHub interaction")
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
      if (event.key !== "Escape" || !owner.current.unresolved) return
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
      if (next.revision <= revision) throw new Error("Unverified Client ID save")
      setClientDraft(undefined)
      report(next)
      setNotice(
        next.status === "failed"
          ? "Client ID saved; application failed. Use Retry application above. Do not save it again."
          : "Client ID saved. Check application status above before connecting.",
      )
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
      if (next.revision <= connection.revision) throw new Error("Unverified disconnect")
      setConnection(next)
      receiveFlow(next.flow)
      report(next)
      setNotice(
        next.status === "failed"
          ? "Disconnected locally; application failed. Use Retry application above. Do not repeat deletion."
          : "Disconnected locally. Check application status above. GitHub authorization was not revoked.",
      )
      await refreshRelated(version, signal)
    } catch (failure) {
      await failed(failure, version, signal)
    } finally {
      if (valid(version, signal)) setBusy(false)
    }
  }
  const terminalMessage =
    flow?.status === "conflict"
      ? "Configuration changed. This authorization cannot be saved. Start a new authorization only after reviewing current settings."
      : flow?.status === "expired"
        ? "GitHub authorization expired. Nothing was saved."
        : flow?.status === "failed"
          ? "GitHub authorization failed. Reload local status before another action."
          : flow?.status === "cancelled"
            ? "GitHub authorization cancelled. Nothing was saved."
            : ""

  return (
    <Panel aria-label="GitHub connection" aria-busy={busy}>
      <Heading as="h2" size="4">
        Connect GitHub
      </Heading>
      <Prose size="2">
        Use a deployment-owned GitHub.com OAuth App with Device Flow enabled. Enter only its public
        Client ID; no client secret is needed. Manual Personal Access Token controls remain below.
      </Prose>
      <Prose size="2">
        Requested scopes: repo and read:org. repo includes private-repository read/write access;
        OAuth is not restricted to one selected repository. Use a fine-grained PAT for repository
        restrictions. This connection grants no chat or tool permissions. Every approved bash chat
        can use or read the effective token.
      </Prose>
      {connection && (
        <Text as="p" size="2">
          {connection.mode === "none"
            ? "No GitHub credential configured."
            : connection.mode === "manual"
              ? "Manual GH_TOKEN configured; remote acceptance is not checked."
              : connection.mode === "invalid"
                ? "Managed GitHub state is invalid. Reset GH_TOKEN and GITHUB_OAUTH_STATE before connecting."
                : `GitHub account: ${connection.account?.login ?? "unknown"}. Granted scopes: ${connection.scopes?.join(", ") || "none"}.`}
          {connection.reconnectRequired &&
            " Reconnect required. The managed credential is unavailable."}
        </Text>
      )}
      {flow?.receipt && (
        <div role="status" aria-label="GitHub saved outcome">
          <Text as="p" weight="medium">
            {flow.receipt.application.status === "failed"
              ? "Saved; application failed."
              : flow.receipt.application.status === "unknown"
                ? "GitHub account saved; application outcome unknown or superseded."
                : flow.receipt.application.status === "applied" &&
                    flow.receipt.application.applied === flow.receipt.savedRevision
                  ? "GitHub account saved and applied."
                  : "GitHub account saved; application pending."}
          </Text>
          <Text as="p" size="2">
            Saved GitHub revision {flow.receipt.savedRevision}. Application at settlement: revision{" "}
            {flow.receipt.application.revision}, applied {flow.receipt.application.applied},{" "}
            {flow.receipt.application.status}.
          </Text>
          <Prose size="2">
            Do not save this authorization again. Use Retry application above when current
            application has failed.
          </Prose>
        </div>
      )}
      {current && (
        <Text as="p" size="2" aria-label="Current GitHub application state">
          Current settings revision {current.revision}; applied {current.applied}; {current.status}.
        </Text>
      )}
      {terminalMessage && (
        <Text as="p" role="status">
          {terminalMessage}
        </Text>
      )}
      {notice && (
        <Text as="p" role="status">
          {notice}
        </Text>
      )}
      {error && !open && (
        <Callout.Root
          ref={alert}
          tabIndex={-1}
          role={unavailable ? "status" : "alert"}
          color="orange"
        >
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {busy && owner.current.unresolved && !flow && (
        <Text as="p" role="status">
          Starting GitHub authorization…
        </Text>
      )}
      {activeGitHubFlow(flow) && (
        <section ref={flowPanel} tabIndex={-1} aria-label="GitHub authorization">
          {flow?.status === "pending" && (
            <Flex direction="column" gap="3" mt="3">
              <Text role="status">Waiting for GitHub authorization. Nothing is saved.</Text>
              {flow.userCode && (
                <Text as="p">
                  GitHub user code: <code>{flow.userCode}</code>
                </Text>
              )}
              {flow.verificationUri && (
                <Button asChild variant="soft">
                  <a href={flow.verificationUri} target="_blank" rel="noopener noreferrer">
                    Open GitHub device authorization
                  </a>
                </Button>
              )}
              <Text as="p" size="2">
                Expires: {new Date(flow.expiresAt).toLocaleString()}
              </Text>
            </Flex>
          )}
          {flow?.status === "authorized" && flow.account && (
            <Flex direction="column" gap="3" mt="3">
              <Text as="p" weight="medium">
                Verified GitHub account: {flow.account.login} (ID {flow.account.id})
              </Text>
              <Text as="p">Actual granted scopes: {flow.scopes?.join(", ") || "none"}.</Text>
              <Prose size="2">
                Save this account to encrypted GH_TOKEN and GITHUB_OAUTH_STATE and apply the change.
                Existing credentials remain unchanged until this save.
              </Prose>
              <Button
                disabled={disabled || !flow.scopes || completionAttempted.current}
                onClick={() => void complete()}
              >
                Save and apply this account
              </Button>
            </Flex>
          )}
          <Prose size="2">
            Cancel keeps GH_TOKEN and GITHUB_OAUTH_STATE unchanged unless a save has already
            committed.
          </Prose>
        </section>
      )}
      {connection && !connection.clientId && (
        <Prose size="2">Configure and apply GITHUB_OAUTH_CLIENT_ID before connecting.</Prose>
      )}
      <Flex gap="3" wrap="wrap" mt="3">
        {activeGitHubFlow(flow) || owner.current.unresolved ? (
          <Button variant="soft" onClick={() => void cancel()}>
            Cancel GitHub authorization
          </Button>
        ) : (
          <Button
            disabled={!canConnect}
            onClick={() => {
              setScopeConsent(false)
              setReplaceConsent(false)
              setError("")
              setOpen(true)
            }}
          >
            {connection?.mode === "oauth" ? "Reconnect GitHub" : "Connect GitHub"}
          </Button>
        )}
        <Button
          variant="soft"
          disabled={busy || blocked || clientDraft !== undefined}
          onClick={() => void load()}
        >
          Reload GitHub status
        </Button>
        {connection && !activeGitHubFlow(flow) && !recovery && (
          <>
            <Button
              variant="soft"
              disabled={disabled || clientDraft !== undefined}
              onClick={() => setClientDraft(connection.clientId ?? "")}
            >
              {connection.clientId ? "Edit GitHub Client ID" : "Configure GitHub Client ID"}
            </Button>
            {connection.mode !== "none" && (
              <Button
                variant="soft"
                color="red"
                disabled={
                  disabled || clientDraft !== undefined || connection.secretStatus !== "ready"
                }
                onClick={() => setDisconnecting(true)}
              >
                {connection.mode === "invalid" ? "Reset GitHub connection" : "Disconnect GitHub"}
              </Button>
            )}
          </>
        )}
      </Flex>
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
          <label htmlFor="github-client-id">
            Public GitHub OAuth Client ID
            <TextField.Root
              id="github-client-id"
              value={clientDraft}
              autoComplete="off"
              autoFocus
              disabled={busy}
              maxLength={128}
              onChange={(event) => setClientDraft(event.target.value)}
            />
          </label>
          <Prose size="2">
            This is the public variable GITHUB_OAUTH_CLIENT_ID, not a client secret. Save and apply
            it before authorization.
          </Prose>
          <Flex gap="3" wrap="wrap" mt="3">
            <Button
              type="submit"
              disabled={disabled || !/^[a-zA-Z0-9_.-]{1,128}$/.test(clientDraft)}
            >
              Save GitHub Client ID
            </Button>
            <Button
              type="button"
              variant="soft"
              disabled={busy}
              onClick={() => setClientDraft(undefined)}
            >
              Discard Client ID draft
            </Button>
          </Flex>
        </form>
      )}
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!value) void cancel()
        }}
      >
        <Dialog.Content maxWidth="520px" onInteractOutside={(event) => event.preventDefault()}>
          <Dialog.Title>
            {activeGitHubFlow(flow) ? "GitHub authorization" : "Connect GitHub account"}
          </Dialog.Title>
          <Dialog.Description size="2">
            Authorize at GitHub, check the verified account, then explicitly save and apply.
            Authorization alone does not save credentials. Cancel keeps GH_TOKEN and
            GITHUB_OAUTH_STATE unchanged unless a save has already committed.
          </Dialog.Description>
          {error && (
            <Text as="p" color="red" role="alert">
              {error}
            </Text>
          )}
          {!activeGitHubFlow(flow) && !owner.current.unresolved && (
            <Flex direction="column" gap="3" mt="3">
              <Text as="label" size="2">
                <Checkbox
                  checked={scopeConsent}
                  onCheckedChange={(value) => setScopeConsent(value === true)}
                />{" "}
                I consent to repo (private-repository read/write) and read:org. Access is not
                limited to one repository.
              </Text>
              {replacing && (
                <Text as="label" size="2">
                  <Checkbox
                    checked={replaceConsent}
                    onCheckedChange={(value) => setReplaceConsent(value === true)}
                  />{" "}
                  Replace the existing GH_TOKEN and GITHUB_OAUTH_STATE only when I save the verified
                  account.
                </Text>
              )}
              <Button
                disabled={!canConnect || !scopeConsent || (replacing && !replaceConsent)}
                onClick={() => void start()}
              >
                Start GitHub authorization
              </Button>
            </Flex>
          )}
          {terminalMessage && (
            <Text as="p" role="status">
              {terminalMessage}
            </Text>
          )}
          <Flex justify="end" mt="4">
            <Button variant="soft" onClick={() => void cancel()}>
              {activeGitHubFlow(flow) || owner.current.unresolved
                ? "Cancel GitHub authorization"
                : "Close"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
      <AlertDialog.Root open={disconnecting} onOpenChange={setDisconnecting}>
        <AlertDialog.Content>
          <AlertDialog.Title>
            {connection?.mode === "invalid" ? "Reset GitHub connection?" : "Disconnect GitHub?"}
          </AlertDialog.Title>
          <AlertDialog.Description>
            Delete GH_TOKEN and GITHUB_OAUTH_STATE and apply the change, including orphaned or
            colliding state. Remove saved MCP references first. This does not revoke GitHub
            authorization, remove manually installed CLI credentials, or erase backups.
          </AlertDialog.Description>
          <Flex gap="3" wrap="wrap" mt="4">
            <AlertDialog.Cancel>
              <Button variant="soft">Keep GitHub connection</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button
                color="red"
                disabled={disabled || connection?.secretStatus !== "ready"}
                onClick={() => void disconnect()}
              >
                Delete both entries and apply
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Panel>
  )
}
