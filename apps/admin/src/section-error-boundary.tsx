import { Button, Callout } from "@radix-ui/themes"
import { Component, type ReactNode } from "react"
import { t } from "./i18n.js"

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
        <Callout.Root color="red" role="alert">
          <Callout.Text>{t("error.section", { label: this.props.label })}</Callout.Text>
          <Button variant="soft" onClick={() => this.setState({ failed: false })}>
            {t("error.retry", { label: this.props.label.toLowerCase() })}
          </Button>
        </Callout.Root>
      )
    return this.props.children
  }
}
