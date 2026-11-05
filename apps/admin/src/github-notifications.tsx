import type { GitHubApplicationState, GitHubConnection } from "@narumitw/sumire-contracts"
import { githubUsernameSchema } from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, type Policy, request } from "./api.js"
import { parseGitHubConnection } from "./github-state.js"
import type { Page } from "./navigation.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

export function mentionAuthorError(value: string, usernames: readonly string[]): string {
  const parsed = githubUsernameSchema.safeParse(value.trim())
  if (!parsed.success)
    return "Enter a GitHub username: 1–39 letters or digits, with single interior hyphens only."
  if (usernames.some((username) => username.toLowerCase() === parsed.data))
    return "This GitHub username is already allowed."
  if (usernames.length >= 1000)
    return "Remove a username before adding another. The limit is 1,000 usernames."
  return ""
}

/** Read-only metadata must not retain an authorization flow or its temporary code. */
export function mentionConnection(value: unknown): GitHubConnection {
  if (!value || typeof value !== "object") throw new Error("Invalid GitHub metadata")
  return parseGitHubConnection({ ...value, flow: undefined })
}

export function mentionBlockers(
  saved: Policy,
  connection?: GitHubConnection,
  application?: GitHubApplicationState,
): string[] {
  const blockers: string[] = []
  if (!saved.githubNotifications.allowedUsernames.length)
    blockers.push("The saved author allowlist is empty; automatic replies are disabled.")
  if (!connection) blockers.push("Local credential state is unknown.")
  else {
    if (connection.secretStatus !== "ready") blockers.push("The secret store is not available.")
    if (connection.mode === "none") blockers.push("GH_TOKEN is not configured.")
    if (connection.mode === "invalid") blockers.push("Managed GitHub state is invalid.")
    if (connection.reconnectRequired) blockers.push("The GitHub credential requires reconnection.")
  }
  const model = saved.defaults.model
  if (
    !model ||
    !saved.models.includes(model) ||
    !saved.defaults.models?.includes(model) ||
    saved.providers.some((provider) => provider.id === model.split("/")[0] && !provider.enabled)
  )
    blockers.push("A shared default model must be selected and allowed for GitHub replies.")
  if (!application) blockers.push("Application state is unknown.")
  else if (application.status === "failed")
    blockers.push("Settings were saved but application failed.")
  else if (application.status !== "applied" || application.applied !== application.revision)
    blockers.push("The saved settings are not confirmed applied.")
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
  const [error, setError] = useState("")
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
        title="GitHub account & permissions"
        description="GH_TOKEN determines which GitHub account Sumire uses."
      >
        <Panel aria-label="GitHub mentions status">
          <Text as="p" weight="medium">
            Saved author policy:{" "}
            {savedUsernames.length
              ? `${savedUsernames.length} allowed usernames`
              : "automatic replies disabled"}
            .
          </Text>
          {(removed.length > 0 ||
            usernames.some((username) => !savedUsernames.includes(username))) && (
            <Text as="p" color="orange">
              Draft author policy: {usernames.length} allowed usernames. Unsaved; saved policy still
              applies.
            </Text>
          )}
          <Text as="p">
            Local credential:{" "}
            {loading
              ? "Checking local metadata…"
              : !connection
                ? "Unknown"
                : connection.mode === "none"
                  ? "Missing GH_TOKEN"
                  : connection.secretStatus !== "ready" ||
                      connection.mode === "invalid" ||
                      connection.reconnectRequired
                    ? "Unavailable"
                    : "GH_TOKEN configured"}
            .
          </Text>
          <Text as="p">
            Prior account verification:{" "}
            {connection?.account
              ? `${connection.account.login} (ID ${connection.account.id}) during GitHub authorization`
              : "No account metadata available"}
            .
          </Text>
          <Text as="p">
            Application:{" "}
            {current
              ? `saved revision ${current.revision}; applied ${current.applied}; ${current.status}`
              : "Unknown"}
            .
          </Text>
          <Text as="p">
            Remote verification and worker status: unavailable. Delivery health is not measured
            here.
          </Text>
          {readFailed && (
            <Text as="p" role="status">
              Could not load local GitHub metadata. Manual GH_TOKEN management remains available.
            </Text>
          )}
          {!loading && (
            <section aria-label="Known GitHub blockers">
              <Text as="p" weight="medium">
                Known blockers
              </Text>
              {blockers.length ? (
                <ul>
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : (
                <Prose>
                  No known local blockers. This does not verify remote acceptance or worker health.
                </Prose>
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
            Manage GitHub connection
          </Button>
          <Button variant="soft" onClick={() => onNavigate("Secrets & variables")}>
            Manage GH_TOKEN
          </Button>
          <Button variant="soft" disabled={loading} onClick={() => setReload((value) => value + 1)}>
            Reload local GitHub metadata
          </Button>
        </Flex>
        <Callout.Root color="orange">
          <Callout.Text>
            Chats with bash access can use and read GH_TOKEN, independently of this author
            allowlist. Shell and file access remain trusted host access, not a security sandbox.
            Configured state does not prove that GitHub accepts the token. The token must allow
            access to mentions and replies in the relevant repositories.
          </Callout.Text>
        </Callout.Root>
      </SettingsSection>
      <SettingsSection
        title="Mention author allowlist"
        description="Choose which GitHub authors can trigger automatic replies on GitHub."
      >
        <Prose>
          When someone mentions the GitHub account authenticated by GH_TOKEN, Sumire replies on
          GitHub only if the mention author is in this allowlist. Mentions from other authors are
          ignored. Enter one GitHub username at a time, then select Review and save changes.
          Telegram chat access and tool permissions are not required. Removing a username stops
          future automatic replies; it does not delete replies already posted on GitHub.
        </Prose>
        <form
          className="github-author-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (disabled) return
            const message = mentionAuthorError(value, usernames)
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
            GitHub username
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
            Add username
          </Button>
          <Text as="p" size="2" color="gray" id="github-author-help">
            Use a GitHub username without @, not a Telegram user ID. Usernames are saved in
            lowercase. The limit is 1,000 usernames.
          </Text>
          {error && (
            <Text as="p" id="github-author-error" role="alert" color="red">
              {error}
            </Text>
          )}
        </form>
        <Panel id="github-mention-authors" tabIndex={-1} aria-label="Allowed GitHub usernames">
          <Text as="p" weight="medium" aria-live="polite">
            {usernames.length} allowed {usernames.length === 1 ? "username" : "usernames"}
          </Text>
          {usernames.length === 0 && (
            <Prose>
              No usernames allowed. An empty saved allowlist disables automatic replies.
            </Prose>
          )}
          <ul className="github-author-list">
            {[...usernames, ...removed].map((username) => {
              const revoked = removed.includes(username)
              return (
                <li key={username}>
                  <Code variant="ghost">{username}</Code>
                  <Badge color={revoked || !savedUsernames.includes(username) ? "orange" : "gray"}>
                    {revoked
                      ? "Pending removal"
                      : savedUsernames.includes(username)
                        ? "Saved"
                        : "Pending addition"}
                  </Badge>
                  <Button
                    variant="soft"
                    color={revoked ? "gray" : "red"}
                    disabled={disabled}
                    aria-label={`${revoked ? "Restore" : "Remove"} username ${username}`}
                    onClick={() => {
                      if (revoked) {
                        const message = mentionAuthorError(username, usernames)
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
                    {revoked ? "Undo removal" : "Remove"}
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
