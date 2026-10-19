import { Button, Callout } from "@radix-ui/themes"
import { Component, type ReactNode } from "react"
import { semanticStatuses } from "./semantic-status.js"

const ErrorIcon = semanticStatuses.failed.icon

/** A failed editor must not remove navigation or another editor's state. */
export class SectionErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed)
      return (
        <Callout.Root
          color={semanticStatuses.failed.color}
          role="alert"
          className="error-state"
          data-status="failed"
        >
          <Callout.Icon>
            <ErrorIcon aria-hidden="true" focusable="false" />
          </Callout.Icon>
          <Callout.Text>
            {this.props.label} could not be displayed. Other sections remain available.
          </Callout.Text>
          <Button variant="soft" onClick={() => this.setState({ failed: false })}>
            Retry {this.props.label.toLowerCase()}
          </Button>
        </Callout.Root>
      )
    return this.props.children
  }
}
