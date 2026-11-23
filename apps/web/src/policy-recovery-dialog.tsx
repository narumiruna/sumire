import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useEffect, useId, useRef, useState } from "react"
import type { Policy, Snapshot } from "./api.js"
import { t } from "./i18n.js"
import { type RecoveryChoice, recoverPolicy } from "./policy-recovery.js"
import { Prose, StatusLabel } from "./surfaces.js"
import "./spectrum-policy.css"

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
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    const resize = () => {
      const root = document.documentElement
      const zoom = root.getBoundingClientRect().width / root.offsetWidth || 1
      dialog.style.maxHeight = `${Math.max(0, innerHeight / zoom - 24)}px`
    }
    const observer = new ResizeObserver(resize)
    observer.observe(document.documentElement)
    window.addEventListener("resize", resize)
    resize()
    return () => {
      dialog.close()
      observer.disconnect()
      window.removeEventListener("resize", resize)
    }
  }, [])
  const [choices, setChoices] = useState<Record<string, RecoveryChoice>>({})
  const recovered = recoverPolicy(base, draft, latest.policy, choices, submitted)
  const cancel = () => {
    onCancel()
    // The preceding save review may no longer have a mounted invoker.
    requestAnimationFrame(onReturnFocus)
  }
  return (
    <dialog
      ref={ref}
      className={`policy-recovery-dialog ${style({
        backgroundColor: "layer-2",
        color: "body",
        borderRadius: "xl",
        boxShadow: "elevated",
        font: "body-lg",
      })}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault()
        cancel()
      }}
    >
      <h2 id={`${id}-title`} className={style({ font: "heading-lg", margin: 0 })}>
        {t("recovery.title")}
      </h2>
      <Prose id={`${id}-description`}>
        {t("recovery.description", { revision: latest.revision })}
      </Prose>
      {latest.revision === revision && (
        <Prose role="status">{t("recovery.failed", { failure })}</Prose>
      )}
      <Prose>{t("recovery.help")}</Prose>
      <ul className="policy-recovery-changes" aria-label={t("recovery.changes")}>
        {recovered.changes.map((change) => (
          <li key={change.id}>
            <p>
              <strong>{change.label}</strong>
            </p>
            <StatusLabel tone={change.state === "conflict" ? "warning" : "neutral"}>
              {change.state === "saved"
                ? t("recovery.saved")
                : change.state === "draft"
                  ? t("recovery.draft")
                  : t("recovery.choose")}
            </StatusLabel>
            {change.state === "conflict" && (
              <div role="radiogroup" aria-label={change.label} className="policy-recovery-choices">
                {(["saved", "draft"] as const).map((choice) => (
                  <label key={choice}>
                    <input
                      className="policy-check"
                      type="radio"
                      name={`${id}-${change.id}`}
                      checked={choices[change.id] === choice}
                      onChange={() =>
                        setChoices((previous) => ({ ...previous, [change.id]: choice }))
                      }
                    />
                    <span>
                      {t(choice === "saved" ? "recovery.keepSaved" : "recovery.useDraft")}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <details>
              <summary>{t("recovery.compare", { label: change.label })}</summary>
              <Prose>{t("recovery.latest")}</Prose>
              <pre className="policy-recovery-value">{valueText(change.saved)}</pre>
              <Prose>{t("recovery.yours")}</Prose>
              <pre className="policy-recovery-value">{valueText(change.draft)}</pre>
            </details>
          </li>
        ))}
      </ul>
      {!recovered.changes.length && <Prose>{t("recovery.none")}</Prose>}
      {recovered.unresolved > 0 && <Prose role="status">{t("recovery.resolve")}</Prose>}
      <div className="policy-recovery-actions">
        <Button variant="secondary" autoFocus onPress={cancel}>
          {t("recovery.cancel")}
        </Button>
        <Button
          variant="accent"
          isDisabled={recovered.unresolved > 0}
          onPress={() => onConfirm(recovered.policy)}
        >
          {t("recovery.confirm")}
        </Button>
      </div>
    </dialog>
  )
}
