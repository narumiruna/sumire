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
  const navigating = useRef(false)
  useEffect(() => {
    const bar = ref.current
    if (!bar) return
    const resize = () =>
      document.documentElement.style.setProperty(
        "--save-status-height",
        `${bar.getBoundingClientRect().height + 20}px`,
      )
    const observer = new ResizeObserver(resize)
    observer.observe(bar)
    resize()
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty("--save-status-height")
    }
  }, [])
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
        ref={ref}
        id="save-status"
        tabIndex={-1}
        aria-label="Save status and pending changes"
        className={`save-status ${dirty ? "pending-bar" : "saved-state"}`}
        data-pending={dirty}
        data-compact={compact}
      >
        <div className="save-status-line">
          <Badge
            role="status"
            data-saved={applied && !dirty && !busy}
            color={applied && !dirty && !busy ? "green" : "orange"}
          >
            {busy
              ? "Saving or checking…"
              : snapshot.status === "failed"
                ? "Saved, but application failed. Retry application."
                : !applied
                  ? "Saved changes are waiting to apply."
                  : dirty
                    ? countText(entries.length, "unsaved change")
                    : compact
                      ? "All settings saved and applied."
                      : "Saved revision applied."}
          </Badge>
          <details>
            <summary>Revision details</summary>
            Saved {snapshot.revision} · Applied {snapshot.applied} · {snapshot.status}
          </details>
        </div>
        {!compact && (
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
                <Prose size="2">Finish or clear input in {editor.label} before saving.</Prose>
                <Button variant="soft" onClick={() => openEditor(editor.target)}>
                  Continue editing: {editor.label}
                </Button>
              </div>
            ))}
          </div>
        )}
        {(dirty || !applied) && (
          <div className="save-actions">
            {dirty && (
              <Button variant="soft" disabled={busy} onClick={discard}>
                Discard settings changes
              </Button>
            )}
            {!applied && (
              <Button disabled={busy || dirty || localPending} onClick={retry}>
                Retry application
              </Button>
            )}
            {dirty && (
              <AlertDialog.Trigger>
                <Button disabled={busy || localPending}>Review and save changes</Button>
              </AlertDialog.Trigger>
            )}
          </div>
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
          custom endpoints. Connection drafts, model selection, and authentication have separate
          save actions. Active work will be cancelled. Revoked permissions cannot undo completed
          external actions.
        </AlertDialog.Description>
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
