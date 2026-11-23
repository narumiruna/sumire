import { type ComponentProps, createContext } from "react"
import { SectionErrorBoundary } from "./section-error-boundary.js"

export const SectionActive = createContext(true)

/** Keep editors mounted for drafts, but close their portaled selectors when inactive. */
export function EditorSection({
  active,
  children,
  className,
  ...props
}: ComponentProps<"section"> & { active: boolean }) {
  return (
    <SectionActive value={active}>
      <section
        {...props}
        className={["admin-page", "page-content", className].filter(Boolean).join(" ")}
        hidden={!active}
      >
        <SectionErrorBoundary label={props["aria-label"] ?? "Section"}>
          {children}
        </SectionErrorBoundary>
      </section>
    </SectionActive>
  )
}
