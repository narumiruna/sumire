import { ChevronRightIcon } from "@radix-ui/react-icons"
import { Badge, Box, type BoxProps, Flex, Heading, Text, type TextProps } from "@radix-ui/themes"
import { type ComponentProps, type ReactNode, useId } from "react"

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
  breadcrumb,
}: {
  title: string
  description?: string
  actions?: ReactNode
  breadcrumb?: string
}) {
  return (
    <header className="workspace-header page-header">
      {actions && (
        <Flex gap="2" className="page-header__actions">
          {actions}
        </Flex>
      )}
      <Flex direction="column" gap="1" className="page-header__copy">
        {breadcrumb && (
          <p className="page-breadcrumb">
            <span>{breadcrumb}</span>
            <ChevronRightIcon aria-hidden />
            <span>{title}</span>
          </p>
        )}
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

/** A shared editorial section: context on the left, controls on the right. */
export function SettingsSection({
  title,
  description,
  children,
  className,
  ...props
}: ComponentProps<"section"> & {
  title: string
  description?: string
}) {
  const heading = useId()
  return (
    <section
      {...props}
      aria-labelledby={heading}
      className={["settings-section", className].filter(Boolean).join(" ")}
    >
      <header className="settings-section__intro">
        <Heading as="h2" size="4" id={heading}>
          {title}
        </Heading>
        {description && (
          <Prose size="2" color="gray">
            {description}
          </Prose>
        )}
      </header>
      <div className="settings-section__body">{children}</div>
    </section>
  )
}

export function StatusLabel({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger"
  children: ReactNode
}) {
  return (
    <Badge
      className="status-label"
      color={
        ({ neutral: "gray", success: "green", warning: "orange", danger: "red" } as const)[tone]
      }
    >
      {children}
    </Badge>
  )
}

export function Disclosure({
  title,
  summaryId,
  children,
  className,
  ...props
}: Omit<ComponentProps<"details">, "title"> & { title: ReactNode; summaryId?: string }) {
  return (
    <details {...props} className={["disclosure", className].filter(Boolean).join(" ")}>
      <summary id={summaryId}>{title}</summary>
      {children}
    </details>
  )
}

export function TableToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={["table-toolbar", className].filter(Boolean).join(" ")} />
}

/** Paragraph typography with a bounded reading measure. */
export function Prose({
  className,
  ...props
}: Omit<Extract<TextProps, { as: "p" }>, "as" | "asChild">) {
  return <Text {...props} as="p" className={["prose", className].filter(Boolean).join(" ")} />
}
