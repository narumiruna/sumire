import { useId } from "react"
import "./spectrum-policy.css"

export function Check({
  id: providedId,
  label,
  checked,
  onChange,
  disabled = false,
  visibleLabel,
  describedBy,
  autoFocus,
}: {
  id?: string
  label: string
  visibleLabel?: string
  describedBy?: string
  autoFocus?: boolean
  checked: boolean
  disabled?: boolean
  onChange(value: boolean): void
}) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  return (
    <label className="check" htmlFor={id}>
      <input
        type="checkbox"
        className="policy-check"
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        // biome-ignore lint/a11y/noAutofocus: Move focus inside the dialog the user just opened.
        autoFocus={autoFocus}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {visibleLabel ?? label}
    </label>
  )
}
