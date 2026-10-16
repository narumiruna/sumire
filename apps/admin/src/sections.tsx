import { Select } from "@radix-ui/themes"
import { type ComponentProps, createContext, useContext, useEffect, useState } from "react"

export const SectionActive = createContext(true)

/** Keep editors mounted for drafts, but close their portaled selectors when inactive. */
export function EditorSection({
  active,
  children,
  ...props
}: ComponentProps<"section"> & { active: boolean }) {
  return (
    <SectionActive value={active}>
      <section {...props} hidden={!active}>
        {children}
      </section>
    </SectionActive>
  )
}

function Root({ onOpenChange, ...props }: ComponentProps<typeof Select.Root>) {
  const active = useContext(SectionActive)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])
  return (
    <Select.Root
      {...props}
      open={open && active}
      onOpenChange={(value) => {
        setOpen(value)
        onOpenChange?.(value)
      }}
    />
  )
}

function Content({ onCloseAutoFocus, ...props }: ComponentProps<typeof Select.Content>) {
  const active = useContext(SectionActive)
  return (
    <Select.Content
      {...props}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event)
        if (!active) event.preventDefault()
      }}
    />
  )
}

export const SectionSelect = { ...Select, Root, Content }
