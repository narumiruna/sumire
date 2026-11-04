import { type StatusNotifications, statusProviderIds } from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useContext, useRef, useState } from "react"
import type { Policy } from "./api.js"
import { ChatSelector, chatName, useChatDirectory } from "./chat-directory.js"
import { Check } from "./policy-editors.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import {
  statusChatIdError,
  statusPollingIntervals,
  statusProviderNames,
} from "./status-notifications.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

export function ServiceStatus({
  policy,
  saved,
  disabled,
  onChange,
  onPending,
  onSessionExpired,
}: {
  policy: Policy
  saved: Policy
  disabled: boolean
  onChange(policy: Policy): void
  onPending(pending: boolean): void
  onSessionExpired(): void
}) {
  const active = useContext(SectionActive)
  const directory = useChatDirectory(active, "", onSessionExpired)
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const settings = policy.statusNotifications
  const update = (change: Partial<StatusNotifications>) => {
    if (!disabled) onChange({ ...policy, statusNotifications: { ...settings, ...change } })
  }
  const selectDestination = (id: number, checked: boolean) => {
    if (disabled) return
    const message = checked ? statusChatIdError(String(id), settings.chatIds) : ""
    setError(message)
    if (message) return
    update({
      chatIds: checked
        ? [...settings.chatIds, id]
        : settings.chatIds.filter((value) => value !== id),
    })
  }
  return (
    <div className="settings-stack service-status">
      <SettingsSection
        title="Status notifications"
        description="Send service incidents to Telegram without model calls."
      >
        <Check
          id="status-notifications-enabled"
          label="Enable service status notifications"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(enabled) => update({ enabled })}
        />
        <Prose>
          Sources use original status-page text. No model calls are made. All selected destinations
          use the same services and notification filters.
        </Prose>
        <Prose>
          This notification-only selection does not grant Pi access or change chat approval, model
          access, or tool permissions.
        </Prose>
        {settings.enabled && (!settings.providers.length || !settings.chatIds.length) && (
          <Callout.Root color="orange" role="alert">
            <Callout.Text>
              No notifications will be sent.
              {!settings.providers.length && " Select at least one service."}
              {!settings.chatIds.length && " Select at least one destination."} Review and save
              changes to apply these settings.
            </Callout.Text>
          </Callout.Root>
        )}
      </SettingsSection>
      <SettingsSection title="Services" description="Select the status sources to monitor.">
        <Panel as="fieldset" id="status-notification-services" tabIndex={-1}>
          <legend>Monitored services</legend>
          <Flex direction="column" gap="2">
            {statusProviderIds.map((provider) => (
              <Check
                key={provider}
                label={statusProviderNames[provider]}
                checked={settings.providers.includes(provider)}
                disabled={disabled}
                onChange={(checked) =>
                  update({
                    providers: checked
                      ? [...settings.providers, provider]
                      : settings.providers.filter((value) => value !== provider),
                  })
                }
              />
            ))}
          </Flex>
        </Panel>
      </SettingsSection>
      <SettingsSection
        title="Notification filters"
        description="These settings apply to every selected destination."
      >
        <Panel as="fieldset" id="status-notification-filters" tabIndex={-1}>
          <legend>Delivery settings</legend>
          <Flex direction="column" align="start" gap="3">
            <label className="form-field" htmlFor="status-polling-interval">
              Polling interval
              <Select.Root
                value={String(settings.pollIntervalSeconds)}
                disabled={disabled}
                onValueChange={(value) => update({ pollIntervalSeconds: Number(value) })}
              >
                <Select.Trigger id="status-polling-interval" aria-label="Polling interval" />
                <Select.Content>
                  {statusPollingIntervals(settings.pollIntervalSeconds).map((seconds) => (
                    <Select.Item key={seconds} value={String(seconds)}>
                      {seconds} seconds
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </label>
            <label className="form-field" htmlFor="status-minimum-impact">
              Minimum impact
              <Select.Root
                value={settings.minimumImpact}
                disabled={disabled}
                onValueChange={(value) =>
                  update({ minimumImpact: value as StatusNotifications["minimumImpact"] })
                }
              >
                <Select.Trigger id="status-minimum-impact" aria-label="Minimum impact" />
                <Select.Content>
                  <Select.Item value="none">None (all impacts)</Select.Item>
                  <Select.Item value="minor">Minor</Select.Item>
                  <Select.Item value="major">Major</Select.Item>
                  <Select.Item value="critical">Critical</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
            <Check
              label="Notify incident updates"
              checked={settings.notifyUpdates}
              disabled={disabled}
              onChange={(notifyUpdates) => update({ notifyUpdates })}
            />
            <Check
              label="Notify resolved incidents"
              checked={settings.notifyResolved}
              disabled={disabled}
              onChange={(notifyResolved) => update({ notifyResolved })}
            />
            <Check
              label="Include scheduled maintenance"
              checked={settings.includeMaintenance}
              disabled={disabled}
              onChange={(includeMaintenance) => update({ includeMaintenance })}
            />
          </Flex>
        </Panel>
      </SettingsSection>
      <SettingsSection
        title="Destinations"
        description="Choose stored chats or add an exact Telegram chat ID."
      >
        <Prose>
          Private recipients must send /start to the bot first. For channels, the bot needs posting
          rights. A stored chat is not proof that the bot can deliver messages.
        </Prose>
        <Panel
          id="status-notification-destinations"
          tabIndex={-1}
          aria-label="Selected notification destinations"
        >
          <Text as="p" weight="medium" aria-live="polite">
            {settings.chatIds.length} selected{" "}
            {settings.chatIds.length === 1 ? "destination" : "destinations"}
          </Text>
          {!settings.chatIds.length && <Prose>No destinations selected.</Prose>}
          <ul className="status-destination-list" aria-label="Selected destinations">
            {settings.chatIds.map((id) => {
              const chat = directory.knownChats.find((chat) => chat.id === id)
              return (
                <li key={id}>
                  <span>
                    {chat ? chatName(chat) : "Telegram chat"} <Code variant="ghost">{id}</Code>
                  </span>
                  <Badge color={saved.statusNotifications.chatIds.includes(id) ? "gray" : "orange"}>
                    {saved.statusNotifications.chatIds.includes(id) ? "Saved" : "Pending addition"}
                  </Badge>
                  <Button
                    variant="soft"
                    disabled={disabled}
                    aria-label={`Remove destination ${id}`}
                    onClick={() => selectDestination(id, false)}
                  >
                    Remove
                  </Button>
                </li>
              )
            })}
          </ul>
        </Panel>
        <details className="status-manual-destination">
          <summary>Add an exact Telegram chat ID</summary>
          <form
            className="status-destination-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (disabled) return
              const message = statusChatIdError(value, settings.chatIds)
              setError(message)
              if (message) {
                input.current?.focus()
                return
              }
              selectDestination(Number(value), true)
              setValue("")
              onPending(false)
              input.current?.focus()
            }}
          >
            <label className="form-field" htmlFor="status-notification-chat-id">
              Telegram notification chat ID
              <TextField.Root
                ref={input}
                id="status-notification-chat-id"
                value={value}
                disabled={disabled}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "status-destination-error" : "status-destination-help"}
                onChange={(event) => {
                  setValue(event.target.value)
                  setError("")
                  onPending(Boolean(event.target.value))
                }}
              />
            </label>
            <Button type="submit" disabled={disabled || !value}>
              Add destination
            </Button>
            {value && (
              <Button
                type="button"
                variant="soft"
                disabled={disabled}
                onClick={() => {
                  setValue("")
                  setError("")
                  onPending(false)
                  input.current?.focus()
                }}
              >
                Clear chat ID input
              </Button>
            )}
            <Prose size="2" color="gray" id="status-destination-help">
              Use a positive private user ID or a negative group or channel ID, including chats not
              yet observed. No URLs, plus signs, spaces, or leading zeros. The limit is 1,000 unique
              destinations.
            </Prose>
          </form>
        </details>
        {error && (
          <Text as="p" id="status-destination-error" role="alert" color="red">
            {error}
          </Text>
        )}
        <section aria-label="Stored notification destinations">
          <ChatSelector
            directory={directory}
            title="Find stored destinations"
            stateLabel="Notification selection"
            chat=""
            onSelect={(value) => {
              const id = Number(value)
              selectDestination(id, !settings.chatIds.includes(id))
            }}
            badge={(chat) => (
              <Text size="1" color="gray">
                {settings.chatIds.includes(chat.id) ? "Selected destination" : "Not selected"}
              </Text>
            )}
            actions={(chat) => (
              <Check
                label={`Send status notifications to ${chatName(chat)} · ${chat.id}`}
                visibleLabel=""
                checked={settings.chatIds.includes(chat.id)}
                disabled={
                  disabled ||
                  (settings.chatIds.length >= 1000 && !settings.chatIds.includes(chat.id))
                }
                onChange={(checked) => selectDestination(chat.id, checked)}
              />
            )}
          />
        </section>
      </SettingsSection>
    </div>
  )
}
