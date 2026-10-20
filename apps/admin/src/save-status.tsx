import { AlertDialog, Button, Flex, Spinner } from "@radix-ui/themes"
import { useEffect, useRef } from "react"
import type { Snapshot } from "./api.js"
import type { Page } from "./navigation.js"
import { countText } from "./status-text.js"
import { Prose, StatusBadge } from "./surfaces.js"

type Props = {
  snapshot: Snapshot
  changes: string[]
  dirty: boolean
  busy: boolean
  localPending: boolean
  mcpDirty: boolean
  providerPending: boolean
  showHelp: boolean
  navigate(page: Page): void
  apply(): void
  retry(): void
  discard(): void
}

export function SaveStatus({
  snapshot,
  changes,
  dirty,
  busy,
  localPending,
  mcpDirty,
  providerPending,
  showHelp,
  navigate,
  apply,
  retry,
  discard,
}: Props) {
  const ref = useRef<HTMLElement>(null)
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
  const status = busy
    ? "pending"
    : snapshot.status === "failed"
      ? "failed"
      : applied && !dirty
        ? "approved"
        : "pending"
  return (
    <section
      ref={ref}
      id="save-status"
      aria-label="Save status and pending changes"
      className={`save-status ${dirty ? "pending-bar" : "saved-state"}`}
      data-pending={dirty}
      data-status={status}
    >
      <div className="save-status-line">
        <StatusBadge role="status" data-saved={applied && !dirty && !busy} status={status}>
          {busy && <Spinner aria-hidden />}
          {busy
            ? "Saving or checking…"
            : snapshot.status === "failed"
              ? "Saved, but application failed. Retry application."
              : !applied
                ? "Saved changes are waiting to apply."
                : dirty
                  ? countText(changes.length, "pending policy change")
                  : "Saved revision applied."}
        </StatusBadge>
        <details>
          <summary>Revision details</summary>
          Saved <span className="numeric">{snapshot.revision}</span> · Applied{" "}
          <span className="numeric">{snapshot.applied}</span> · {snapshot.status}
        </details>
        {showHelp && (
          <details className="save-help">
            <summary>How saving works</summary>
            <Prose size="2">
              Apply policy changes saves chat overrides, access lists, defaults, global
              availability, and custom endpoint policy edits across sections. MCP connections,
              provider model selection, and authentication use separate actions. Switching sections
              keeps drafts. Defaults do not grant access.
            </Prose>
          </details>
        )}
        {dirty && (
          <details>
            <summary>Review pending policy changes</summary>
            <ul>
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="save-scopes">
        <Button
          color="gray"
          variant="ghost"
          className="navigation-control"
          onClick={() => navigate("Access")}
        >
          Policy: {dirty ? countText(changes.length, "change") : "No changes"}
        </Button>
        <Button
          color="gray"
          variant="ghost"
          className="navigation-control"
          onClick={() => navigate("MCP connections")}
        >
          {mcpDirty ? "MCP: Unsaved configuration" : "MCP: No browser edits"}
        </Button>
        <Button
          color="gray"
          variant="ghost"
          className="navigation-control"
          onClick={() => navigate("Model Providers")}
        >
          {providerPending
            ? "Provider: Unsaved selection or authentication"
            : "Provider: No browser edits"}
        </Button>
      </div>
      {localPending && (
        <Prose size="2">
          <span>Unstaged editor input</span> · Save unavailable: finish or clear this input.
        </Prose>
      )}
      {(dirty || !applied) && (
        <div className="save-actions">
          {dirty && (
            <Button color="gray" variant="soft" disabled={busy} onClick={discard}>
              Discard policy changes
            </Button>
          )}
          {!applied && (
            <Button
              variant="soft"
              color="gray"
              disabled={busy || dirty || localPending}
              onClick={retry}
            >
              Retry application
            </Button>
          )}
          {dirty && (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button disabled={busy || localPending}>Apply policy changes</Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content>
                <AlertDialog.Title>Apply configuration changes?</AlertDialog.Title>
                <AlertDialog.Description>
                  Save all pending chat, access, shared default, global availability, and custom
                  endpoint policy changes across sections. MCP connection edits and authentication
                  are separate. Active work will be cancelled. Revoked permissions cannot undo
                  completed external actions.
                </AlertDialog.Description>
                <Flex gap="3" mt="4" justify="end">
                  <AlertDialog.Cancel>
                    <Button color="gray" variant="soft">
                      Cancel
                    </Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action>
                    <Button onClick={apply}>Save and apply</Button>
                  </AlertDialog.Action>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          )}
        </div>
      )}
    </section>
  )
}
