import { Badge, Button, Dialog, Flex, RadioGroup, Text } from "@radix-ui/themes"
import { useEffect, useState } from "react"
import type { Policy, Snapshot } from "./api.js"
import { t } from "./i18n.js"
import { type RecoveryChoice, recoverPolicy } from "./policy-recovery.js"
import { Prose } from "./surfaces.js"

function valueText(value: unknown) {
  return value === undefined ? t("recovery.noEntry") : JSON.stringify(value, null, 2)
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
        <Dialog.Title>{t("recovery.title")}</Dialog.Title>
        <Dialog.Description>
          {t("recovery.description", { revision: latest.revision })}
        </Dialog.Description>
        {latest.revision === revision && (
          <Prose role="status">{t("recovery.failed", { failure })}</Prose>
        )}
        <Prose size="2">{t("recovery.help")}</Prose>
        <ul className="policy-recovery-changes" aria-label={t("recovery.changes")}>
          {recovered.changes.map((change) => (
            <li key={change.id}>
              <Text as="p" size="2" weight="bold">
                {change.label}
              </Text>
              <Badge color={change.state === "conflict" ? "orange" : "gray"}>
                {change.state === "saved"
                  ? t("recovery.saved")
                  : change.state === "draft"
                    ? t("recovery.draft")
                    : t("recovery.choose")}
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
                  <RadioGroup.Item value="saved">{t("recovery.keepSaved")}</RadioGroup.Item>
                  <RadioGroup.Item value="draft">{t("recovery.useDraft")}</RadioGroup.Item>
                </RadioGroup.Root>
              )}
              <details>
                <summary>{t("recovery.compare", { label: change.label })}</summary>
                <Text as="p" size="2">
                  {t("recovery.latest")}
                </Text>
                <pre className="policy-recovery-value">{valueText(change.saved)}</pre>
                <Text as="p" size="2">
                  {t("recovery.yours")}
                </Text>
                <pre className="policy-recovery-value">{valueText(change.draft)}</pre>
              </details>
            </li>
          ))}
        </ul>
        {!recovered.changes.length && <Prose>{t("recovery.none")}</Prose>}
        {recovered.unresolved > 0 && <Prose role="status">{t("recovery.resolve")}</Prose>}
        <Flex gap="3" justify="end" wrap="wrap" mt="4">
          <Button variant="soft" onClick={onCancel}>
            {t("recovery.cancel")}
          </Button>
          <Button disabled={recovered.unresolved > 0} onClick={() => onConfirm(recovered.policy)}>
            {t("recovery.confirm")}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
