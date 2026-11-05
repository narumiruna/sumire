import { AlertDialog, Badge, Button, Flex } from "@radix-ui/themes"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { Snapshot } from "./api.js"
import { t } from "./i18n.js"
import { type EditorTarget, type Page, pageLabel } from "./navigation.js"
import type { PolicyChange } from "./policy-changes.js"
import { countText } from "./status-text.js"
import { Prose } from "./surfaces.js"

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
  const navigating = useRef(false)
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
    navigating.current = true
    setReviewOpen(false)
    openEditor(target)
  }
  const applicationStatus = (
    <div className="application-status" id="application-status" tabIndex={-1}>
      {!compact && <span className="status-scope">{t("save.configuration")}</span>}
      <Badge
        role="status"
        color={applied && !recover ? "gray" : "orange"}
        data-saved={applied && !recover}
      >
        {recover
          ? t("save.reviewNeeded")
          : snapshot.status === "failed"
            ? t("save.applyFailed")
            : !applied
              ? t("save.applyPending")
              : compact
                ? t("save.applied")
                : t("save.revisionApplied")}
      </Badge>
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
          variant="outline"
          disabled={busy || dirty || localPending || Boolean(recover)}
          onClick={retry}
        >
          {t("save.retry")}
        </Button>
      )}
      {busy && (
        <Prose size="2" role="status">
          {t("save.operation")}
        </Prose>
      )}
    </div>
  )
  return (
    <AlertDialog.Root open={reviewOpen} onOpenChange={setReviewOpen}>
      <section
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
              <Badge role="status" color="orange">
                {dirty
                  ? countText(changeCount, "unsaved change")
                  : recover
                    ? t("save.outcomeReview")
                    : t("save.unsubmitted")}
              </Badge>
              {dirty && <span>{t("save.draft")}</span>}
            </div>
            {dirty && (
              <Prose size="2" className="policy-save-scopes">
                {t("save.scopes", { scopes: scopes.join(" · ") || t("save.settings") })}
              </Prose>
            )}
            {(mcpDirty || providerPending || runtimePending || unfinished.length > 0) && (
              <div className="save-scopes">
                {mcpDirty && (
                  <Button
                    variant="surface"
                    className="navigation-control"
                    onClick={() => openEditor({ page: "MCP connections", selector: "#mcp-name" })}
                  >
                    {t("save.mcp")}
                  </Button>
                )}
                {providerPending && (
                  <Button
                    variant="surface"
                    className="navigation-control"
                    onClick={() => navigate("Model Providers")}
                  >
                    {t("save.provider")}
                  </Button>
                )}
                {runtimePending && (
                  <Button
                    variant="surface"
                    onClick={() =>
                      openEditor({ page: "Secrets & variables", selector: "#runtime-add" })
                    }
                  >
                    {t("save.runtime")}
                  </Button>
                )}
                {unfinished.map((editor) => (
                  <div key={editor.label} className="unfinished-editor">
                    <Button variant="soft" onClick={() => openEditor(editor.target)}>
                      {t("save.continue", { editor: editor.label })}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {recover && (
              <Button
                id="policy-recovery-trigger"
                variant="outline"
                disabled={busy}
                onClick={recover}
              >
                {t("save.loadLatest")}
              </Button>
            )}
            {dirty && (
              <div className="save-actions">
                <Button variant="outline" disabled={busy} onClick={discard}>
                  {t("save.discard")}
                </Button>
                <AlertDialog.Trigger>
                  <Button disabled={busy || localPending || Boolean(recover)}>
                    {t("save.review")}
                  </Button>
                </AlertDialog.Trigger>
              </div>
            )}
          </section>
        )}
      </section>
      <AlertDialog.Content
        onCloseAutoFocus={(event) => {
          if (navigating.current) {
            event.preventDefault()
            navigating.current = false
          }
        }}
      >
        <AlertDialog.Title>{t("save.confirm")}</AlertDialog.Title>
        <AlertDialog.Description>{t("save.confirmHelp")}</AlertDialog.Description>
        {modelReview && (
          <section aria-label={t("save.modelChange")}>
            <Prose size="2">
              {t("save.modelBeforeAfter", {
                before: modelReview.before ?? t("save.notConfigured"),
                after: modelReview.after ?? t("save.notConfigured"),
              })}
            </Prose>
            {modelReview.added.map((ref) => (
              <Prose size="2" key={ref}>
                {t("save.addModel", { model: ref })}
              </Prose>
            ))}
          </section>
        )}
        {removalReview}
        <ul aria-label={t("save.changes")} className="settings-review-list">
          {entries.map((entry) => (
            <li key={entry.label}>
              <Prose size="2">{entry.label}</Prose>
              <Flex gap="2" wrap="wrap">
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
                      variant="ghost"
                      onClick={() => reviewEditor(target)}
                    >
                      {t("save.reviewScope", {
                        scope: target.chat
                          ? t("save.reviewChat", { id: target.chat })
                          : pageLabel(target.page),
                      })}
                    </Button>
                  ))}
              </Flex>
            </li>
          ))}
        </ul>
        {unfinished.map((editor) => (
          <Prose key={editor.label} size="2" role="alert">
            {t("save.finish", { editor: editor.label })}{" "}
            <Button variant="soft" onClick={() => reviewEditor(editor.target)}>
              {t("save.continue", { editor: editor.label })}
            </Button>
          </Prose>
        ))}
        <Flex gap="3" mt="4" justify="end" wrap="wrap">
          <AlertDialog.Cancel>
            <Button variant="soft">{t("save.cancel")}</Button>
          </AlertDialog.Cancel>
          {recover && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                navigating.current = true
                setReviewOpen(false)
                recover()
              }}
            >
              {t("save.loadLatest")}
            </Button>
          )}
          <AlertDialog.Action>
            <Button disabled={busy || localPending || !dirty || Boolean(recover)} onClick={apply}>
              {t("save.save")}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}
