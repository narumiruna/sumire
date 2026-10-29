import { githubUsernameSchema } from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useRef, useState } from "react"
import type { Policy } from "./api.js"
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

export function GithubNotifications({
  policy,
  saved,
  disabled,
  onChange,
  onPending,
  onNavigate,
}: {
  policy: Policy
  saved: Policy
  disabled: boolean
  onChange(policy: Policy): void
  onPending(pending: boolean): void
  onNavigate(page: Page): void
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const usernames = policy.githubNotifications.allowedUsernames
  const savedUsernames = saved.githubNotifications.allowedUsernames
  const removed = savedUsernames.filter((username) => !usernames.includes(username))
  const update = (allowedUsernames: string[]) =>
    onChange({ ...policy, githubNotifications: { allowedUsernames } })
  return (
    <div className="settings-stack github-notifications">
      <SettingsSection
        title="Mention author allowlist"
        description="Choose which GitHub authors can trigger automatic replies on GitHub."
      >
        <Prose>
          When someone mentions the GitHub account authenticated by GH_TOKEN, Sumire replies on
          GitHub only if the mention author is in this allowlist. Mentions from other authors are
          ignored. Enter one GitHub username at a time, then select Review and save changes.
          Telegram chat access and tool permissions are not required.
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
      <SettingsSection
        title="GitHub account & permissions"
        description="GH_TOKEN determines which GitHub account Sumire uses."
      >
        <Prose>
          Save and apply the encrypted <Code>GH_TOKEN</Code> secret in Secrets & variables. The
          token must allow Sumire to read mentions and post replies in the relevant repositories.
          Configured state does not prove that GitHub accepts the token. Replies are posted on
          GitHub as the account authenticated by this token, not sent to Telegram.
        </Prose>
        <Flex gap="3" wrap="wrap">
          <Button variant="soft" onClick={() => onNavigate("Secrets & variables")}>
            Manage GH_TOKEN
          </Button>
        </Flex>
        <Callout.Root color="orange">
          <Callout.Text>
            Chats with bash access can use and read GH_TOKEN, independently of this author
            allowlist. Shell and file access remain trusted host access, not a security sandbox.
            Removing a username stops future automatic replies; it does not delete replies already
            posted on GitHub.
          </Callout.Text>
        </Callout.Root>
      </SettingsSection>
    </div>
  )
}
