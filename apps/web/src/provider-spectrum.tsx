import { AlertDialog, DialogTrigger } from "@react-spectrum/s2/AlertDialog"
import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from "react"
import { FocusScope } from "react-aria/FocusScope"
import { Overlay } from "react-aria/Overlay"
import { useModalOverlay } from "react-aria/useModalOverlay"
import { useOverlayTriggerState } from "react-stately/useOverlayTriggerState"
import { t } from "./i18n.js"
import { SectionActive } from "./sections.js"
import "./provider-spectrum.css"

const backdrop = style({ backgroundColor: "transparent-black-500" })
const surface = style({
  backgroundColor: "layer-2",
  borderRadius: "xl",
  boxShadow: "elevated",
  color: "body",
  font: "body-lg",
})
const heading = style({ font: "heading-lg", color: "title", margin: 0 })

export function focusProviderControl(node: HTMLElement | null | undefined) {
  if (
    !node?.checkVisibility({ visibilityProperty: true }) ||
    node.matches(":disabled") ||
    node.closest('[inert], [aria-hidden="true"]')
  )
    return false
  node.focus({ preventScroll: true })
  return node === document.activeElement
}

// Spectrum's modal automatically restores focus. These dialogs need to hand it
// off explicitly: authentication may finish later, and Review opens another dialog.
export function ProviderDialog({
  id,
  title,
  description,
  children,
  onClose,
  dismissOutside = false,
  busy = false,
}: {
  id: string
  title: string
  description: string
  children: ReactNode
  onClose(): void
  dismissOutside?: boolean
  busy?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const state = useOverlayTriggerState({
    isOpen: true,
    onOpenChange: (open) => {
      if (!open && !busy) onClose()
    },
  })
  const { modalProps, underlayProps } = useModalOverlay(
    { isDismissable: dismissOutside, isKeyboardDismissDisabled: busy },
    state,
    ref,
  )
  return (
    <Overlay disableFocusManagement>
      <div className={`provider-dialog-underlay ${backdrop}`} {...underlayProps}>
        <FocusScope contain autoFocus>
          <div
            {...modalProps}
            ref={ref}
            id={id}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-description`}
            tabIndex={-1}
            className={`provider-dialog ${surface}`}
          >
            <h2 id={`${id}-title`} className={heading}>
              {title}
            </h2>
            <p id={`${id}-description`}>{description}</p>
            {children}
          </div>
        </FocusScope>
      </div>
    </Overlay>
  )
}

export function ProviderConfirmation({
  trigger,
  title,
  description,
  action,
  disabled,
  destructive = false,
  onConfirm,
}: {
  trigger: string
  title: string
  description: string
  action: string
  disabled: boolean
  destructive?: boolean
  onConfirm(): void
}) {
  const active = useContext(SectionActive)
  const [open, setOpen] = useState(false)
  const descriptionId = useId()
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])
  return (
    <DialogTrigger isOpen={open && active} onOpenChange={(next) => setOpen(active && next)}>
      <Button
        variant={destructive ? "negative" : "accent"}
        fillStyle={destructive ? "outline" : "fill"}
        size="XL"
        isDisabled={disabled}
      >
        {trigger}
      </Button>
      {open && active && (
        <AlertDialog
          variant={destructive ? "destructive" : "confirmation"}
          title={title}
          aria-describedby={descriptionId}
          cancelLabel={t("selection.cancel")}
          primaryActionLabel={action}
          isPrimaryActionDisabled={disabled}
          autoFocusButton="cancel"
          onPrimaryAction={onConfirm}
        >
          <p id={descriptionId}>{description}</p>
        </AlertDialog>
      )}
    </DialogTrigger>
  )
}
