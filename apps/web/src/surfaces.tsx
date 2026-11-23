import { Badge } from "@react-spectrum/s2/Badge"
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { type ComponentProps, type ReactNode, useId } from "react"

const surface = style({
  "--panel-color": { type: "borderColor", value: "gray-300" },
  "--panel-background": { type: "backgroundColor", value: "layer-2" },
})

type PanelProps = Omit<ComponentProps<"section">, "ref"> &
  Pick<ComponentProps<"fieldset">, "disabled" | "form" | "name"> & {
    as?: "section" | "fieldset"
    mt?: "3"
  }

export function Panel({
  as = "section",
  className,
  mt,
  disabled,
  form,
  name,
  ...props
}: PanelProps) {
  const classes = ["panel", className, surface, mt && "panel-spaced"].filter(Boolean).join(" ")
  return as === "fieldset" ? (
    <fieldset {...props} className={classes} disabled={disabled} form={form} name={name} />
  ) : (
    <section {...props} className={classes} />
  )
}

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
      {actions && <div className="page-header__actions">{actions}</div>}
      <div className="page-header__copy">
        {breadcrumb && (
          <p className="page-breadcrumb">
            <span>{breadcrumb}</span>
            <ChevronRight />
            <span>{title}</span>
          </p>
        )}
        <h1
          className={style({ font: "heading-lg", color: "title" })}
          id="current-section-heading"
          tabIndex={-1}
        >
          {title}
        </h1>
        {description && (
          <Prose color="gray" className="page-header__description">
            {description}
          </Prose>
        )}
      </div>
    </header>
  )
}

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
      className={["settings-section", className, surface].filter(Boolean).join(" ")}
    >
      <header className="settings-section__intro">
        <h2 className={style({ font: "heading-sm", color: "title", margin: 0 })} id={heading}>
          {title}
        </h2>
        {description && <Prose color="gray">{description}</Prose>}
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
      UNSAFE_className="status-label"
      fillStyle="subtle"
      variant={
        (
          {
            neutral: "neutral",
            success: "positive",
            warning: "notice",
            danger: "negative",
          } as const
        )[tone]
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

const body = style({ font: "body-lg" })
const smallBody = style({ font: "body" })
const text = style({ color: "body" })
const muted = style({ color: "neutral-subdued" })
const warning = style({ color: "notice-1000" })

export function Prose({
  className,
  size,
  color,
  weight,
  mt,
  ...props
}: ComponentProps<"p"> & {
  size?: "1" | "2"
  color?: "gray" | "orange"
  weight?: "medium"
  mt?: "3"
}) {
  const classes = [
    "prose",
    className,
    size === "1" ? smallBody : body,
    color === "gray" ? muted : color === "orange" ? warning : text,
    weight && "prose-medium",
    mt && "panel-spaced",
  ]
  return <p {...props} className={classes.filter(Boolean).join(" ")} />
}
