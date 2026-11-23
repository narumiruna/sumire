import { Button } from "@react-spectrum/s2/Button"
import { Content, Heading, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { BrandIcon } from "./brand-icon.js"
import { t } from "./i18n.js"
import { LanguageSelector } from "./language-selector.js"

type SessionScreenProps =
  | { state: "checking" }
  | { state: "signed-out"; setup: boolean; busy: boolean; error?: string; onSignIn(): void }
  | { state: "loading-settings"; error?: string; onRetry(): void }

export function SessionScreen(props: SessionScreenProps) {
  const description =
    props.state === "checking"
      ? t("app.loadingSession")
      : props.state === "loading-settings"
        ? t("app.loadHelp")
        : t(props.setup ? "app.registerHelp" : "app.signInHelp")
  return (
    <div className={style({ backgroundColor: "layer-1", color: "body", font: "body" })}>
      <main className="session-screen">
        <section
          className={`session-card ${style({ backgroundColor: "layer-2", color: "body" })}`}
          aria-labelledby="session-title"
          aria-busy={props.state === "checking" || undefined}
        >
          <BrandIcon />
          <LanguageSelector />
          <header>
            <Heading id="session-title" level={1} styles={style({ font: "heading-lg" })}>
              {t("app.title")}
            </Heading>
            <p className="session-description">{description}</p>
          </header>
          {props.state === "checking" && <span role="status">{t("app.checkingSession")}</span>}
          {props.state === "signed-out" && !props.setup && (
            <p className="session-description">{t("app.firstVisit")}</p>
          )}
          {props.state !== "checking" && props.error && (
            <InlineAlert variant="negative">
              <Content>{props.error}</Content>
            </InlineAlert>
          )}
          {props.state === "signed-out" && (
            <Button variant="accent" size="XL" isDisabled={props.busy} onPress={props.onSignIn}>
              {t(props.setup ? "app.register" : "app.signIn")}
            </Button>
          )}
          {props.state === "loading-settings" && (
            <>
              {!props.error && <span role="status">{t("app.loadingSettings")}</span>}
              <Button variant="secondary" fillStyle="outline" size="XL" onPress={props.onRetry}>
                {t("app.retry")}
              </Button>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
