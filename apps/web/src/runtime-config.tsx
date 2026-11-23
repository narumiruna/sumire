import type {
  GitHubApplicationState,
  RuntimeConfigEntry,
  RuntimeConfigMutation,
  RuntimeConfigResponse,
} from "@narumitw/sumire-contracts"
import { AlertDialog, DialogTrigger } from "@react-spectrum/s2/AlertDialog"
import { Button } from "@react-spectrum/s2/Button"
import { SearchField } from "@react-spectrum/s2/SearchField"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { Tab, TabList, TabPanel, Tabs } from "@react-spectrum/s2/Tabs"
import { TextArea } from "@react-spectrum/s2/TextArea"
import { TextField } from "@react-spectrum/s2/TextField"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { GitHubConnection } from "./github-connection.js"
import { getLocale, type MessageKey, t } from "./i18n.js"
import { parseRuntimeConfig, runtimeValueErrorKey } from "./runtime-config-state.js"
import { Panel, Prose, StatusLabel } from "./surfaces.js"
import "./spectrum-runtime.css"

const storeNotice = style({
  backgroundColor: "notice-subtle",
  color: "notice-1000",
  borderRadius: "default",
  padding: 12,
})
const errorNotice = style({
  backgroundColor: "negative-subtle",
  color: "negative-1000",
  borderRadius: "default",
  padding: 12,
})
const field = style({ width: "full" })
const heading = style({ font: "heading-xs", color: "title", margin: 0 })

type Draft = { name: string; kind: "secret" | "variable"; value: string; existing: boolean }
type Props = {
  csrf: string
  blocked: boolean
  revision: number
  application?: GitHubApplicationState
  connectionRequest?: number
  onPending(value: boolean): void
  guard: React.MutableRefObject<(() => boolean) | undefined>
  onCommitted(value: GitHubApplicationState): void
  onSessionExpired(): void
  refresh(): Promise<void>
}

export function RuntimeConfig({
  csrf,
  blocked,
  revision,
  application,
  connectionRequest = 0,
  onPending,
  guard,
  onCommitted,
  onSessionExpired,
  refresh,
}: Props) {
  const [data, setData] = useState<RuntimeConfigResponse>()
  const [kind, setKind] = useState<"secret" | "variable">("secret")
  const [search, setSearch] = useState("")
  const [draft, setDraft] = useState<Draft>()
  const [deleting, setDeleting] = useState<RuntimeConfigEntry>()
  const [busy, setBusy] = useState(false)
  const [githubPending, setGithubPending] = useState(false)
  const [connectionOpen, setConnectionOpen] = useState(connectionRequest > 0)
  const lastConnectionRequest = useRef(connectionRequest)
  useEffect(() => {
    if (lastConnectionRequest.current === connectionRequest) return
    lastConnectionRequest.current = connectionRequest
    setConnectionOpen(true)
  }, [connectionRequest])
  const githubGuard = useRef<(() => boolean) | undefined>(undefined)
  const [error, setError] = useState<MessageKey | "">("")
  const [recovery, setRecovery] = useState(false)
  const [notice, setNotice] = useState<MessageKey | "">("")
  const generation = useRef(0)
  const deleteDescription = useId()
  const alert = useRef<HTMLDivElement>(null)
  const focusTarget = useRef<"runtime-name" | "runtime-value" | "runtime-add">(undefined)
  const clear = () => {
    setDraft(undefined)
  }
  const canLeave = () => {
    if (busy) return false
    if (draft && !window.confirm(t("runtime.leaveConfirm"))) return false
    if (githubGuard.current && !githubGuard.current()) return false
    clear()
    return true
  }
  guard.current = canLeave
  const pending = Boolean(draft) || busy || recovery || githubPending
  useEffect(() => onPending(pending), [onPending, pending])
  useEffect(
    () => () => {
      generation.current++
      guard.current = undefined
      onPending(false)
    },
    [guard, onPending],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening or closing a draft must move focus after its fields mount.
  useEffect(() => {
    if (error && !deleting) alert.current?.focus()
    else if (!busy && focusTarget.current) {
      document.getElementById(focusTarget.current)?.focus()
      focusTarget.current = undefined
    }
  }, [error, busy, deleting, draft])
  const load = async () => {
    const version = generation.current
    setBusy(true)
    setError("")
    try {
      const next = parseRuntimeConfig(await request<RuntimeConfigResponse>("runtime-config"))
      if (version !== generation.current) return
      setData(next)
      setRecovery(false)
    } catch (failure) {
      if (version !== generation.current) return
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
      else setError("runtime.loadFailed")
    } finally {
      if (version === generation.current) setBusy(false)
    }
  }
  // The section is unmounted on navigation or session expiry; late results cannot restore drafts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Load once per mounted session section.
  useEffect(() => {
    void load()
  }, [])
  const mutate = async (name: string, mutation?: RuntimeConfigMutation) => {
    if (!data || blocked || recovery || busy || data.revision !== revision) return
    const version = generation.current
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const committed = parseRuntimeConfig(
        await request<RuntimeConfigResponse>(
          `runtime-config/${encodeURIComponent(name)}`,
          csrf,
          mutation ?? { revision: data.revision },
          mutation ? "PUT" : "DELETE",
        ),
      )
      if (committed.revision <= data.revision) throw new Error(t("runtime.unverifiedSave"))
      if (version !== generation.current) return
      // Persistence succeeded, including when application failed. Never resubmit the value.
      clear()
      setDeleting(undefined)
      setData(committed)
      onCommitted(committed)
      focusTarget.current = "runtime-add"
      setNotice(
        committed.status === "applied" && committed.applied === committed.revision
          ? "runtime.savedApplied"
          : committed.status === "failed"
            ? "runtime.savedFailed"
            : "runtime.savedPending",
      )
      try {
        await refresh()
      } catch (failure) {
        if (version !== generation.current) return
        if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
        else setError("runtime.refreshFailedSaved")
      }
    } catch (failure) {
      if (version !== generation.current) return
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
      else {
        setDeleting(undefined)
        setRecovery(true)
        setError(
          failure instanceof ApiError && failure.status === 409
            ? "runtime.conflict"
            : "runtime.saveUnknown",
        )
      }
    } finally {
      if (version === generation.current) setBusy(false)
    }
  }
  const stale = Boolean(data && data.revision !== revision)
  const unavailable = kind === "secret" && data?.secretStatus !== "ready"
  const disabled = busy || blocked || recovery || stale || githubPending
  const entries = data?.entries.filter((entry) => entry.kind === kind)
  const visible = entries?.filter((entry) => entry.name.includes(search.trim().toUpperCase()))
  const start = (entry?: RuntimeConfigEntry) => {
    focusTarget.current = entry ? "runtime-value" : "runtime-name"
    setError("")
    setNotice("")
    setDraft({
      name: entry?.name ?? "",
      kind,
      value: entry?.kind === "variable" ? entry.value : "",
      existing: Boolean(entry),
    })
  }
  return (
    <div className="settings-stack runtime-config" aria-busy={busy}>
      <Tabs
        aria-label={t("runtime.valueKinds")}
        selectedKey={kind}
        keyboardActivation="manual"
        onSelectionChange={(value) => {
          if ((value !== "secret" && value !== "variable") || !canLeave()) return
          setDeleting(undefined)
          setKind(value)
          setSearch("")
        }}
      >
        <TabList>
          <Tab id="secret">{t("runtime.secrets")}</Tab>
          <Tab id="variable">{t("runtime.variables")}</Tab>
        </TabList>
        <TabPanel key={kind} id={kind} UNSAFE_className="runtime-values-panel">
          <Prose>{kind === "secret" ? t("runtime.secretHelp") : t("runtime.variableHelp")}</Prose>
          {data?.secretStatus !== "ready" && data && (
            <p className={`runtime-notice ${storeNotice}`} role="status">
              {data.secretStatus === "locked"
                ? t("runtime.storeLocked")
                : t("runtime.storeUnavailable")}{" "}
              {t("runtime.variablesAvailable")}
            </p>
          )}
          {blocked && <Prose>{t("runtime.blocked")}</Prose>}
          {stale && <Prose>{t("runtime.stale")}</Prose>}
          {error && (
            <div className={`runtime-notice ${errorNotice}`} ref={alert} tabIndex={-1} role="alert">
              {t(error)}
            </div>
          )}
          {notice && <Prose role="status">{t(notice)}</Prose>}
          <SearchField
            id="runtime-search"
            label={t("runtime.search")}
            value={search}
            onChange={setSearch}
            styles={field}
          />
          <div className="runtime-actions">
            <Button
              id="runtime-add"
              variant="accent"
              isDisabled={!data || disabled || unavailable || Boolean(draft)}
              onPress={() => start()}
            >
              {t(kind === "secret" ? "runtime.addSecret" : "runtime.addVariable")}
            </Button>
            <Button
              variant="secondary"
              isDisabled={busy || blocked}
              onPress={() => {
                if (draft && !window.confirm(t("runtime.reloadConfirm"))) return
                if (githubGuard.current && !githubGuard.current()) return
                clear()
                const version = generation.current
                void load().then(async () => {
                  if (version !== generation.current) return
                  try {
                    await refresh()
                  } catch (failure) {
                    if (version !== generation.current) return
                    if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
                    else setError("runtime.refreshApplicationFailed")
                  }
                })
              }}
            >
              {t("runtime.reload")}
            </Button>
          </div>
          {draft && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const message = runtimeValueErrorKey(draft.name, draft.kind, draft.value)
                if (message) {
                  setError(message)
                  return
                }
                if (!draft.existing && data?.entries.some((entry) => entry.name === draft.name)) {
                  setError("runtime.nameExists")
                  return
                }
                if (data)
                  void mutate(draft.name, {
                    revision: data.revision,
                    kind: draft.kind,
                    value: draft.value,
                  })
              }}
            >
              <Panel>
                <h2 className={heading}>
                  {draft.existing
                    ? kind === "secret"
                      ? t("runtime.replaceSecret")
                      : t("runtime.editVariable")
                    : t(kind === "secret" ? "runtime.addSecret" : "runtime.addVariable")}
                </h2>
                {draft.name === "GH_TOKEN" && (
                  <Prose size="2">{t("runtime.manualTokenHelp")}</Prose>
                )}
                <TextField
                  id="runtime-name"
                  label={t("settings.name")}
                  value={draft.name}
                  isDisabled={draft.existing || busy}
                  autoComplete="off"
                  onChange={(name) => setDraft({ ...draft, name })}
                  styles={field}
                />
                {kind === "secret" ? (
                  <TextField
                    id="runtime-value"
                    label={t("runtime.secretValue")}
                    type="password"
                    autoComplete="new-password"
                    value={draft.value}
                    isDisabled={busy}
                    onChange={(value) => setDraft({ ...draft, value })}
                    styles={field}
                  />
                ) : (
                  <TextArea
                    id="runtime-value"
                    label={t("runtime.variableValue")}
                    value={draft.value}
                    isDisabled={busy}
                    onChange={(value) => setDraft({ ...draft, value })}
                    styles={field}
                  />
                )}
                <Prose size="2">
                  {t("runtime.saveHelp")}
                  {draft.existing && kind === "secret" && t("runtime.previousNotLoaded")}
                </Prose>
                <div className="runtime-actions runtime-actions--spaced">
                  <Button
                    type="submit"
                    variant="accent"
                    isDisabled={disabled || unavailable || (kind === "secret" && !draft.value)}
                  >
                    {t(kind === "secret" ? "runtime.saveSecret" : "runtime.saveVariable")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    isDisabled={busy}
                    onPress={() => {
                      focusTarget.current = "runtime-add"
                      clear()
                      if (!recovery) setError("")
                    }}
                  >
                    {draft.existing ? t("runtime.keepUnchanged") : t("settings.cancel")}
                  </Button>
                </div>
              </Panel>
            </form>
          )}
          {data ? (
            <>
              <div className="runtime-values-columns" aria-hidden="true">
                <strong>{t("settings.name")}</strong>
                <strong>{t("runtime.configuredState")}</strong>
                <strong>{t("settings.updated")}</strong>
                <strong>{t("settings.actions")}</strong>
              </div>
              {!visible?.length && (
                <Prose role="status">
                  {entries?.length
                    ? t("runtime.noMatches")
                    : t(kind === "secret" ? "runtime.noSecrets" : "runtime.noVariables")}
                </Prose>
              )}
              {visible?.map((entry) => (
                <Panel
                  key={entry.name}
                  aria-label={t(kind === "secret" ? "runtime.secretName" : "runtime.variableName", {
                    name: entry.name,
                  })}
                  className="runtime-values-row"
                >
                  <h2 className={`runtime-entry-name ${heading}`}>{entry.name}</h2>
                  {entry.kind === "secret" ? (
                    <StatusLabel>{t("runtime.writeOnly")}</StatusLabel>
                  ) : (
                    <div>
                      <StatusLabel>{t("runtime.configured")}</StatusLabel>
                      <pre className="runtime-variable-value">{entry.value}</pre>
                    </div>
                  )}
                  <Prose size="2">
                    {t("runtime.updatedAt", {
                      date: new Date(entry.updatedAt).toLocaleString(getLocale()),
                    })}
                  </Prose>
                  <div className="runtime-actions">
                    <Button
                      variant="secondary"
                      isDisabled={disabled || unavailable || Boolean(draft)}
                      onPress={() => start(entry)}
                    >
                      {t(kind === "secret" ? "runtime.replaceName" : "settings.editName", {
                        name: entry.name,
                      })}
                    </Button>
                    <DialogTrigger
                      isOpen={deleting?.name === entry.name}
                      onOpenChange={(open) => {
                        if (!open) focusTarget.current = "runtime-add"
                        setDeleting(open ? entry : undefined)
                      }}
                    >
                      <Button
                        variant="negative"
                        fillStyle="outline"
                        isDisabled={disabled || unavailable || Boolean(draft)}
                      >
                        {t("settings.deleteName", { name: entry.name })}
                      </Button>
                      <AlertDialog
                        variant="destructive"
                        title={t("settings.deleteConfirm", { name: entry.name })}
                        aria-describedby={`${deleteDescription}-${entry.name}`}
                        cancelLabel={t("settings.cancel")}
                        primaryActionLabel={t("runtime.deleteApply")}
                        autoFocusButton="cancel"
                        isPrimaryActionDisabled={disabled}
                        onPrimaryAction={() => void mutate(entry.name)}
                      >
                        <p id={`${deleteDescription}-${entry.name}`}>
                          {t(
                            entry.kind === "secret"
                              ? "runtime.deleteSecretHelp"
                              : "runtime.deleteVariableHelp",
                          )}{" "}
                          {entry.name === "GH_TOKEN" && t("runtime.deleteTokenHelp")}
                          {t("runtime.deleteHelp")}
                        </p>
                      </AlertDialog>
                    </DialogTrigger>
                  </div>
                </Panel>
              ))}
            </>
          ) : (
            <Prose role="status">
              {busy ? t("runtime.loading") : t("runtime.metadataUnavailable")}
            </Prose>
          )}
          {kind === "secret" && (
            <section aria-label={t("github.credentialOptions")} className="settings-stack">
              <div className="runtime-actions">
                <Button
                  id="github-connection-entry"
                  variant="secondary"
                  isDisabled={busy || blocked || recovery || Boolean(draft)}
                  onPress={() => {
                    if (connectionOpen) {
                      if (githubGuard.current && !githubGuard.current()) return
                      setConnectionOpen(false)
                      document.getElementById("github-connection-entry")?.focus()
                    } else setConnectionOpen(true)
                  }}
                >
                  {connectionOpen ? t("github.closeConnection") : t("github.manageConnection")}
                </Button>
              </div>
              <Prose size="2">{t("runtime.tokenHelp")}</Prose>
              <Prose size="2">{t("runtime.mentionHelp")}</Prose>
              {connectionOpen && (
                <GitHubConnection
                  csrf={csrf}
                  revision={revision}
                  application={application}
                  blocked={blocked || busy || recovery || Boolean(draft)}
                  onPending={setGithubPending}
                  guard={githubGuard}
                  onCommitted={onCommitted}
                  onSessionExpired={onSessionExpired}
                  refresh={async () => {
                    await Promise.all([load(), refresh()])
                  }}
                />
              )}
            </section>
          )}
        </TabPanel>
      </Tabs>
    </div>
  )
}
