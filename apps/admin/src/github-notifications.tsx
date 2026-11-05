import type { GitHubApplicationState, GitHubConnection } from "@narumitw/sumire-contracts"
import { githubUsernameSchema } from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, type Policy, request } from "./api.js"
import { githubApplicationStatusLabel, parseGitHubConnection } from "./github-state.js"
import { type MessageKey, t } from "./i18n.js"
import type { Page } from "./navigation.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

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
): string[] {
  const blockers: string[] = []
  if (!saved.githubNotifications.allowedUsernames.length) blockers.push(t("github.blockerEmpty"))
  if (!connection) blockers.push(t("github.blockerCredentialUnknown"))
  else {
    if (connection.secretStatus !== "ready") blockers.push(t("github.blockerStore"))
    if (connection.mode === "none") blockers.push(t("github.blockerToken"))
    if (connection.mode === "invalid") blockers.push(t("github.blockerManaged"))
    if (connection.reconnectRequired) blockers.push(t("github.blockerReconnect"))
  }
  const model = saved.defaults.model
  if (
    !model ||
    !saved.models.includes(model) ||
    !saved.defaults.models?.includes(model) ||
    saved.providers.some((provider) => provider.id === model.split("/")[0] && !provider.enabled)
  )
    blockers.push(t("github.blockerModel"))
  if (!application) blockers.push(t("github.blockerApplicationUnknown"))
  else if (application.status === "failed") blockers.push(t("github.blockerApplicationFailed"))
  else if (application.status !== "applied" || application.applied !== application.revision)
    blockers.push(t("github.blockerApplicationPending"))
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
  const input = useRef<HTMLInputElement>(null)
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
  const blockers = mentionBlockers(saved, connection, current)
  const usernames = policy.githubNotifications.allowedUsernames
  const savedUsernames = saved.githubNotifications.allowedUsernames
  const removed = savedUsernames.filter((username) => !usernames.includes(username))
  const update = (allowedUsernames: string[]) =>
    onChange({ ...policy, githubNotifications: { allowedUsernames } })
  return (
    <div className="settings-stack github-notifications">
      <SettingsSection
        title={t("github.accountPermissions")}
        description={t("github.tokenIdentity")}
      >
        <Panel aria-label={t("github.mentionsStatus")}>
          <Text as="p" weight="medium">
            {t("github.savedAuthorPolicy", {
              policy: savedUsernames.length
                ? t(savedUsernames.length === 1 ? "github.allowedOne" : "github.allowedCount", {
                    count: savedUsernames.length,
                  })
                : t("github.repliesDisabled"),
            })}
          </Text>
          {(removed.length > 0 ||
            usernames.some((username) => !savedUsernames.includes(username))) && (
            <Text as="p" color="orange">
              {t("github.draftAuthorPolicy", { count: usernames.length })}
            </Text>
          )}
          <Text as="p">
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
          </Text>
          <Text as="p">
            {t("github.priorVerification", {
              account: connection?.account
                ? t("github.accountDuringAuthorization", {
                    login: connection.account.login,
                    id: connection.account.id,
                  })
                : t("github.noAccountMetadata"),
            })}
          </Text>
          <Text as="p">
            {t("github.applicationSummary", {
              state: current
                ? t("github.applicationRevision", {
                    revision: current.revision,
                    applied: current.applied,
                    status: githubApplicationStatusLabel(current.status),
                  })
                : t("settings.unknownTitle"),
            })}
          </Text>
          <Text as="p">{t("github.remoteUnavailable")}</Text>
          {readFailed && (
            <Text as="p" role="status">
              {t("github.metadataFailed")}
            </Text>
          )}
          {!loading && (
            <section aria-label={t("github.knownBlockersLabel")}>
              <Text as="p" weight="medium">
                {t("github.knownBlockers")}
              </Text>
              {blockers.length ? (
                <ul>
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : (
                <Prose>{t("github.noKnownBlockers")}</Prose>
              )}
            </section>
          )}
        </Panel>
        <Flex gap="3" wrap="wrap">
          <Button
            variant="soft"
            onClick={() =>
              onOpenConnection ? onOpenConnection() : onNavigate("Secrets & variables")
            }
          >
            {t("github.manageConnection")}
          </Button>
          <Button variant="soft" onClick={() => onNavigate("Secrets & variables")}>
            {t("github.manageToken")}
          </Button>
          <Button variant="soft" disabled={loading} onClick={() => setReload((value) => value + 1)}>
            {t("github.reloadMetadata")}
          </Button>
        </Flex>
        <Callout.Root color="orange">
          <Callout.Text>{t("github.hostTrust")}</Callout.Text>
        </Callout.Root>
      </SettingsSection>
      <SettingsSection
        title={t("github.authorAllowlist")}
        description={t("github.authorAllowlistDescription")}
      >
        <Prose>{t("github.authorHelp")}</Prose>
        <form
          className="github-author-form"
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
          <label className="form-field" htmlFor="github-mention-author">
            {t("github.username")}
            <TextField.Root
              ref={input}
              id="github-mention-author"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="octocat"
              value={value}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "github-author-error" : "github-author-help"}
              onChange={(event) => {
                setValue(event.target.value)
                setError("")
                onPending(Boolean(event.target.value))
              }}
            />
          </label>
          <Button type="submit" disabled={disabled || !value.trim()}>
            {t("github.addUsername")}
          </Button>
          <Text as="p" size="2" color="gray" id="github-author-help">
            {t("github.usernameHelp")}
          </Text>
          {error && (
            <Text as="p" id="github-author-error" role="alert" color="red">
              {t(error)}
            </Text>
          )}
        </form>
        <Panel id="github-mention-authors" tabIndex={-1} aria-label={t("github.allowedUsernames")}>
          <Text as="p" weight="medium" aria-live="polite">
            {t(usernames.length === 1 ? "github.allowedOne" : "github.allowedCount", {
              count: usernames.length,
            })}
          </Text>
          {usernames.length === 0 && <Prose>{t("github.emptyAllowlist")}</Prose>}
          <ul className="github-author-list">
            {[...usernames, ...removed].map((username) => {
              const revoked = removed.includes(username)
              return (
                <li key={username}>
                  <Code variant="ghost">{username}</Code>
                  <Badge color={revoked || !savedUsernames.includes(username) ? "orange" : "gray"}>
                    {revoked
                      ? t("settings.pendingRemoval")
                      : savedUsernames.includes(username)
                        ? t("settings.saved")
                        : t("settings.pendingAddition")}
                  </Badge>
                  <Button
                    variant="soft"
                    color={revoked ? "gray" : "red"}
                    disabled={disabled}
                    aria-label={t(revoked ? "github.restoreUsername" : "github.removeUsername", {
                      username,
                    })}
                    onClick={() => {
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
