import {
  Box,
  type BoxProps,
  Flex,
  Heading,
  Skeleton,
  Spinner,
  Text,
  type TextProps,
} from "@radix-ui/themes"
import type { ComponentProps, ReactNode } from "react"

export { StatusBadge } from "./semantic-status.js"

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
  return (
    <Text
      {...props}
      as="p"
      className={["prose", props.role === "alert" && "error-state", className]
        .filter(Boolean)
        .join(" ")}
      {...(props.role === "alert" ? { "data-status": "failed" } : {})}
    />
  )
}

/** Visible progress with one accessible status announcement. */
export function LoadingState({
  label,
  className,
  ...props
}: Omit<BoxProps, "as" | "asChild" | "children" | "role" | "aria-label"> & {
  label: string
}) {
  return (
    <Box
      {...props}
      role="status"
      aria-label={label}
      className={["loading-state", className].filter(Boolean).join(" ")}
    >
      <Flex gap="2" align="center">
        <Spinner aria-hidden="true" />
        <Text>{label}</Text>
      </Flex>
      <Flex className="loading-skeletons" direction="column" gap="2" mt="3" aria-hidden="true">
        <Skeleton width="100%" height="16px" />
        <Skeleton width="70%" height="16px" />
      </Flex>
    </Box>
  )
}

/** A consistent empty panel, with an optional next action. */
export function EmptyState({
  title,
  description,
  action,
  className,
  ...props
}: Omit<PanelProps, "as" | "children" | "title"> & {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <Panel {...props} className={["empty-state", className].filter(Boolean).join(" ")}>
      <Heading as="h3" size="3">
        {title}
      </Heading>
      {description && <Prose size="2">{description}</Prose>}
      {action && (
        <Box className="empty-state-action" mt="3">
          {action}
        </Box>
      )}
    </Panel>
  )
}
