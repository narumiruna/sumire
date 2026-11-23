import { Badge } from "@react-spectrum/s2/Badge"
import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { type ComponentRef, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { FocusScope } from "react-aria/FocusScope"
import { Overlay } from "react-aria/Overlay"
import { useModalOverlay } from "react-aria/useModalOverlay"
import { useOverlayTriggerState } from "react-stately/useOverlayTriggerState"
import type { Snapshot } from "./api.js"
import { t } from "./i18n.js"
import { type EditorTarget, type Page, pageLabel } from "./navigation.js"
import type { PolicyChange } from "./policy-changes.js"
import { countText } from "./status-text.js"
import "./save-status.css"

const reviewBackdrop = style({ backgroundColor: "transparent-black-500" })
const reviewSurface = style({
  backgroundColor: "layer-2",
  borderRadius: "xl",
  boxShadow: "elevated",
  color: "body",
  font: "body",
})
const reviewHeading = style({ font: "heading-lg" })

type Props = {
  quiet?: boolean
  snapshot: Snapshot
  entries: PolicyChange[]
  changeCount: number
  modelReview?: { before: string | null; after: string | null; added: string[] }
  removalReview?: ReactNode
  runtimePending?: boolean
  unfinished: { label: string; target: EditorTarget }[]
  openEditor(target: EditorTarget): void
  reviewOpen: boolean
  onReviewOpenChange(open: boolean): void
  dirty: boolean
  busy: boolean
  localPending: boolean
  mcpDirty: boolean
  providerPending: boolean
  navigate(page: Page): void
  apply(): void
  retry(): void
  discard(): void
  recover?(): void
}

export function SaveStatus({
  quiet = false,
  snapshot,
  entries,
  changeCount,
  modelReview,
  removalReview,
  runtimePending = false,
  unfinished,
  openEditor,
  reviewOpen,
  onReviewOpenChange: setReviewOpen,
  dirty,
  busy,
  localPending,
  mcpDirty,
  providerPending,
  navigate,
  apply,
  retry,
  discard,
  recover,
}: Props) {
  const ref = useRef<HTMLElement>(null)
  const pending =
    dirty || localPending || mcpDirty || providerPending || runtimePending || Boolean(recover)
  const scopes = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.targets.map((target) =>
          target.chat ? t("save.scopeChat", { id: target.chat }) : pageLabel(target.page),
        ),
      ),
    ),
  ]
  const reviewId = useId()
  const reviewRef = useRef<HTMLDivElement>(null)
  const reviewTrigger = useRef<ComponentRef<typeof Button>>(null)
  const statusRef = useRef<HTMLElement>(null)
  const returnFocus = useRef(false)
  const reviewState = useOverlayTriggerState({
    isOpen: reviewOpen,
    onOpenChange: (open) => {
      // Only Cancel and Escape use the overlay's close action.
      returnFocus.current = !open
      setReviewOpen(open)
    },
  })
  const { modalProps, underlayProps } = useModalOverlay({}, reviewState, reviewRef)
  useEffect(() => {
    if (reviewOpen || !returnFocus.current) return
    returnFocus.current = false
    // An external entry point (e.g. direct approval) still returns to the global review action.
    const trigger = reviewTrigger.current?.UNSAFE_getDOMNode()
    if (
      trigger &&
      !trigger.disabled &&
      trigger.checkVisibility({ visibilityProperty: true }) &&
      !trigger.closest('[inert], [aria-hidden="true"]')
    ) {
      trigger.focus()
    } else {
      statusRef.current?.focus()
    }
  }, [reviewOpen])
  useEffect(() => {
    const bar = ref.current
    if (!pending || !bar) return
    const resize = () => {
      // Keep the fixed changes bar within one quarter of the viewport, including CSS zoom.
      const zoom = bar.getBoundingClientRect().width / bar.offsetWidth || 1
      bar.style.maxHeight = `${window.innerHeight / zoom / 4}px`
      document.documentElement.style.setProperty(
        "--changes-bar-height",
        `${bar.offsetHeight + 20}px`,
      )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(bar)
    window.addEventListener("resize", resize)
    let keyboardFocus = true
    const onPointer = () => {
      keyboardFocus = false
    }
    const onKey = () => {
      keyboardFocus = true
    }
    const revealFocus = (event: FocusEvent) => {
      const target = event.target
      if (
        !keyboardFocus ||
        !(target instanceof HTMLElement) ||
        !target.closest("main") ||
        bar.contains(target)
      )
        return
      if (target.getBoundingClientRect().bottom > bar.getBoundingClientRect().top)
        target.scrollIntoView({ block: "center" })
    }
    document.addEventListener("focusin", revealFocus)
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onKey, true)
    resize()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", resize)
      document.removeEventListener("focusin", revealFocus)
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onKey, true)
      document.documentElement.style.removeProperty("--changes-bar-height")
    }
  }, [pending])
  const applied = snapshot.status === "applied" && snapshot.revision === snapshot.applied
  const compact =
    applied &&
    !dirty &&
    !busy &&
    !localPending &&
    !mcpDirty &&
    !providerPending &&
    !runtimePending &&
    !recover
  const foldSaved = quiet && applied && !busy && !recover
  const [notify, setNotify] = useState(false)
  const previousBusy = useRef(busy)
  useEffect(() => {
    const finished = previousBusy.current && !busy
    previousBusy.current = busy
    if (!quiet || !compact || !finished) return
    setNotify(true)
    const timer = window.setTimeout(() => setNotify(false), 4500)
    return () => {
      window.clearTimeout(timer)
      setNotify(false)
    }
  }, [quiet, compact, busy])
  const reviewEditor = (target: EditorTarget) => {
    setReviewOpen(false)
    openEditor(target)
  }
  const applicationStatus = (
    <div className="application-status" id="application-status" tabIndex={-1}>
      {!compact && <span className="status-scope">{t("save.configuration")}</span>}
      <span role="status" className="save-application-message" data-saved={applied && !recover}>
        {recover
          ? t("save.reviewNeeded")
          : snapshot.status === "failed"
            ? t("save.applyFailed")
            : !applied
              ? t("save.applyPending")
              : compact
                ? t("save.applied")
                : t("save.revisionApplied")}
      </span>
      <details>
        <summary>{t("save.revisions")}</summary>
        {t("save.revisionValues", {
          saved: snapshot.revision,
          applied: snapshot.applied,
          status: snapshot.status,
        })}
      </details>
      {!applied && (
        <Button
          variant="secondary"
          fillStyle="outline"
          isDisabled={busy || dirty || localPending || Boolean(recover)}
          onPress={retry}
        >
          {t("save.retry")}
        </Button>
      )}
      {busy && (
        <p className="prose" role="status">
          {t("save.operation")}
        </p>
      )}
    </div>
  )
  return (
    <>
      <section
        ref={statusRef}
        id="save-status"
        tabIndex={-1}
        aria-label={t("save.status")}
        className="save-status"
        data-pending={dirty}
        data-compact={compact}
        data-quiet={quiet}
        data-folded={foldSaved}
      >
        {foldSaved ? (
          notify && compact ? (
            <div className="settings-saved-toast">{applicationStatus}</div>
          ) : (
            <details className="saved-settings-details" id="saved-settings-details" tabIndex={-1}>
              <summary>{t("save.savedDetails")}</summary>
              {applicationStatus}
            </details>
          )
        ) : (
          applicationStatus
        )}
        {pending && (
          <section ref={ref} className="changes-bar" aria-label={t("save.pending")}>
            <div className="save-status-line">
              <div role="status" className="save-pending-message">
                <Badge variant="notice" fillStyle="subtle">
                  {dirty
                    ? countText(changeCount, "unsaved change")
                    : recover
                      ? t("save.outcomeReview")
                      : t("save.unsubmitted")}
                </Badge>
              </div>
              {dirty && <span>{t("save.draft")}</span>}
            </div>
            {dirty && (
              <p className="prose policy-save-scopes">
                {t("save.scopes", { scopes: scopes.join(" · ") || t("save.settings") })}
              </p>
            )}
            {(mcpDirty || providerPending || runtimePending || unfinished.length > 0) && (
              <div className="save-scopes">
                {mcpDirty && (
                  <Button
                    variant="secondary"
                    UNSAFE_className="navigation-control"
                    onPress={() => openEditor({ page: "MCP connections", selector: "#mcp-name" })}
                  >
                    {t("save.mcp")}
                  </Button>
                )}
                {providerPending && (
                  <Button
                    variant="secondary"
                    UNSAFE_className="navigation-control"
                    onPress={() => navigate("Model Providers")}
                  >
                    {t("save.provider")}
                  </Button>
                )}
                {runtimePending && (
                  <Button
                    variant="secondary"
                    onPress={() =>
                      openEditor({ page: "Secrets & variables", selector: "#runtime-add" })
                    }
                  >
                    {t("save.runtime")}
                  </Button>
                )}
                {unfinished.map((editor) => (
                  <div key={editor.label} className="unfinished-editor">
                    <Button variant="secondary" onPress={() => openEditor(editor.target)}>
                      {t("save.continue", { editor: editor.label })}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {recover && (
              <Button
                id="policy-recovery-trigger"
                variant="secondary"
                fillStyle="outline"
                isDisabled={busy}
                onPress={recover}
              >
                {t("save.loadLatest")}
              </Button>
            )}
            {dirty && (
              <div className="save-actions">
                <Button variant="secondary" fillStyle="outline" isDisabled={busy} onPress={discard}>
                  {t("save.discard")}
                </Button>
                <Button
                  ref={reviewTrigger}
                  variant="accent"
                  aria-haspopup="dialog"
                  aria-expanded={reviewOpen}
                  aria-controls={reviewOpen ? reviewId : undefined}
                  isDisabled={busy || localPending || Boolean(recover)}
                  onPress={reviewState.open}
                >
                  {t("save.review")}
                </Button>
              </div>
            )}
          </section>
        )}
      </section>
      {reviewOpen && (
        // Editor and recovery actions own their next focus target, so do not restore automatically.
        <Overlay disableFocusManagement>
          <div className={`save-review-underlay ${reviewBackdrop}`} {...underlayProps}>
            <FocusScope contain>
              <div
                {...modalProps}
                ref={reviewRef}
                id={reviewId}
                className={`save-review-dialog ${reviewSurface}`}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={`${reviewId}-title`}
                aria-describedby={`${reviewId}-description`}
              >
                <div className="save-review-content">
                  <h2 id={`${reviewId}-title`} className={reviewHeading}>
                    {t("save.confirm")}
                  </h2>
                  <p id={`${reviewId}-description`}>{t("save.confirmHelp")}</p>
                  {modelReview && (
                    <section aria-label={t("save.modelChange")}>
                      <p className="prose">
                        {t("save.modelBeforeAfter", {
                          before: modelReview.before ?? t("save.notConfigured"),
                          after: modelReview.after ?? t("save.notConfigured"),
                        })}
                      </p>
                      {modelReview.added.map((ref) => (
                        <p className="prose" key={ref}>
                          {t("save.addModel", { model: ref })}
                        </p>
                      ))}
                    </section>
                  )}
                  {removalReview}
                  <ul aria-label={t("save.changes")} className="settings-review-list">
                    {entries.map((entry) => (
                      <li key={entry.label}>
                        <p className="prose">{entry.label}</p>
                        <div className="save-review-targets">
                          {entry.targets
                            .filter(
                              (target, index, targets) =>
                                targets.findIndex(
                                  (other) => JSON.stringify(other) === JSON.stringify(target),
                                ) === index,
                            )
                            .map((target) => (
                              <Button
                                key={JSON.stringify(target)}
                                variant="secondary"
                                size="S"
                                onPress={() => reviewEditor(target)}
                              >
                                {t("save.reviewScope", {
                                  scope: target.chat
                                    ? t("save.reviewChat", { id: target.chat })
                                    : pageLabel(target.page),
                                })}
                              </Button>
                            ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {unfinished.map((editor) => (
                    <p key={editor.label} className="prose" role="alert">
                      {t("save.finish", { editor: editor.label })}{" "}
                      <Button variant="secondary" onPress={() => reviewEditor(editor.target)}>
                        {t("save.continue", { editor: editor.label })}
                      </Button>
                    </p>
                  ))}
                </div>
                <div className="save-review-actions">
                  <Button
                    variant="secondary"
                    fillStyle="outline"
                    autoFocus
                    onPress={reviewState.close}
                  >
                    {t("save.cancel")}
                  </Button>
                  {recover && (
                    <Button
                      variant="secondary"
                      fillStyle="outline"
                      isDisabled={busy}
                      onPress={() => {
                        setReviewOpen(false)
                        recover()
                      }}
                    >
                      {t("save.loadLatest")}
                    </Button>
                  )}
                  <Button
                    variant="accent"
                    isDisabled={busy || localPending || !dirty || Boolean(recover)}
                    onPress={() => {
                      apply()
                      setReviewOpen(false)
                    }}
                  >
                    {t("save.save")}
                  </Button>
                </div>
              </div>
            </FocusScope>
          </div>
        </Overlay>
      )}
    </>
  )
}
