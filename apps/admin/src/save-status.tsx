import { AlertDialog, Badge, Button, Flex } from "@radix-ui/themes"
import { useEffect, useRef } from "react"
import type { Snapshot } from "./api.js"
import { type EditorTarget, type Page, pageLabel } from "./navigation.js"
import type { PolicyChange } from "./policy-changes.js"
import { countText } from "./status-text.js"
import { Prose } from "./surfaces.js"

type Props = {
  snapshot: Snapshot
  changes: string[]
  entries: PolicyChange[]
  unfinished: { label: string; target: EditorTarget }[]
  openEditor(target: EditorTarget): void
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
  entries,
  unfinished,
  openEditor,
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
  const compact = applied && !dirty && !busy && !localPending && !mcpDirty && !providerPending
  return (
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
                  ? countText(changes.length, "pending policy change")
                  : compact
                    ? "All settings saved and applied."
                    : "Saved revision applied."}
        </Badge>
        <details>
          <summary>Revision details</summary>
          Saved {snapshot.revision} · Applied {snapshot.applied} · {snapshot.status}
        </details>
        {showHelp && !compact && (
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
      {!compact && (
        <div className="save-scopes">
          {dirty && (
            <details className="policy-destinations">
              <summary>Policy: {countText(changes.length, "change")}</summary>
              {entries.map((entry) => (
                <div key={entry.label}>
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
                          variant="soft"
                          className="navigation-control"
                          onClick={() => openEditor(target)}
                        >
                          Review {target.chat ? `chat ${target.chat}` : pageLabel(target.page)}
                        </Button>
                      ))}
                  </Flex>
                </div>
              ))}
            </details>
          )}
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
              Discard policy changes
            </Button>
          )}
          {!applied && (
            <Button disabled={busy || dirty || localPending} onClick={retry}>
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
                <ul aria-label="Policy changes to save">
                  {changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                <Flex gap="3" mt="4" justify="end">
                  <AlertDialog.Cancel>
                    <Button variant="soft">Cancel</Button>
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
