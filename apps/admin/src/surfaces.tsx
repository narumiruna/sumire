import { Box, type BoxProps, Flex, Heading, Text, type TextProps } from "@radix-ui/themes"
import type { ComponentProps, ReactNode } from "react"

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

/** A shared title, reading measure, and action slot for each workspace. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="workspace-header page-header">
      {actions && (
        <Flex gap="2" className="page-header__actions">
          {actions}
        </Flex>
      )}
      <Flex direction="column" gap="1" className="page-header__copy">
        <Heading as="h1" size="6" id="current-section-heading" tabIndex={-1}>
          {title}
        </Heading>
        {description && (
          <Text as="p" size="2" color="gray" className="page-header__description">
            {description}
          </Text>
        )}
      </Flex>
    </header>
  )
}

/** Paragraph typography with a bounded reading measure. */
export function Prose({
  className,
  ...props
}: Omit<Extract<TextProps, { as: "p" }>, "as" | "asChild">) {
  return <Text {...props} as="p" className={["prose", className].filter(Boolean).join(" ")} />
}
