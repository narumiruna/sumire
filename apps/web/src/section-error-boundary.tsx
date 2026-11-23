import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
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
        <InlineAlert variant="negative" styles={style({ width: "full" })}>
          <Content styles={style({ display: "grid", justifyItems: "start", gap: 12 })}>
            <span>{t("error.section", { label: this.props.label })}</span>
            <Button variant="secondary" size="XL" onPress={() => this.setState({ failed: false })}>
              {t("error.retry", { label: this.props.label.toLowerCase() })}
            </Button>
          </Content>
        </InlineAlert>
      )
    return this.props.children
  }
}
