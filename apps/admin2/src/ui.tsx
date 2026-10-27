import type { ReactNode } from "react"

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; value: T }

export function Skeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Placeholder rows have no identity.
        <span key={i} className="skeleton__row" />
      ))}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {children}
    </div>
  )
}

export function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="state state--bad" role="alert">
      <p className="state__title">{message}</p>
      {retry && (
        <button type="button" className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function Chip({
  tone,
  children,
}: {
  tone: "person" | "instrument" | "ok" | "bad" | "quiet"
  children: ReactNode
}) {
  return <span className={`chip chip--${tone}`}>{children}</span>
}

/** A reversible change already ran; offer to put it back. */
export type Undo = { message: string; undo: () => Promise<void> }

export function UndoBar({ value, dismiss }: { value: Undo | undefined; dismiss: () => void }) {
  return (
    <div className="undo" role="status" aria-live="polite">
      {value && (
        <>
          <span>{value.message}</span>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              dismiss()
              void value.undo()
            }}
          >
            Undo
          </button>
        </>
      )}
    </div>
  )
}

const pad = (n: number) => String(n).padStart(2, "0")

export function formatDay(time: number) {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatClock(time: number) {
  const d = new Date(time)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
