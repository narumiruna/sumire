import { Badge, Button, Callout, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useRef, useState } from "react"
import type { Policy } from "./api.js"
import type { Page } from "./navigation.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

export function notificationRecipientError(value: string, ids: readonly number[]): string {
  const id = value.trim()
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    return "Enter a positive Telegram user ID. Groups, usernames, and fractional IDs are not accepted."
  if (ids.includes(Number(id))) return "This user is already a notification recipient."
  if (ids.length >= 1000)
    return "Remove a recipient before adding another. The limit is 1,000 users."
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
  const ids = policy.githubNotifications.allowedUserIds
  const savedIds = saved.githubNotifications.allowedUserIds
  const removed = savedIds.filter((id) => !ids.includes(id))
  const update = (allowedUserIds: number[]) =>
    onChange({ ...policy, githubNotifications: { allowedUserIds } })
  return (
    <div className="settings-stack github-notifications">
      <SettingsSection
        title="Notification recipients"
        description="Choose who may read the shared GitHub account's notifications in a private Telegram chat."
      >
        <Prose>
          Enter one Telegram user ID at a time. Add or remove recipients, then select Review and
          save changes. This list does not approve chat access or grant tool permissions. Groups are
          always denied, and administrators must also be listed.
        </Prose>
        <form
          className="github-recipient-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (disabled) return
            const message = notificationRecipientError(value, ids)
            setError(message)
            if (message) {
              input.current?.focus()
              return
            }
            update([...ids, Number(value.trim())])
            setValue("")
            onPending(false)
            input.current?.focus()
          }}
        >
          <label className="form-field" htmlFor="github-notification-user">
            Telegram user ID
            <TextField.Root
              ref={input}
              id="github-notification-user"
              inputMode="numeric"
              autoComplete="off"
              placeholder="123456789"
              value={value}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "github-recipient-error" : "github-recipient-help"}
              onChange={(event) => {
                setValue(event.target.value)
                setError("")
                onPending(Boolean(event.target.value))
              }}
            />
          </label>
          <Button type="submit" disabled={disabled || !value.trim()}>
            Add recipient
          </Button>
          <Text as="p" size="2" color="gray" id="github-recipient-help">
            Use a positive numeric user ID, not a username or group ID. No JSON is needed.
          </Text>
          {error && (
            <Text as="p" id="github-recipient-error" role="alert" color="red">
              {error}
            </Text>
          )}
        </form>
        <Panel id="github-notification-recipients" tabIndex={-1} aria-label="Recipient list">
          <Text as="p" weight="medium" aria-live="polite">
            {ids.length} selected {ids.length === 1 ? "recipient" : "recipients"}
          </Text>
          {ids.length === 0 && (
            <Prose>No recipients selected. An empty saved list denies everyone.</Prose>
          )}
          <ul className="github-recipient-list">
            {[...ids, ...removed].map((id) => {
              const revoked = removed.includes(id)
              return (
                <li key={id}>
                  <Code variant="ghost">{id}</Code>
                  <Badge color={revoked || !savedIds.includes(id) ? "orange" : "gray"}>
                    {revoked
                      ? "Pending removal"
                      : savedIds.includes(id)
                        ? "Saved"
                        : "Pending addition"}
                  </Badge>
                  <Button
                    variant="soft"
                    color={revoked ? "gray" : "red"}
                    disabled={disabled}
                    aria-label={`${revoked ? "Restore" : "Remove"} recipient ${id}`}
                    onClick={() => {
                      if (revoked) {
                        const message = notificationRecipientError(String(id), ids)
                        if (message) {
                          setError(message)
                          input.current?.focus()
                          return
                        }
                      }
                      update(revoked ? [...ids, id] : ids.filter((value) => value !== id))
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
        description="Notifications use the same encrypted GH_TOKEN secret as GitHub CLI."
      >
        <Prose>
          Save a GitHub.com token accepted by the Notifications API as the secret{" "}
          <Code>GH_TOKEN</Code>, for example a classic Personal Access Token with the{" "}
          <Code>notifications</Code> scope. The token must be saved and applied. Configured state
          does not prove that GitHub accepts it. All recipients read notifications for this one
          account, not their own GitHub accounts.
        </Prose>
        <Prose>
          Each recipient also needs approved chat access and permission to use{" "}
          <Code>read_github_notifications</Code>. Adding a recipient here does not enable that tool.
        </Prose>
        <Flex gap="3" wrap="wrap">
          <Button variant="soft" onClick={() => onNavigate("Secrets & variables")}>
            Manage GH_TOKEN
          </Button>
          <Button variant="soft" onClick={() => onNavigate("Access")}>
            Manage chat access
          </Button>
          <Button variant="soft" onClick={() => onNavigate("Tool permissions")}>
            Manage tool permissions
          </Button>
        </Flex>
        <Callout.Root color="orange">
          <Callout.Text>
            Chats with bash access can use and read GH_TOKEN, independently of this recipient list.
            Shell and file access remain trusted host access, not a security sandbox. Notification
            metadata reaches the selected model and conversation history; long replies can also use
            Morsel. Removing a recipient does not erase earlier transcripts or exports.
          </Callout.Text>
        </Callout.Root>
      </SettingsSection>
    </div>
  )
}
