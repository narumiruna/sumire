import { Badge, Button, Dialog, Flex, RadioGroup, Text } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import type { Policy, Snapshot } from "./api.js"
import { type RecoveryChoice, recoverPolicy } from "./policy-recovery.js"
import { Prose } from "./surfaces.js"

function valueText(value: unknown) {
  return value === undefined ? "No entry" : JSON.stringify(value, null, 2)
}

export function PolicyRecoveryDialog({
  base,
  draft,
  submitted,
  revision,
  latest,
  failure,
  onCancel,
  onConfirm,
  onReturnFocus,
}: {
  base: Policy
  draft: Policy
  submitted: Policy
  revision: number
  latest: Snapshot
  failure: string
  onCancel(): void
  onConfirm(policy: Policy): void
  onReturnFocus(): void
}) {
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const dialog = content
    const padding = dialog?.parentElement
    if (!dialog || !padding) return
    const resizeContent = () => {
      const root = document.documentElement
      const zoom = root.getBoundingClientRect().width / root.offsetWidth || 1
      const style = getComputedStyle(padding)
      const space = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      dialog.style.maxHeight = `${Math.max(0, innerHeight / zoom - space)}px`
    }
    const observer = new ResizeObserver(resizeContent)
    observer.observe(document.documentElement)
    window.addEventListener("resize", resizeContent)
    resizeContent()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", resizeContent)
    }
  }, [content])
  const [choices, setChoices] = useState<Record<string, RecoveryChoice>>({})
  const recovered = recoverPolicy(base, draft, latest.policy, choices, submitted)
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <Dialog.Content
        ref={setContent}
        maxWidth="720px"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onReturnFocus()
        }}
      >
        <Dialog.Title>Review recovered settings draft</Dialog.Title>
        <Dialog.Description>
          Compare your retained draft with saved revision {latest.revision}. Nothing is saved by
          this step. Confirm the recovered draft, then review and save any remaining changes.
        </Dialog.Description>
        {latest.revision === revision && (
          <Prose role="status">
            The saved revision has not changed. The save failed: {failure}
          </Prose>
        )}
        <Prose size="2">
          Unedited settings keep their latest saved values. Lists, provider configuration, and each
          chat record are replaced as a whole when you choose a draft value. They are not combined.
          In selections, null means inheritance or no shared selection; [] means an explicit empty
          list.
        </Prose>
        <ul className="policy-recovery-changes" aria-label="Recovered settings changes">
          {recovered.changes.map((change) => (
            <li key={change.id}>
              <Text as="p" size="2" weight="bold">
                {change.label}
              </Text>
              <Badge color={change.state === "conflict" ? "orange" : "gray"}>
                {change.state === "saved"
                  ? "Already saved"
                  : change.state === "draft"
                    ? "Draft retained"
                    : "Choose a value"}
              </Badge>
              {change.state === "conflict" && (
                <RadioGroup.Root
                  aria-label={change.label}
                  value={choices[change.id] ?? ""}
                  onValueChange={(choice) =>
                    setChoices((previous) => ({
                      ...previous,
                      [change.id]: choice as RecoveryChoice,
                    }))
                  }
                >
                  <RadioGroup.Item value="saved">Keep saved value</RadioGroup.Item>
                  <RadioGroup.Item value="draft">Use draft value</RadioGroup.Item>
                </RadioGroup.Root>
              )}
              <details>
                <summary>Compare values for {change.label}</summary>
                <Text as="p" size="2">
                  Latest saved value
                </Text>
                <pre className="policy-recovery-value">{valueText(change.saved)}</pre>
                <Text as="p" size="2">
                  Your draft value
                </Text>
                <pre className="policy-recovery-value">{valueText(change.draft)}</pre>
              </details>
            </li>
          ))}
        </ul>
        {!recovered.changes.length && <Prose>No local policy changes remain.</Prose>}
        {recovered.unresolved > 0 && (
          <Prose role="status">Resolve every overlapping change before continuing.</Prose>
        )}
        <Flex gap="3" justify="end" wrap="wrap" mt="4">
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={recovered.unresolved > 0} onClick={() => onConfirm(recovered.policy)}>
            Use recovered draft
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
