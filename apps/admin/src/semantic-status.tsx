import {
  CheckCircledIcon,
  ClockIcon,
  CrossCircledIcon,
  Link2Icon,
  MinusCircledIcon,
  Pencil2Icon,
  QuestionMarkCircledIcon,
} from "@radix-ui/react-icons"
import { Badge, type BadgeProps } from "@radix-ui/themes"
import type { ReactNode } from "react"

/** Shared status tokens. Context can change the text, but not the color or icon. */
export const semanticStatuses = {
  approved: { color: "green", icon: CheckCircledIcon, label: "Approved" },
  pending: { color: "orange", icon: ClockIcon, label: "Pending" },
  failed: { color: "red", icon: CrossCircledIcon, label: "Failed" },
  inherited: { color: "blue", icon: Link2Icon, label: "Inherited" },
  overridden: { color: "violet", icon: Pencil2Icon, label: "Overridden" },
  disabled: { color: "gray", icon: MinusCircledIcon, label: "Disabled" },
  unknown: { color: "gray", icon: QuestionMarkCircledIcon, label: "Unknown" },
} as const

export type SemanticStatus = keyof typeof semanticStatuses

type StatusBadgeProps = Omit<BadgeProps, "color" | "children" | "asChild"> & {
  status: SemanticStatus
  children?: ReactNode
}

/** A status always has a visible label and a decorative semantic icon. */
export function StatusBadge({ status, children, className, ...props }: StatusBadgeProps) {
  const { color, icon: Icon, label } = semanticStatuses[status]
  return (
    <Badge
      {...props}
      color={color}
      className={["status-badge", className].filter(Boolean).join(" ")}
      data-status={status}
    >
      <Icon className="status-icon" aria-hidden="true" focusable="false" />
      {children ?? label}
    </Badge>
  )
}
