import { Button, Callout, Flex, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
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
import { PageHeader, Panel } from "./surfaces.js"

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
  const resultRef = useRef<HTMLDivElement>(null)
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
    if (view.kind !== "loading" && view.kind !== "review") resultRef.current?.focus()
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
    <main className="session-screen issues-mcp-consent">
      <Panel className="session-card">
        <BrandIcon />
        <LanguageSelector />
        <PageHeader title={t("issuesMcp.consentTitle")} />
        {kind === "loading" && <Text role="status">{t("issuesMcp.checkingRequest")}</Text>}
        {kind === "signIn" && (
          <>
            <Text as="p">{t("issuesMcp.signInHelp")}</Text>
            {signInError && (
              <Callout.Root role="alert" color="red">
                <Callout.Text>{signInError}</Callout.Text>
              </Callout.Root>
            )}
            <Button type="button" disabled={signingIn} onClick={onSignIn}>
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
            <Callout.Root color="orange">
              <Callout.Text>{t("issuesMcp.unverified")}</Callout.Text>
              <Callout.Text>
                {t(
                  view.consent.scope === "issues:read"
                    ? "issuesMcp.readHelp"
                    : "issuesMcp.writeHelp",
                )}
              </Callout.Text>
            </Callout.Root>
            <form
              action={`/api/${path}`}
              method="post"
              aria-labelledby="current-section-heading"
              onSubmit={(event) => {
                event.preventDefault()
                const button = (event.nativeEvent as SubmitEvent).submitter
                if (button instanceof HTMLButtonElement && button.name === "approve") {
                  if (button.value === "true" || button.value === "false")
                    void decide(button.value === "true", view.consent)
                }
              }}
            >
              <Flex gap="2" wrap="wrap">
                <Button type="submit" name="approve" value="false" variant="soft" disabled={busy}>
                  {t("issuesMcp.deny")}
                </Button>
                <Button type="submit" name="approve" value="true" disabled={busy}>
                  {t("issuesMcp.approve")}
                </Button>
              </Flex>
            </form>
            {busy && <Text role="status">{t("issuesMcp.submitting")}</Text>}
          </>
        )}
        {failed && (
          <>
            <Callout.Root ref={resultRef} tabIndex={-1} role="alert" color="red">
              <Callout.Text>{t(`issuesMcp.consent.${kind}`)}</Callout.Text>
            </Callout.Root>
            {kind === "loadFailed" && (
              <Button
                type="button"
                variant="soft"
                onClick={() => {
                  setView({ kind: "loading" })
                  setRetry((value) => value + 1)
                }}
              >
                {t("app.retry")}
              </Button>
            )}
            <a href="/">{t("issuesMcp.back")}</a>
          </>
        )}
        {kind === "complete" && view.kind === "complete" && (
          <>
            <div ref={resultRef} tabIndex={-1} role="status">
              {t("issuesMcp.returning")}
            </div>
            <Button asChild>
              <a href={view.redirect} rel="noreferrer">
                {t("issuesMcp.continue")}
              </a>
            </Button>
          </>
        )}
      </Panel>
    </main>
  )
}
