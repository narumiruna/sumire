import { AlertDialog, Badge, Button, Flex } from "@radix-ui/themes"
import { useEffect, useRef } from "react"
import type { Snapshot } from "./api.js"
import { type EditorTarget, type Page, pageLabel } from "./navigation.js"
import type { PolicyChange } from "./policy-changes.js"
import { countText } from "./status-text.js"
import { Prose } from "./surfaces.js"

type Props = {
  snapshot: Snapshot
  entries: PolicyChange[]
  changeCount: number
  modelReview?: { before: string | null; after: string | null; added: string[] }
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
}

export function SaveStatus({
  snapshot,
  entries,
  changeCount,
  modelReview,
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
}: Props) {
  const ref = useRef<HTMLElement>(null)
  const pending = dirty || localPending || mcpDirty || providerPending
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
  const compact = applied && !dirty && !busy && !localPending && !mcpDirty && !providerPending
  const reviewEditor = (target: EditorTarget) => {
    navigating.current = true
    setReviewOpen(false)
    openEditor(target)
  }
  return (
    <AlertDialog.Root open={reviewOpen} onOpenChange={setReviewOpen}>
      <section
        id="save-status"
        tabIndex={-1}
        aria-label="Save status and pending changes"
        className="save-status"
        data-pending={dirty}
        data-compact={compact}
      >
        <div className="application-status" id="application-status" tabIndex={-1}>
          <Badge role="status" color={applied ? "gray" : "orange"} data-saved={applied}>
            {snapshot.status === "failed"
              ? "Saved, but application failed. Retry application."
              : !applied
                ? "Saved changes are waiting to apply."
                : compact
                  ? "Settings saved and applied."
                  : "Saved revision applied."}
          </Badge>
          <details>
            <summary>Revision details</summary>
            Saved {snapshot.revision} · Applied {snapshot.applied} · {snapshot.status}
          </details>
          {!applied && (
            <Button variant="outline" disabled={busy || dirty || localPending} onClick={retry}>
              Retry application
            </Button>
          )}
          {busy && (
            <Prose size="2" role="status">
              Operation in progress…
            </Prose>
          )}
        </div>
        {pending && (
          <section ref={ref} className="changes-bar" aria-label="Pending changes">
            <div className="save-status-line">
              <Badge role="status" color="orange">
                {dirty ? countText(changeCount, "unsaved change") : "Unsubmitted editor draft"}
              </Badge>
              {dirty && <span>Settings draft</span>}
            </div>
            {(mcpDirty || providerPending || unfinished.length > 0) && (
              <div className="save-scopes">
                {mcpDirty && (
                  <Button
                    variant="surface"
                    className="navigation-control"
                    onClick={() => openEditor({ page: "MCP connections", selector: "#mcp-name" })}
                  >
                    MCP: Unsaved configuration
                  </Button>
                )}
                {providerPending && (
                  <Button
                    variant="surface"
                    className="navigation-control"
                    onClick={() => navigate("Model Providers")}
                  >
                    Provider: Unsaved selection or authentication
                  </Button>
                )}
                {unfinished.map((editor) => (
                  <div key={editor.label} className="unfinished-editor">
                    <Button variant="soft" onClick={() => openEditor(editor.target)}>
                      Continue editing: {editor.label}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {dirty && (
              <div className="save-actions">
                <Button variant="outline" disabled={busy} onClick={discard}>
                  Discard settings changes
                </Button>
                <AlertDialog.Trigger>
                  <Button disabled={busy || localPending}>Review and save changes</Button>
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
        <AlertDialog.Title>Save settings changes?</AlertDialog.Title>
        <AlertDialog.Description>
          Save the changes below across Chats, Chat access, Shared defaults, tools, skills, and
          custom endpoints. Connection drafts, provider model additions, and authentication have
          separate save actions. Active work will be cancelled. Revoked permissions cannot undo
          completed external actions.
        </AlertDialog.Description>
        {modelReview && (
          <section aria-label="Shared model change">
            <Prose size="2">
              Model: {modelReview.before ?? "Not configured"} →{" "}
              {modelReview.after ?? "Not configured"}
            </Prose>
            {modelReview.added.map((ref) => (
              <Prose size="2" key={ref}>
                Add shared allowed model: {ref}
              </Prose>
            ))}
          </section>
        )}
        <ul aria-label="Settings changes to save" className="settings-review-list">
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
                      Review {target.chat ? `chat ${target.chat}` : pageLabel(target.page)}
                    </Button>
                  ))}
              </Flex>
            </li>
          ))}
        </ul>
        {unfinished.map((editor) => (
          <Prose key={editor.label} size="2" role="alert">
            Finish or clear {editor.label} before saving.{" "}
            <Button variant="soft" onClick={() => reviewEditor(editor.target)}>
              Continue editing: {editor.label}
            </Button>
          </Prose>
        ))}
        <Flex gap="3" mt="4" justify="end" wrap="wrap">
          <AlertDialog.Cancel>
            <Button variant="soft">Cancel</Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button disabled={busy || localPending || !dirty} onClick={apply}>
              Save changes
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}
