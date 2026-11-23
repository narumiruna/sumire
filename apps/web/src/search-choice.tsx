import { ActionButton } from "@react-spectrum/s2/ActionButton"
import ChevronDown from "@react-spectrum/s2/icons/ChevronDown"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react"
import { useInteractOutside } from "react-aria/useInteractOutside"
import { useOverlayPosition } from "react-aria/useOverlayPosition"
import { createPortal, flushSync } from "react-dom"
import { t } from "./i18n.js"
import { SectionActive } from "./sections.js"
import "./search-choice.css"

type Option = { id: string; label: string; detail?: string }

const searchStyles = style({
  font: "ui-lg",
  "--search-surface": { type: "backgroundColor", value: "layer-2" },
  "--search-text": { type: "color", value: "body" },
  "--search-border": { type: "borderColor", value: "gray-500" },
  "--search-highlight": { type: "backgroundColor", value: "accent-subtle" },
  "--search-focus": { type: "outlineColor", value: "focus-ring" },
  "--search-radius": { type: "borderRadius", value: "default" },
})

export function SearchChoice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  onChange(value: string): void
}) {
  const sectionActive = useContext(SectionActive)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!sectionActive) setOpen(false)
  }, [sectionActive])
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const overlayOpen = open && sectionActive
  const { overlayProps } = useOverlayPosition({
    targetRef: trigger,
    overlayRef: overlay,
    isOpen: overlayOpen,
    placement: "bottom start",
    offset: 6,
    maxHeight: 400,
  })
  useInteractOutside({
    ref: overlay,
    isDisabled: !overlayOpen,
    onInteractOutside: (event) => {
      if (!(event.target instanceof Node) || !trigger.current?.contains(event.target))
        setOpen(false)
    },
  })
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus({ preventScroll: true })
  }, [])
  const id = useId()
  const displayValue =
    options.find((option) => option.id === value)?.label ??
    (value || t("selection.choose", { label: label.toLowerCase() }))
  const filtered = useMemo(
    () => options.filter((v) => `${v.label} ${v.id}`.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  )
  useEffect(() => {
    if (open && filtered[active])
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [active, filtered, id, open])

  const closeToTrigger = () => {
    setOpen(false)
    if (sectionActive && trigger.current?.checkVisibility()) trigger.current.focus()
  }
  const choose = (key: string) => {
    onChange(key)
    closeToTrigger()
  }
  return (
    <div className="provider-choice">
      <p className={style({ font: "ui-lg", fontWeight: "medium" })}>{label}</p>
      <ActionButton
        ref={(node) => {
          trigger.current = node?.UNSAFE_getDOMNode() ?? null
        }}
        size="XL"
        UNSAFE_className="provider-choice-trigger"
        isDisabled={disabled}
        aria-label={t("selection.choiceValue", { label, value: displayValue })}
        aria-haspopup="dialog"
        aria-expanded={open && sectionActive}
        onPress={() => {
          setOpen((current) => !current)
          setQuery("")
          setActive(0)
        }}
      >
        <span>{displayValue}</span>
        <ChevronDown />
      </ActionButton>
      {overlayOpen &&
        createPortal(
          <div
            {...overlayProps}
            ref={overlay}
            className={`provider-choice-overlay ${searchStyles}`}
            role="dialog"
            aria-label={t("selection.choose", { label: label.toLowerCase() })}
            onBlur={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
                setOpen(false)
            }}
          >
            <input
              type="text"
              ref={focusInput}
              role="combobox"
              aria-label={t("selection.search", { label: label.toLowerCase() })}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={id}
              aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.stopPropagation()
                  // Leave the portal before native Tab advances from the visible trigger.
                  flushSync(closeToTrigger)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  e.stopPropagation()
                  closeToTrigger()
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault()
                  setActive((v) =>
                    Math.max(
                      0,
                      Math.min(filtered.length - 1, v + (e.key === "ArrowDown" ? 1 : -1)),
                    ),
                  )
                } else if (e.key === "Enter" && filtered[active]) {
                  e.preventDefault()
                  choose(filtered[active].id)
                }
              }}
            />
            <div
              id={id}
              role="listbox"
              aria-label={t("selection.results", { label })}
              className="provider-choice-options"
            >
              {filtered.map((option, index) => (
                <button
                  type="button"
                  role="option"
                  key={option.id}
                  tabIndex={-1}
                  id={`${id}-${index}`}
                  aria-selected={option.id === value}
                  data-active={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option.id)}
                >
                  <strong>{option.label}</strong>
                  <small>{option.detail ?? option.id}</small>
                </button>
              ))}
            </div>
            {!filtered.length && <p role="status">{t("selection.noMatches")}</p>}
          </div>,
          document.body,
        )}
    </div>
  )
}
