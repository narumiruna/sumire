import { Box, type BoxProps, Text, type TextProps } from "@radix-ui/themes"
import type { ComponentProps } from "react"

type PanelProps = Omit<BoxProps, "as" | "asChild"> &
  Pick<ComponentProps<"fieldset">, "disabled" | "form" | "name"> & {
    as?: "section" | "fieldset"
  }

/** One surface treatment, with native control-group semantics when required. */
export function Panel({
  as = "section",
  className,
  children,
  disabled,
  form,
  name,
  ...props
}: PanelProps) {
  return (
    <Box {...props} asChild className={["panel", className].filter(Boolean).join(" ")}>
      {as === "fieldset" ? (
        <fieldset disabled={disabled} form={form} name={name}>
          {children}
        </fieldset>
      ) : (
        <section>{children}</section>
      )}
    </Box>
  )
}

/** Paragraph typography with a bounded reading measure. */
export function Prose({
  className,
  ...props
}: Omit<Extract<TextProps, { as: "p" }>, "as" | "asChild">) {
  return <Text {...props} as="p" className={["prose", className].filter(Boolean).join(" ")} />
}
