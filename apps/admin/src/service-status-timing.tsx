import type { StatusNotifications, StatusQuietHours } from "@narumitw/sumire-policy"
import { Button, Flex, TextField } from "@radix-ui/themes"
import { useState } from "react"
import { SectionSelect as Select } from "./sections.js"
import { statusQuietHoursError } from "./status-notifications.js"
import { Panel, Prose } from "./surfaces.js"

export function StatusTiming({
  prefix,
  quietHours,
  batchWindowSeconds,
  inherits = false,
  inheritedQuietHours,
  inheritedBatchWindowSeconds,
  draft,
  disabled,
  onQuietChange,
  onBatchChange,
  onDraft,
}: {
  prefix: string
  quietHours: StatusQuietHours | null | undefined
  batchWindowSeconds: StatusNotifications["batchWindowSeconds"] | undefined
  inherits?: boolean
  inheritedQuietHours?: StatusQuietHours | null
  inheritedBatchWindowSeconds?: StatusNotifications["batchWindowSeconds"]
  draft?: StatusQuietHours
  disabled: boolean
  onQuietChange(value: StatusQuietHours | null | undefined): void
  onBatchChange(value: StatusNotifications["batchWindowSeconds"] | undefined): void
  onDraft(value: StatusQuietHours | undefined): void
}) {
  const [submitted, setSubmitted] = useState(false)
  const mode = draft
    ? "daily"
    : inherits && quietHours === undefined
      ? "inherit"
      : quietHours
        ? "daily"
        : "off"
  const value = draft ?? quietHours
  const error = draft ? statusQuietHoursError(draft) : ""
  return (
    <Panel as="fieldset" id={`${prefix}-timing`} tabIndex={-1} className="status-timing">
      <legend>Quiet hours and update grouping</legend>
      <label className="form-field" htmlFor={`${prefix}-quiet-mode`}>
        Daily quiet window
        <Select.Root
          value={mode}
          disabled={disabled}
          onValueChange={(mode) => {
            onDraft(undefined)
            setSubmitted(false)
            onQuietChange(
              mode === "inherit"
                ? undefined
                : mode === "off"
                  ? null
                  : { timeZone: "Asia/Taipei", start: "22:00", end: "08:00" },
            )
          }}
        >
          <Select.Trigger id={`${prefix}-quiet-mode`} aria-label="Daily quiet window" />
          <Select.Content>
            {inherits && <Select.Item value="inherit">Inherit shared quiet hours</Select.Item>}
            <Select.Item value="off">Off</Select.Item>
            <Select.Item value="daily">Daily quiet window</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      {mode === "inherit" && (
        <Prose size="2">
          Shared quiet hours:{" "}
          {inheritedQuietHours
            ? `${inheritedQuietHours.start}–${inheritedQuietHours.end} (${inheritedQuietHours.timeZone})`
            : "off"}
          .
        </Prose>
      )}
      {mode === "daily" && value && (
        <div className="status-quiet-fields">
          {(
            [
              ["timeZone", "IANA time zone"],
              ["start", "Quiet start (HH:mm)"],
              ["end", "Quiet end (HH:mm)"],
            ] as const
          ).map(([key, label]) => (
            <label className="form-field" key={key} htmlFor={`${prefix}-quiet-${key}`}>
              {label}
              <TextField.Root
                id={`${prefix}-quiet-${key}`}
                value={value[key]}
                disabled={disabled}
                maxLength={key === "timeZone" ? 128 : 5}
                autoComplete="off"
                spellCheck={false}
                placeholder={key === "timeZone" ? "Asia/Taipei" : "HH:mm"}
                aria-invalid={submitted && Boolean(error)}
                aria-describedby={draft ? `${prefix}-quiet-draft-help` : undefined}
                onChange={(event) => {
                  setSubmitted(false)
                  onDraft({ ...value, [key]: event.target.value })
                }}
              />
            </label>
          ))}
          {draft && (
            <>
              <Prose size="2" id={`${prefix}-quiet-draft-help`} role="status">
                Unsubmitted quiet hours input. Stage this window or discard its input before review
                and save. Other settings drafts are unchanged.
              </Prose>
              {submitted && error && (
                <Prose color="red" role="alert">
                  {error}
                </Prose>
              )}
              <Flex gap="2" wrap="wrap">
                <Button
                  disabled={disabled}
                  onClick={() => {
                    setSubmitted(true)
                    if (error) return
                    onQuietChange(draft)
                    onDraft(undefined)
                    setSubmitted(false)
                  }}
                >
                  Stage quiet window
                </Button>
                <Button
                  variant="soft"
                  disabled={disabled}
                  onClick={() => {
                    onDraft(undefined)
                    setSubmitted(false)
                  }}
                >
                  Discard quiet hours input
                </Button>
              </Flex>
            </>
          )}
        </div>
      )}
      <Prose size="2">
        One daily window, including overnight windows. Start is inclusive; end is exclusive. Use an
        explicit IANA time zone. All automatic severities wait during quiet hours; there is no
        critical bypass. Eligible notices are retained for a summary after the window ends.
      </Prose>
      <label className="form-field" htmlFor={`${prefix}-batch-window`}>
        Group ordinary updates
        <Select.Root
          value={batchWindowSeconds === undefined ? "inherit" : String(batchWindowSeconds)}
          disabled={disabled}
          onValueChange={(value) =>
            onBatchChange(
              value === "inherit"
                ? undefined
                : (Number(value) as StatusNotifications["batchWindowSeconds"]),
            )
          }
        >
          <Select.Trigger id={`${prefix}-batch-window`} aria-label="Group ordinary updates" />
          <Select.Content>
            {inherits && <Select.Item value="inherit">Inherit shared grouping</Select.Item>}
            <Select.Item value="0">Off</Select.Item>
            <Select.Item value="60">60 seconds</Select.Item>
            <Select.Item value="300">300 seconds</Select.Item>
            <Select.Item value="900">900 seconds</Select.Item>
          </Select.Content>
        </Select.Root>
      </label>
      {batchWindowSeconds === undefined && (
        <Prose size="2">
          Shared grouping:{" "}
          {inheritedBatchWindowSeconds ? `${inheritedBatchWindowSeconds} seconds` : "off"}.
        </Prose>
      )}
      <Prose size="2">
        Outside quiet hours, new incidents, severity escalations, and confirmed recoveries send
        immediately. Ordinary updates use a fixed window that later updates do not extend.
      </Prose>
    </Panel>
  )
}
