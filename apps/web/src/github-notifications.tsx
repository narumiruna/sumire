import type { GitHubApplicationState, GitHubConnection } from "@narumitw/sumire-contracts"
import { githubUsernameSchema } from "@narumitw/sumire-policy"
import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField, type TextFieldRef } from "@react-spectrum/s2/TextField"
import { useEffect, useRef, useState } from "react"
import { ApiError, type Policy, request } from "./api.js"
import { githubApplicationStatusLabel, parseGitHubConnection } from "./github-state.js"
import { type MessageKey, t } from "./i18n.js"
import type { Page } from "./navigation.js"
import { Disclosure, Panel, Prose, SettingsSection, StatusLabel } from "./surfaces.js"
import "./spectrum-runtime.css"

const hostTrust = style({
  backgroundColor: "notice-subtle",
  color: "notice-1000",
  borderRadius: "default",
  padding: 12,
})

function mentionAuthorErrorKey(value: string, usernames: readonly string[]): MessageKey | "" {
  const parsed = githubUsernameSchema.safeParse(value.trim())
  if (!parsed.success) return "github.authorInvalid"
  if (usernames.some((username) => username.toLowerCase() === parsed.data))
    return "github.authorDuplicate"
  if (usernames.length >= 1000) return "github.authorLimit"
  return ""
}

export function mentionAuthorError(value: string, usernames: readonly string[]): string {
  const key = mentionAuthorErrorKey(value, usernames)
  return key ? t(key) : ""
}

/** Read-only metadata must not retain an authorization flow or its temporary code. */
export function mentionConnection(value: unknown): GitHubConnection {
  if (!value || typeof value !== "object") throw new Error(t("github.invalidMetadata"))
  return parseGitHubConnection({ ...value, flow: undefined })
}

export function mentionBlockers(
  saved: Policy,
  connection?: GitHubConnection,
  application?: GitHubApplicationState,
): MessageKey[] {
  const blockers: MessageKey[] = []
  if (!saved.githubNotifications.allowedUsernames.length) blockers.push("github.blockerEmpty")
  if (!connection) blockers.push("github.blockerCredentialUnknown")
  else {
    if (connection.secretStatus !== "ready") blockers.push("github.blockerStore")
    if (connection.mode === "none") blockers.push("github.blockerToken")
    if (connection.mode === "invalid") blockers.push("github.blockerManaged")
    if (connection.reconnectRequired) blockers.push("github.blockerReconnect")
  }
  const model = saved.defaults.model
  if (
    !model ||
    !saved.models.includes(model) ||
    !saved.defaults.models?.includes(model) ||
    saved.providers.some((provider) => provider.id === model.split("/")[0] && !provider.enabled)
  )
    blockers.push("github.blockerModel")
  if (!application) blockers.push("github.blockerApplicationUnknown")
  else if (application.status === "failed") blockers.push("github.blockerApplicationFailed")
  else if (application.status !== "applied" || application.applied !== application.revision)
    blockers.push("github.blockerApplicationPending")
  return blockers
}

export function GithubNotifications({
  policy,
  saved,
  disabled,
  onChange,
  onPending,
  onNavigate,
  onOpenConnection,
  application,
  onSessionExpired,
  active = true,
}: {
  policy: Policy
  saved: Policy
  disabled: boolean
  onChange(policy: Policy): void
  onPending(pending: boolean): void
  onNavigate(page: Page): void
  onOpenConnection?(): void
  application?: GitHubApplicationState
  onSessionExpired?(): void
  active?: boolean
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState<MessageKey | "">("")
  const input = useRef<TextFieldRef>(null)
  const [connection, setConnection] = useState<GitHubConnection>()
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision changes and explicit reload invalidate local metadata without starting authorization.
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    setReadFailed(false)
    void request("github/connection", undefined, undefined, "GET", controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setConnection(mentionConnection(value))
      })
      .catch((failure) => {
        if (controller.signal.aborted) return
        setConnection(undefined)
        setReadFailed(true)
        if (failure instanceof ApiError && failure.status === 401) onSessionExpired?.()
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [active, application?.revision, onSessionExpired, reload])
  const current =
    !application || (connection && connection.revision > application.revision)
      ? connection
      : application
  const blockers = mentionBlockers(saved, connection, current).filter(
    (key) =>
      key !== "github.blockerEmpty" && !(readFailed && key === "github.blockerCredentialUnknown"),
  )
  const usernames = policy.githubNotifications.allowedUsernames
  const savedUsernames = saved.githubNotifications.allowedUsernames
  const removed = savedUsernames.filter((username) => !usernames.includes(username))
  const update = (allowedUsernames: string[]) =>
    onChange({ ...policy, githubNotifications: { allowedUsernames } })
  return (
    <div className="settings-stack github-notifications">
      <SettingsSection title={t("github.accountPermissions")}>
        <Panel aria-label={t("github.mentionsStatus")}>
          <Prose weight="medium">
            {savedUsernames.length
              ? t("github.savedAuthorPolicy", {
                  policy: t(
                    savedUsernames.length === 1 ? "github.allowedOne" : "github.allowedCount",
                    {
                      count: savedUsernames.length,
                    },
                  ),
                })
              : t("github.blockerEmpty")}
          </Prose>
          <div aria-live="polite">
            {(removed.length > 0 ||
              usernames.some((username) => !savedUsernames.includes(username))) && (
              <Prose color="orange">
                {t("github.draftAuthorPolicy", { count: usernames.length })}
              </Prose>
            )}
          </div>
          {loading && <Prose>{t("github.checkingMetadata")}</Prose>}
          {readFailed && <Prose role="status">{t("github.metadataFailed")}</Prose>}
          {!loading &&
            (blockers.length > 0 ? (
              <ul aria-label={t("github.knownBlockersLabel")}>
                {blockers.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            ) : savedUsernames.length > 0 && !readFailed ? (
              <Prose>{t("github.noKnownBlockers")}</Prose>
            ) : null)}
          <Disclosure title={t("github.statusDetails")}>
            <Prose size="2">{t("github.tokenIdentity")}</Prose>
            <Prose>
              {t("github.localCredential", {
                state: loading
                  ? t("github.checkingMetadata")
                  : !connection
                    ? t("settings.unknownTitle")
                    : connection.mode === "none"
                      ? t("github.missingToken")
                      : connection.secretStatus !== "ready" ||
                          connection.mode === "invalid" ||
                          connection.reconnectRequired
                        ? t("settings.unavailable")
                        : t("github.tokenConfigured"),
              })}
            </Prose>
            <Prose>
              {t("github.priorVerification", {
                account: connection?.account
                  ? t("github.accountDuringAuthorization", {
                      login: connection.account.login,
                      id: connection.account.id,
                    })
                  : t("github.noAccountMetadata"),
              })}
            </Prose>
            <Prose>
              {t("github.applicationSummary", {
                state: current
                  ? t("github.applicationRevision", {
                      revision: current.revision,
                      applied: current.applied,
                      status: githubApplicationStatusLabel(current.status),
                    })
                  : t("settings.unknownTitle"),
              })}
            </Prose>
            <Prose>{t("github.remoteUnavailable")}</Prose>
          </Disclosure>
        </Panel>
        <div className="runtime-actions">
          <Button
            variant="secondary"
            onPress={() =>
              onOpenConnection ? onOpenConnection() : onNavigate("Secrets & variables")
            }
          >
            {t("github.manageConnection")}
          </Button>
          <Button variant="secondary" onPress={() => onNavigate("Secrets & variables")}>
            {t("github.manageToken")}
          </Button>
          <Button
            variant="secondary"
            isDisabled={loading}
            onPress={() => setReload((value) => value + 1)}
          >
            {t("github.reloadMetadata")}
          </Button>
        </div>
        <p className={`runtime-notice ${hostTrust}`}>{t("github.hostTrust")}</p>
      </SettingsSection>
      <SettingsSection title={t("github.authorAllowlist")}>
        <Prose>{t("github.authorHelp")}</Prose>
        <form
          className="github-author-form"
          autoCapitalize="none"
          onSubmit={(event) => {
            event.preventDefault()
            if (disabled) return
            const message = mentionAuthorErrorKey(value, usernames)
            setError(message)
            if (message) {
              input.current?.focus()
              return
            }
            update([...usernames, githubUsernameSchema.parse(value.trim())])
            setValue("")
            onPending(false)
            input.current?.focus()
          }}
        >
          <TextField
            UNSAFE_className="form-field"
            ref={input}
            id="github-mention-author"
            label={t("github.username")}
            autoComplete="off"
            spellCheck="false"
            placeholder="octocat"
            value={value}
            isDisabled={disabled}
            isInvalid={Boolean(error)}
            aria-describedby={error ? "github-author-error" : "github-author-help"}
            onChange={(value) => {
              setValue(value)
              setError("")
              onPending(Boolean(value))
            }}
          />
          <Button type="submit" variant="accent" isDisabled={disabled || !value.trim()}>
            {t("github.addUsername")}
          </Button>
          <Prose size="2" color="gray" id="github-author-help">
            {t("github.usernameHelp")}
          </Prose>
          {error && (
            <p id="github-author-error" role="alert" className={style({ color: "negative-1000" })}>
              {t(error)}
            </p>
          )}
        </form>
        <Panel
          id="github-mention-authors"
          tabIndex={-1}
          aria-label={t("github.allowedUsernames")}
          hidden={usernames.length === 0 && removed.length === 0}
        >
          <ul className="github-author-list">
            {[...usernames, ...removed].map((username) => {
              const revoked = removed.includes(username)
              return (
                <li key={username}>
                  <code>{username}</code>
                  <StatusLabel
                    tone={revoked || !savedUsernames.includes(username) ? "warning" : "neutral"}
                  >
                    {revoked
                      ? t("settings.pendingRemoval")
                      : savedUsernames.includes(username)
                        ? t("settings.saved")
                        : t("settings.pendingAddition")}
                  </StatusLabel>
                  <Button
                    variant={revoked ? "secondary" : "negative"}
                    fillStyle="outline"
                    isDisabled={disabled}
                    aria-label={t(revoked ? "github.restoreUsername" : "github.removeUsername", {
                      username,
                    })}
                    onPress={() => {
                      if (revoked) {
                        const message = mentionAuthorErrorKey(username, usernames)
                        if (message) {
                          setError(message)
                          input.current?.focus()
                          return
                        }
                      }
                      update(
                        revoked
                          ? [...usernames, username]
                          : usernames.filter((value) => value !== username),
                      )
                      setError("")
                      input.current?.focus()
                    }}
                  >
                    {revoked ? t("settings.undoRemoval") : t("settings.remove")}
                  </Button>
                </li>
              )
            })}
          </ul>
        </Panel>
      </SettingsSection>
    </div>
  )
}
