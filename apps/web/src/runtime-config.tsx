import type {
  GitHubApplicationState,
  RuntimeConfigEntry,
  RuntimeConfigMutation,
  RuntimeConfigResponse,
} from "@narumitw/sumire-contracts"
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Flex,
  Heading,
  Tabs,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { GitHubConnection } from "./github-connection.js"
import { getLocale, type MessageKey, t } from "./i18n.js"
import { parseRuntimeConfig, runtimeValueErrorKey } from "./runtime-config-state.js"
import { Panel, Prose } from "./surfaces.js"

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
      <Tabs.Root
        value={kind}
        onValueChange={(value) => {
          if (!canLeave()) return
          setDeleting(undefined)
          setKind(value as "secret" | "variable")
          setSearch("")
        }}
      >
        <Tabs.List aria-label={t("runtime.valueKinds")}>
          <Tabs.Trigger value="secret">{t("runtime.secrets")}</Tabs.Trigger>
          <Tabs.Trigger value="variable">{t("runtime.variables")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value={kind} className="settings-stack">
          <Prose>{kind === "secret" ? t("runtime.secretHelp") : t("runtime.variableHelp")}</Prose>
          {data?.secretStatus !== "ready" && data && (
            <Callout.Root color="orange" role="status">
              <Callout.Text>
                {data.secretStatus === "locked"
                  ? t("runtime.storeLocked")
                  : t("runtime.storeUnavailable")}{" "}
                {t("runtime.variablesAvailable")}
              </Callout.Text>
            </Callout.Root>
          )}
          {blocked && <Prose>{t("runtime.blocked")}</Prose>}
          {stale && <Prose>{t("runtime.stale")}</Prose>}
          {error && (
            <Callout.Root ref={alert} tabIndex={-1} role="alert" color="red">
              <Callout.Text>{t(error)}</Callout.Text>
            </Callout.Root>
          )}
          {notice && <Text role="status">{t(notice)}</Text>}
          <label htmlFor="runtime-search">
            {t("runtime.search")}
            <TextField.Root
              id="runtime-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Flex gap="3" wrap="wrap">
            <Button
              id="runtime-add"
              disabled={!data || disabled || unavailable || Boolean(draft)}
              onClick={() => start()}
            >
              {t(kind === "secret" ? "runtime.addSecret" : "runtime.addVariable")}
            </Button>
            <Button
              variant="soft"
              disabled={busy || blocked}
              onClick={() => {
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
          </Flex>
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
                <Heading size="3">
                  {draft.existing
                    ? kind === "secret"
                      ? t("runtime.replaceSecret")
                      : t("runtime.editVariable")
                    : t(kind === "secret" ? "runtime.addSecret" : "runtime.addVariable")}
                </Heading>
                {draft.name === "GH_TOKEN" && (
                  <Prose size="2">{t("runtime.manualTokenHelp")}</Prose>
                )}
                <label htmlFor="runtime-name">
                  {t("settings.name")}
                  <TextField.Root
                    id="runtime-name"
                    value={draft.name}
                    disabled={draft.existing || busy}
                    autoComplete="off"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label htmlFor="runtime-value">
                  {kind === "secret" ? t("runtime.secretValue") : t("runtime.variableValue")}
                  {kind === "secret" ? (
                    <TextField.Root
                      id="runtime-value"
                      type="password"
                      autoComplete="new-password"
                      value={draft.value}
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    />
                  ) : (
                    <TextArea
                      id="runtime-value"
                      value={draft.value}
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    />
                  )}
                </label>
                <Prose size="2">
                  {t("runtime.saveHelp")}
                  {draft.existing && kind === "secret" && t("runtime.previousNotLoaded")}
                </Prose>
                <Flex gap="3" wrap="wrap" mt="3">
                  <Button
                    type="submit"
                    disabled={disabled || unavailable || (kind === "secret" && !draft.value)}
                  >
                    {t(kind === "secret" ? "runtime.saveSecret" : "runtime.saveVariable")}
                  </Button>
                  <Button
                    type="button"
                    variant="soft"
                    disabled={busy}
                    onClick={() => {
                      focusTarget.current = "runtime-add"
                      clear()
                      if (!recovery) setError("")
                    }}
                  >
                    {draft.existing ? t("runtime.keepUnchanged") : t("settings.cancel")}
                  </Button>
                </Flex>
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
                <Text role="status">
                  {entries?.length
                    ? t("runtime.noMatches")
                    : t(kind === "secret" ? "runtime.noSecrets" : "runtime.noVariables")}
                </Text>
              )}
              {visible?.map((entry) => (
                <Panel
                  key={entry.name}
                  aria-label={t(kind === "secret" ? "runtime.secretName" : "runtime.variableName", {
                    name: entry.name,
                  })}
                  className="runtime-values-row"
                >
                  <Heading as="h2" size="3" className="runtime-entry-name">
                    {entry.name}
                  </Heading>
                  {entry.kind === "secret" ? (
                    <Badge>{t("runtime.writeOnly")}</Badge>
                  ) : (
                    <div>
                      <Badge>{t("runtime.configured")}</Badge>
                      <pre className="runtime-variable-value">{entry.value}</pre>
                    </div>
                  )}
                  <Text as="p" size="2">
                    {t("runtime.updatedAt", {
                      date: new Date(entry.updatedAt).toLocaleString(getLocale()),
                    })}
                  </Text>
                  <Flex gap="3" wrap="wrap">
                    <Button
                      variant="soft"
                      disabled={disabled || unavailable || Boolean(draft)}
                      onClick={() => start(entry)}
                    >
                      {t(kind === "secret" ? "runtime.replaceName" : "settings.editName", {
                        name: entry.name,
                      })}
                    </Button>
                    <Button
                      variant="soft"
                      color="red"
                      disabled={disabled || unavailable || Boolean(draft)}
                      onClick={() => setDeleting(entry)}
                    >
                      {t("settings.deleteName", { name: entry.name })}
                    </Button>
                  </Flex>
                </Panel>
              ))}
            </>
          ) : (
            <Text role="status">
              {busy ? t("runtime.loading") : t("runtime.metadataUnavailable")}
            </Text>
          )}
          {kind === "secret" && (
            <section aria-label={t("github.credentialOptions")} className="settings-stack">
              <Flex gap="3" wrap="wrap">
                <Button
                  id="github-connection-entry"
                  variant="soft"
                  disabled={busy || blocked || recovery || Boolean(draft)}
                  onClick={() => {
                    if (connectionOpen) {
                      if (githubGuard.current && !githubGuard.current()) return
                      setConnectionOpen(false)
                      document.getElementById("github-connection-entry")?.focus()
                    } else setConnectionOpen(true)
                  }}
                >
                  {connectionOpen ? t("github.closeConnection") : t("github.manageConnection")}
                </Button>
              </Flex>
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
          <AlertDialog.Root
            open={Boolean(deleting)}
            onOpenChange={(open) => {
              if (!open) setDeleting(undefined)
            }}
          >
            <AlertDialog.Content
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                document.getElementById("runtime-add")?.focus()
              }}
            >
              <AlertDialog.Title>
                {t("settings.deleteConfirm", { name: deleting?.name ?? "" })}
              </AlertDialog.Title>
              <AlertDialog.Description>
                {t(
                  deleting?.kind === "secret"
                    ? "runtime.deleteSecretHelp"
                    : "runtime.deleteVariableHelp",
                )}{" "}
                {deleting?.name === "GH_TOKEN" && t("runtime.deleteTokenHelp")}
                {t("runtime.deleteHelp")}
              </AlertDialog.Description>
              <Flex gap="3" mt="4">
                <AlertDialog.Cancel>
                  <Button variant="soft">{t("settings.cancel")}</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button
                    color="red"
                    disabled={disabled}
                    onClick={() => {
                      if (deleting) void mutate(deleting.name)
                    }}
                  >
                    {t("runtime.deleteApply")}
                  </Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
