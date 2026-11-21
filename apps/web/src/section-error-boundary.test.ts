import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Activity, type AuditEntry } from "./activity.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"

const record: AuditEntry = {
  id: 1,
  time: 1,
  actor: "42",
  operation: "settings.update",
  revision: 1,
  outcome: "saved",
  target: "settings",
}

describe("section error containment", () => {
  it.each([undefined, null, "invalid", Number.NaN, Number.POSITIVE_INFINITY, 9e20])(
    "shows a bounded fallback for malformed audit time %s",
    (time) => {
      const children = createElement(Activity, { entries: [{ ...record, time } as AuditEntry] })
      // Server rendering does not mount error boundaries. Exercise the failing record,
      // then React's error-state transition and the same fallback used in the browser.
      expect(() => renderToStaticMarkup(children)).toThrow()
      const boundary = new SectionErrorBoundary({ label: "Audit history", children })
      boundary.state = SectionErrorBoundary.getDerivedStateFromError()
      const html = renderToStaticMarkup(boundary.render())
      expect(html).toContain('role="alert"')
      expect(html).toContain("Audit history could not be displayed.")
      expect(html).toContain("Other sections remain available.")
      expect(html).toContain("Retry audit history")
      expect(html).not.toContain("settings.update")
    },
  )
  it("renders valid records without a fallback", () => {
    const children = createElement(Activity, { entries: [record] })
    const boundary = new SectionErrorBoundary({ label: "Chat history", children })
    expect(renderToStaticMarkup(boundary.render())).toContain("Settings saved")
    expect(boundary.state.failed).toBe(false)
  })
})
