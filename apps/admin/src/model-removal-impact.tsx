import { Code } from "@radix-ui/themes"
import type { Policy, Selection } from "./api.js"
import { modelRemovalImpact } from "./provider-policy.js"
import { Prose } from "./surfaces.js"

const list = (value: string[] | null) =>
  value === null ? "Inherit" : value.join(", ") || "None (empty list)"
const selection = (
  value: Pick<Selection, "models" | "model" | "thinking"> | null,
  shared: boolean,
) =>
  value
    ? `Allowed models: ${value.models === null && shared ? "None (null selection)" : list(value.models)}; Model: ${value.model ?? (shared ? "Not configured" : "Inherit")}; Thinking: ${value.thinking ?? (shared ? "off (no shared setting)" : "Inherit")}`
    : "No explicit entry (inherit)"

/** Read-only review of the actual staged policy; no directory or remote requests. */
export function ModelRemovalImpact({ before, after }: { before: Policy; after: Policy }) {
  const impact = modelRemovalImpact(before, after)
  if (!impact.removed.length && !impact.sharedChanged && !impact.chats.length) return null
  const rows = [...(impact.sharedChanged ? [impact.shared] : []), ...impact.chats]
  return (
    <section aria-label="Model removal impact" className="settings-stack">
      <strong>Model configuration impact</strong>
      {impact.removed.length > 0 && (
        <Prose>Removed availability: {impact.removed.join(", ")}</Prose>
      )}
      <Prose>
        Global allowed models: {list(impact.global.before)} → {list(impact.global.after)}
      </Prose>
      {rows.map((row) => (
        <div key={row.scope} className="provider-impact-row">
          <strong>
            {row.scope}
            {"enabled" in row && !row.enabled ? " (disabled)" : ""}
          </strong>
          <Prose>Before — {selection(row.before, !("id" in row))}</Prose>
          <Prose>After — {selection(row.after, !("id" in row))}</Prose>
          <Prose>
            Effective allowed models: {list(row.effectiveBefore.models)} →{" "}
            {list(row.effectiveAfter.models)}
          </Prose>
          <Prose>
            Effective model: <Code>{row.effectiveBefore.model ?? "Not configured"}</Code> →{" "}
            <Code>{row.effectiveAfter.model ?? "Not configured"}</Code>.
            {"id" in row && row.after?.model === null
              ? " Result inherits the shared model, subject to this chat's allowed models."
              : ""}{" "}
            Effective thinking: {row.effectiveBefore.thinking} → {row.effectiveAfter.thinking}.
          </Prose>
        </div>
      ))}
      <Prose>
        All affected explicit policy entries are included, including disabled chats. Other
        inheriting chats are not counted; their complete population is not known here.
      </Prose>
      <Prose>
        Restoring availability does not restore removed allowed-model selections, model choices, or
        thinking levels. Discard the policy draft to undo an unsaved removal.
      </Prose>
      <Prose>
        GitHub replies use the shared model. Shared effective model:{" "}
        {impact.shared.effectiveBefore.model ?? "Not configured"} →{" "}
        {impact.shared.effectiveAfter.model ?? "Not configured"}. Worker and pending outbox effects
        are unknown; no jobs were inspected.
      </Prose>
    </section>
  )
}
