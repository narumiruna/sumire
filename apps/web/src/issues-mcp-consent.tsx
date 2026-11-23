import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { Link } from "@react-spectrum/s2/Link"
import { LinkButton } from "@react-spectrum/s2/LinkButton"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useEffect, useRef, useState } from "react"
import "./issues-mcp-consent.css"
import { ApiError, request } from "./api.js"
import { BrandIcon } from "./brand-icon.js"
import { t } from "./i18n.js"
import {
  type IssuesMcpScope,
  isIssuesMcpCallback,
  readIssuesMcpRequest,
  validateIssuesMcpRedirect,
} from "./issues-mcp-oauth.js"
import { LanguageSelector } from "./language-selector.js"

type Consent = {
  clientName: string
  redirectUri: string
  scope: IssuesMcpScope
}
type View =
  | { kind: "loading" }
  | { kind: "review"; consent: Consent }
  | { kind: "unavailable" | "loadFailed" | "decisionFailed" | "redirectFailed" }
  | { kind: "complete"; redirect: string }

const path = "issues-mcp/consent"
const pageStyles = style({ backgroundColor: "layer-1", color: "body", font: "body" })
const cardStyles = style({
  overflowWrap: "anywhere",
  "--consent-card-surface": { type: "backgroundColor", value: "layer-2" },
  "--consent-card-border": { type: "borderColor", value: "gray-300" },
  "--consent-focus": { type: "outlineColor", value: "focus-ring" },
  "--consent-back-text": {
    type: "color",
    value: { default: "accent", forcedColors: "LinkText" },
  },
  "--consent-back-hover": {
    type: "color",
    value: { default: "accent-1000", forcedColors: "LinkText" },
  },
  "--consent-continue-text": {
    type: "color",
    value: { default: "white", forcedColors: "ButtonFace" },
  },
})
const noticeStyles = style({
  alignSelf: "stretch",
  backgroundColor: "notice-subtle",
  borderColor: "notice-700",
  borderStyle: "solid",
  borderWidth: 2,
  borderRadius: "lg",
  display: "grid",
  gap: 8,
  padding: 16,
})

export default function IssuesMcpConsent({
  requestId,
  csrf,
  checkingSession,
  signingIn,
  signInError,
  onSignIn,
  onExpired,
}: {
  requestId: string
  csrf: string | undefined
  checkingSession: boolean
  signingIn: boolean
  signInError: string
  onSignIn(): void
  onExpired(): void
}) {
  const active = useRef<AbortController>(null)
  const submitting = useRef(false)
  const returningRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ kind: "loading" })
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the request.
  useEffect(() => {
    if (!requestId || !csrf) return
    const controller = new AbortController()
    active.current = controller
    void request<Consent>(
      `${path}?requestId=${requestId}`,
      undefined,
      undefined,
      "GET",
      controller.signal,
    )
      .then((consent) => {
        if (controller.signal.aborted) return
        if (
          typeof consent?.clientName !== "string" ||
          !isIssuesMcpCallback(consent.redirectUri) ||
          (consent.scope !== "issues:read" && consent.scope !== "issues:write")
        ) {
          setView({ kind: "unavailable" })
        } else setView({ kind: "review", consent })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) onExpired()
        else if (error instanceof ApiError && [400, 403, 404, 410].includes(error.status))
          setView({ kind: "unavailable" })
        else setView({ kind: "loadFailed" })
      })
    return () => controller.abort()
  }, [csrf, onExpired, requestId, retry])

  useEffect(() => {
    if (view.kind === "complete") returningRef.current?.focus()
  }, [view.kind])

  async function decide(approve: boolean, consent: Consent) {
    const signal = active.current?.signal
    if (!csrf || !signal || signal.aborted || submitting.current) return
    submitting.current = true
    setBusy(true)
    const isCurrent = () =>
      !signal.aborted && readIssuesMcpRequest(window.location.hash) === requestId
    try {
      const result = await request<{ redirect: string }>(
        path,
        csrf,
        { requestId, approve },
        "POST",
        signal,
      )
      if (!isCurrent()) return
      const redirect = validateIssuesMcpRedirect(
        consent.redirectUri,
        result?.redirect,
        approve,
        window.location.origin,
      )
      const { pathname, search } = window.location
      window.history.replaceState(window.history.state, "", pathname + search)
      if (!redirect) {
        setView({ kind: "redirectFailed" })
        return
      }
      setView({ kind: "complete", redirect })
      try {
        window.location.assign(redirect)
      } catch {
        // The browser may require the user to activate the link below.
      }
    } catch (error) {
      if (!isCurrent()) return
      if (error instanceof ApiError && error.status === 401) onExpired()
      else setView({ kind: "decisionFailed" })
    } finally {
      if (!signal.aborted) {
        submitting.current = false
        setBusy(false)
      }
    }
  }

  const kind = !requestId
    ? "unavailable"
    : checkingSession
      ? "loading"
      : !csrf
        ? "signIn"
        : view.kind
  const failed =
    kind === "unavailable" ||
    kind === "loadFailed" ||
    kind === "decisionFailed" ||
    kind === "redirectFailed"
  return (
    <div className={pageStyles}>
      <main className="session-screen issues-mcp-consent">
        <section className={`session-card ${cardStyles}`}>
          <BrandIcon />
          <LanguageSelector />
          <header>
            <h1
              id="issues-mcp-consent-heading"
              tabIndex={-1}
              className={style({ font: "heading-lg", color: "heading" })}
            >
              {t("issuesMcp.consentTitle")}
            </h1>
          </header>
          {kind === "loading" && <span role="status">{t("issuesMcp.checkingRequest")}</span>}
          {kind === "signIn" && (
            <>
              <p className="session-description">{t("issuesMcp.signInHelp")}</p>
              {signInError && (
                <InlineAlert variant="negative">
                  <Content>{signInError}</Content>
                </InlineAlert>
              )}
              <Button
                type="button"
                variant="accent"
                size="XL"
                isDisabled={signingIn}
                onPress={onSignIn}
              >
                {t("app.signIn")}
              </Button>
            </>
          )}
          {kind === "review" && view.kind === "review" && (
            <>
              <dl className="issues-mcp-details">
                <div>
                  <dt>{t("issuesMcp.clientName")}</dt>
                  <dd>
                    <bdi>{view.consent.clientName}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{t("issuesMcp.callback")}</dt>
                  <dd>
                    <code dir="ltr">{view.consent.redirectUri}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t("issuesMcp.scope")}</dt>
                  <dd>
                    {t(
                      view.consent.scope === "issues:read"
                        ? "issuesMcp.readTitle"
                        : "issuesMcp.writeTitle",
                    )}{" "}
                    (<code>{view.consent.scope}</code>)
                  </dd>
                </div>
              </dl>
              {/* This review notice is static, not a live alert. */}
              <div className={noticeStyles}>
                <div>{t("issuesMcp.unverified")}</div>
                <div>
                  {t(
                    view.consent.scope === "issues:read"
                      ? "issuesMcp.readHelp"
                      : "issuesMcp.writeHelp",
                  )}
                </div>
              </div>
              <form
                action={`/api/${path}`}
                method="post"
                aria-labelledby="issues-mcp-consent-heading"
                onSubmit={(event) => {
                  event.preventDefault()
                  const button = (event.nativeEvent as SubmitEvent).submitter
                  if (button instanceof HTMLButtonElement && button.name === "approve") {
                    if (button.value === "true" || button.value === "false")
                      void decide(button.value === "true", view.consent)
                  }
                }}
              >
                <div className={style({ display: "flex", flexWrap: "wrap", gap: 8 })}>
                  <Button
                    type="submit"
                    name="approve"
                    value="false"
                    variant="secondary"
                    fillStyle="outline"
                    size="XL"
                    isDisabled={busy}
                  >
                    {t("issuesMcp.deny")}
                  </Button>
                  <Button
                    type="submit"
                    name="approve"
                    value="true"
                    variant="accent"
                    size="XL"
                    isDisabled={busy}
                  >
                    {t("issuesMcp.approve")}
                  </Button>
                </div>
              </form>
              {busy && <span role="status">{t("issuesMcp.submitting")}</span>}
            </>
          )}
          {failed && (
            <>
              <InlineAlert key={kind} variant="negative" autoFocus={view.kind === kind}>
                <Content>{t(`issuesMcp.consent.${kind}`)}</Content>
              </InlineAlert>
              {kind === "loadFailed" && (
                <Button
                  type="button"
                  variant="secondary"
                  fillStyle="outline"
                  size="XL"
                  onPress={() => {
                    setView({ kind: "loading" })
                    setRetry((value) => value + 1)
                  }}
                >
                  {t("app.retry")}
                </Button>
              )}
              <Link href="/" isStandalone UNSAFE_className="consent-back">
                {t("issuesMcp.back")}
              </Link>
            </>
          )}
          {kind === "complete" && view.kind === "complete" && (
            <>
              <div ref={returningRef} tabIndex={-1} role="status">
                {t("issuesMcp.returning")}
              </div>
              <LinkButton
                href={view.redirect}
                rel="noreferrer"
                variant="accent"
                size="XL"
                UNSAFE_className="consent-continue"
              >
                {t("issuesMcp.continue")}
              </LinkButton>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
