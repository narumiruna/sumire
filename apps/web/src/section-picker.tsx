import ChevronDown from "@react-spectrum/s2/icons/ChevronDown"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { type ReactNode, useContext, useEffect, useState } from "react"
import { Button } from "react-aria-components/Button"
import { ListBox, ListBoxItem, type ListBoxItemProps } from "react-aria-components/ListBox"
import { Popover } from "react-aria-components/Popover"
import { Select, SelectValue } from "react-aria-components/Select"
import { SectionActive } from "./sections.js"
import "./section-picker.css"

const tokens = style({
  font: "ui-lg",
  "--picker-text": { type: "color", value: "neutral" },
  "--picker-surface": { type: "backgroundColor", value: "layer-2" },
  "--picker-border": { type: "borderColor", value: "gray-500" },
  "--picker-hover": { type: "backgroundColor", value: "gray-200" },
  "--picker-focus": { type: "outlineColor", value: "focus-ring" },
  "--picker-selected": { type: "backgroundColor", value: "accent-subtle" },
  "--picker-radius": { type: "borderRadius", value: "default" },
})

export function SectionPicker({
  children,
  value,
  onValueChange,
  disabled,
  id,
  title,
  placeholder,
  "aria-label": label,
  "aria-describedby": description,
}: {
  children: ReactNode
  value: string | undefined
  onValueChange(value: string): void
  disabled?: boolean
  id?: string
  title?: string
  placeholder?: string
  "aria-label": string
  "aria-describedby"?: string
}) {
  const active = useContext(SectionActive)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])
  // Spectrum Picker does not expose the existing description on its trigger.
  return (
    <Select
      id={id}
      aria-label={label}
      aria-describedby={description}
      value={value || null}
      onChange={(key) => {
        if (typeof key === "string" && key !== value) onValueChange(key)
      }}
      isDisabled={disabled}
      isOpen={open && active}
      onOpenChange={(next) => setOpen(active && next)}
      placeholder={placeholder}
      className="section-picker"
    >
      <Button
        className={`section-picker-trigger ${tokens}`}
        render={(props) => (
          <button
            {...props}
            role="combobox"
            aria-expanded={open && active}
            aria-label={label}
            aria-labelledby={undefined}
            title={title}
          />
        )}
      >
        <SelectValue />
        <ChevronDown />
      </Button>
      <Popover className={`section-picker-popup ${tokens}`}>
        <ListBox className="section-picker-options">{children}</ListBox>
      </Popover>
    </Select>
  )
}

export function PickerOption(props: ListBoxItemProps) {
  return <ListBoxItem {...props} className="section-picker-option" />
}
