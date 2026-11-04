import type { Snapshot } from "@narumitw/sumire-contracts"
import {
  resolveStatusSubscription,
  type StatusChatOverride,
  type StatusNotifications,
  type StatusQuietHours,
  statusProviderIds,
} from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useContext, useEffect, useRef, useState } from "react"
import type { Policy } from "./api.js"
import { ChatSelector, chatName, useChatDirectory } from "./chat-directory.js"
import { Check } from "./policy-editors.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { StatusComponents } from "./service-status-components.js"
import { StatusDelivery } from "./service-status-delivery.js"
import { StatusTiming } from "./service-status-timing.js"
import {
  removeStatusDestination,
  statusChatIdError,
  statusPollingIntervals,
  statusProviderNames,
  statusSelectionError,
  withStatusOverride,
} from "./status-notifications.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

export function ServiceStatus({
  policy,
  saved,
  csrf,
  application,
  disabled,
  onChange,
  onPending,
  onSessionExpired,
}: {
  policy: Policy
  saved: Policy
  csrf: string
  application: Pick<Snapshot, "revision" | "applied" | "status">
  disabled: boolean
  onChange(policy: Policy): void
  onPending(pending: boolean, scope?: "destination" | "quietHours"): void
  onSessionExpired(): void
}) {
  const active = useContext(SectionActive)
  const directory = useChatDirectory(active, "", onSessionExpired)
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [selectionError, setSelectionError] = useState("")
  const [editedChat, setEditedChat] = useState<number>()
  const [quietDrafts, setQuietDrafts] = useState<Record<string, StatusQuietHours>>({})
  const input = useRef<HTMLInputElement>(null)
  const settings = policy.statusNotifications
  useEffect(() => {
    const remaining = Object.fromEntries(
      Object.entries(quietDrafts).filter(
        ([scope]) => scope === "defaults" || settings.chatIds.includes(Number(scope)),
      ),
    )
    if (Object.keys(remaining).length === Object.keys(quietDrafts).length) return
    setQuietDrafts(remaining)
    onPending(Object.keys(remaining).length > 0, "quietHours")
  }, [settings.chatIds, quietDrafts, onPending])
  const selectedChat =
    editedChat !== undefined && settings.chatIds.includes(editedChat)
      ? editedChat
      : settings.chatIds[0]
  const override =
    selectedChat === undefined ? undefined : settings.chatOverrides[String(selectedChat)]
  const effective =
    selectedChat === undefined ? undefined : resolveStatusSubscription(settings, selectedChat)
  const noServices = settings.chatIds.length
    ? !settings.chatIds.some((id) => resolveStatusSubscription(settings, id)?.providers.length)
    : !settings.providers.length
  const update = (change: Partial<StatusNotifications>) => {
    if (disabled) return
    const next = { ...settings, ...change }
    const message = statusSelectionError(next)
    setSelectionError(message)
    if (!message) onChange({ ...policy, statusNotifications: next })
  }
  const updateOverride = <K extends keyof StatusChatOverride>(
    key: K,
    value: StatusChatOverride[K],
  ) => {
    if (selectedChat !== undefined) update(withStatusOverride(settings, selectedChat, key, value))
  }
  const quietDraft = (scope: string, value: StatusQuietHours | undefined) => {
    const drafts = { ...quietDrafts }
    if (value) drafts[scope] = value
    else delete drafts[scope]
    setQuietDrafts(drafts)
    onPending(Object.keys(drafts).length > 0, "quietHours")
  }
  const selectDestination = (id: number, checked: boolean) => {
    if (disabled) return
    const message = checked ? statusChatIdError(String(id), settings.chatIds) : ""
    setError(message)
    if (message) return
    if (checked) update({ chatIds: [...settings.chatIds, id] })
    else {
      quietDraft(String(id), undefined)
      update(removeStatusDestination(settings, id))
    }
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
          Sources use original status-page text. No model calls are made. Shared defaults apply
          unless a destination overrides that setting. Services in a chat override do not need to be
          selected in shared defaults.
        </Prose>
        <Prose>
          This notification-only selection does not grant Pi access or change chat approval, model
          access, or tool permissions.
        </Prose>
        {settings.enabled && (noServices || !settings.chatIds.length) && (
          <Callout.Root color="orange" role="alert">
            <Callout.Text>
              No notifications will be sent.
              {noServices && " Select at least one service."}
              {!settings.chatIds.length && " Select at least one destination."} Review and save
              changes to apply these settings.
            </Callout.Text>
          </Callout.Root>
        )}
      </SettingsSection>
      {selectionError && (
        <Prose role="alert" color="red">
          {selectionError}
        </Prose>
      )}
      {Object.keys(quietDrafts).length > 0 && (
        <Panel id="status-quiet-hours-editor" tabIndex={-1}>
          <Text as="p" weight="medium">
            Unsubmitted quiet hours input
          </Text>
          <Flex gap="2" wrap="wrap">
            {Object.keys(quietDrafts).map((scope) => (
              <Button
                key={scope}
                variant="soft"
                onClick={() => {
                  if (scope !== "defaults") setEditedChat(Number(scope))
                  requestAnimationFrame(() =>
                    document
                      .getElementById(
                        `${scope === "defaults" ? "status-default" : "status-chat"}-quiet-timeZone`,
                      )
                      ?.focus(),
                  )
                }}
              >
                Continue quiet input: {scope === "defaults" ? "Shared defaults" : `Chat ${scope}`}
              </Button>
            ))}
          </Flex>
        </Panel>
      )}
      <SettingsSection
        title="Shared defaults: services"
        description="Default status sources for destinations that inherit services."
      >
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
        title="Shared defaults and delivery filters"
        description="Minimum impact is a shared default. Polling, incident updates, recovery, and maintenance switches remain shared for all destinations."
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
        title="Shared defaults: components and timing"
        description="All components, no quiet hours, and no grouping unless changed here or overridden per destination."
      >
        <StatusComponents
          prefix="status-default"
          selections={settings.componentSelections}
          disabled={disabled}
          onChange={(componentSelections) => update({ componentSelections })}
          onSessionExpired={onSessionExpired}
        />
        <StatusTiming
          prefix="status-default"
          quietHours={settings.quietHours}
          batchWindowSeconds={settings.batchWindowSeconds}
          draft={quietDrafts.defaults}
          disabled={disabled}
          onQuietChange={(quietHours) => update({ quietHours: quietHours ?? null })}
          onBatchChange={(batchWindowSeconds) =>
            update({ batchWindowSeconds: batchWindowSeconds ?? 0 })
          }
          onDraft={(value) => quietDraft("defaults", value)}
        />
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
                    id={`status-chat-${id}`}
                    variant="soft"
                    aria-label={`Edit notification settings for ${id}`}
                    onFocus={() => setEditedChat(id)}
                    onClick={() => {
                      setEditedChat(id)
                      document
                        .getElementById("status-chat-overrides")
                        ?.scrollIntoView({ block: "start" })
                    }}
                  >
                    Edit subscription
                  </Button>
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
      <SettingsSection
        title="Per-chat subscription"
        description="One subscription per selected destination. Missing override fields inherit shared defaults; an empty service list sends nothing."
      >
        <Panel id="status-chat-overrides" tabIndex={-1}>
          {!settings.chatIds.length && (
            <Prose>
              Select a destination to edit its notification settings. This does not grant Pi access.
            </Prose>
          )}
          {selectedChat !== undefined && effective && (
            <>
              <label className="form-field" htmlFor="status-override-destination">
                Subscription destination
                <Select.Root
                  value={String(selectedChat)}
                  onValueChange={(value) => setEditedChat(Number(value))}
                >
                  <Select.Trigger
                    id="status-override-destination"
                    aria-label="Subscription destination"
                  />
                  <Select.Content>
                    {settings.chatIds.map((id) => (
                      <Select.Item key={id} value={String(id)}>
                        {id}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </label>
              <section
                aria-label={`Notification overrides for ${selectedChat}`}
                className="settings-stack"
              >
                <Prose size="2">
                  Editing chat <Code>{selectedChat}</Code> only. Shared defaults and Pi access are
                  unchanged.
                </Prose>
                <Button
                  variant="soft"
                  disabled={disabled || !override}
                  onClick={() => {
                    const chatOverrides = { ...settings.chatOverrides }
                    delete chatOverrides[String(selectedChat)]
                    quietDraft(String(selectedChat), undefined)
                    update({ chatOverrides })
                  }}
                >
                  Restore all notification defaults
                </Button>
                <Panel as="fieldset">
                  <legend>Chat services</legend>
                  <Check
                    label="Use shared services"
                    checked={override?.providers === undefined}
                    disabled={disabled}
                    onChange={(inherit) =>
                      updateOverride("providers", inherit ? undefined : effective.providers)
                    }
                  />
                  <Flex direction="column" gap="2">
                    {statusProviderIds.map((provider) => (
                      <Check
                        key={provider}
                        label={`${statusProviderNames[provider]} for this chat`}
                        checked={effective.providers.includes(provider)}
                        disabled={disabled || override?.providers === undefined}
                        onChange={(checked) =>
                          updateOverride(
                            "providers",
                            checked
                              ? [...effective.providers, provider]
                              : effective.providers.filter((id) => id !== provider),
                          )
                        }
                      />
                    ))}
                  </Flex>
                  {!effective.providers.length && (
                    <Prose size="2">
                      No services selected for this chat. It will not receive automatic notices.
                    </Prose>
                  )}
                </Panel>
                <label className="form-field" htmlFor="status-chat-impact">
                  Chat minimum impact
                  <Select.Root
                    value={override?.minimumImpact ?? "inherit"}
                    disabled={disabled}
                    onValueChange={(value) =>
                      updateOverride(
                        "minimumImpact",
                        value === "inherit"
                          ? undefined
                          : (value as StatusNotifications["minimumImpact"]),
                      )
                    }
                  >
                    <Select.Trigger id="status-chat-impact" aria-label="Chat minimum impact" />
                    <Select.Content>
                      <Select.Item value="inherit">
                        Inherit shared impact ({settings.minimumImpact})
                      </Select.Item>
                      <Select.Item value="none">None (all impacts)</Select.Item>
                      <Select.Item value="minor">Minor</Select.Item>
                      <Select.Item value="major">Major</Select.Item>
                      <Select.Item value="critical">Critical</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </label>
                <StatusComponents
                  key={`components-${selectedChat}`}
                  prefix="status-chat"
                  selections={override?.componentSelections ?? {}}
                  inherited={settings.componentSelections}
                  disabled={disabled}
                  onChange={(value) => updateOverride("componentSelections", value)}
                  onSessionExpired={onSessionExpired}
                />
                <StatusTiming
                  key={`timing-${selectedChat}`}
                  prefix="status-chat"
                  quietHours={override?.quietHours}
                  batchWindowSeconds={override?.batchWindowSeconds}
                  inherits
                  inheritedQuietHours={settings.quietHours}
                  inheritedBatchWindowSeconds={settings.batchWindowSeconds}
                  draft={quietDrafts[String(selectedChat)]}
                  disabled={disabled}
                  onQuietChange={(value) => updateOverride("quietHours", value)}
                  onBatchChange={(value) => updateOverride("batchWindowSeconds", value)}
                  onDraft={(value) => quietDraft(String(selectedChat), value)}
                />
              </section>
            </>
          )}
        </Panel>
      </SettingsSection>
      <StatusDelivery
        csrf={csrf}
        application={application}
        savedChatIds={saved.statusNotifications.chatIds}
        draftChatIds={settings.chatIds}
        disabled={disabled}
        onSessionExpired={onSessionExpired}
      />
    </div>
  )
}
