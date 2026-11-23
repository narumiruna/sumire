import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useEffect, useId, useRef, useState } from "react"
import "./spectrum-issue-controls.css"
import { ApiError, request } from "./api.js"
import { getLocale, t } from "./i18n.js"
import type { IssuesMcpScope } from "./issues-mcp-oauth.js"

type Grant = {
  id: string
  clientName: string
  redirectUri: string
  scope: IssuesMcpScope
  expiresAt: number
}
type GrantList = { endpoint: string | null; grants: Grant[] }
const path = "issues-mcp/grants"
const dialogStyles = style({
  font: "body",
  "--issue-dialog-surface": { type: "backgroundColor", value: "layer-2" },
  "--issue-dialog-border": { type: "borderColor", value: "gray-300" },
  "--issue-dialog-text": { type: "color", value: "body" },
  "--issue-dialog-backdrop": { type: "backgroundColor", value: "transparent-black-500" },
})
const titleStyles = style({ font: "heading-sm", color: "title", margin: 0 })
const grantTitleStyles = style({ font: "heading-xs", color: "title", margin: 0 })
const actions = style({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 })
const headingRow = style({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 12,
})

export default function IssuesMcpGrants({ csrf, onExpired }: { csrf: string; onExpired(): void }) {
  const manager = useRef<HTMLDialogElement>(null)
  const confirmation = useRef<HTMLDialogElement>(null)
  const active = useRef<AbortController | null>(null)
  const result = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const confirmTitleId = useId()
  const confirmDescriptionId = useId()
  const [list, setList] = useState<GrantList>()
  const [pending, setPending] = useState<Grant>()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<"loadFailed" | "changeFailed" | "revoked">()

  useEffect(() => () => active.current?.abort(), [])
  useEffect(() => {
    if (pending && manager.current?.open) confirmation.current?.showModal()
  }, [pending])
  useEffect(() => {
    if (outcome) result.current?.focus()
  }, [outcome])

  async function update(grant?: Grant) {
    const signal = active.current?.signal
    if (!signal || signal.aborted || busy) return
    const stillOpen = () => !signal.aborted && manager.current?.open
    setOutcome(undefined)
    setBusy(true)
    try {
      const next = grant
        ? await request<GrantList>(path, csrf, { id: grant.id }, "DELETE", signal)
        : await request<GrantList>(path, undefined, undefined, "GET", signal)
      if (!stillOpen()) return
      setList(next)
      if (grant) setOutcome("revoked")
    } catch (error) {
      if (!stillOpen()) return
      if (error instanceof ApiError && error.status === 401) onExpired()
      else {
        // The server may have revoked the grant even if its response did not arrive.
        setList(undefined)
        setOutcome(grant ? "changeFailed" : "loadFailed")
      }
    } finally {
      if (stillOpen()) setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        fillStyle="outline"
        aria-haspopup="dialog"
        onPress={() => {
          if (!manager.current || active.current) return
          manager.current.showModal()
          active.current = new AbortController()
          void update()
        }}
      >
        {t("issuesMcp.manage")}
      </Button>
      <dialog
        ref={manager}
        className={`issues-mcp-dialog ${dialogStyles}`}
        aria-labelledby={titleId}
        closedby="closerequest"
        data-feedback-private
        onClose={() => {
          active.current?.abort()
          active.current = null
          setList(undefined)
          setPending(undefined)
          setBusy(false)
          setOutcome(undefined)
        }}
      >
        <div className={headingRow}>
          <h2 className={titleStyles} id={titleId}>
            {t("issuesMcp.title")}
          </h2>
          <form method="dialog">
            <Button variant="secondary" fillStyle="outline" type="submit" size="XL">
              {t("issuesMcp.close")}
            </Button>
          </form>
        </div>
        {busy && <div role="status">{t(list ? "issuesMcp.saving" : "issuesMcp.loading")}</div>}
        {outcome && (
          <div tabIndex={-1} ref={result}>
            {outcome === "revoked" ? (
              <p role="status">{t("issuesMcp.revoked")}</p>
            ) : (
              <InlineAlert variant="negative">
                <Content>{t(`issuesMcp.${outcome}`)}</Content>
              </InlineAlert>
            )}
          </div>
        )}
        {outcome && outcome !== "revoked" && (
          <Button
            type="button"
            variant="secondary"
            fillStyle="outline"
            size="XL"
            onPress={() => void update()}
          >
            {t("issuesMcp.reload")}
          </Button>
        )}
        {list && (
          <>
            {list.endpoint ? (
              <div>
                <p>{t("issuesMcp.clientHelp")}</p>
                <code className="issues-mcp-value" dir="ltr">
                  {list.endpoint}
                </code>
              </div>
            ) : (
              <p>{t("issuesMcp.noEndpoint")}</p>
            )}
            {list.grants.length ? (
              <ul className="issues-mcp-grant-list">
                {list.grants.map((grant) => (
                  <GrantRow
                    key={grant.id}
                    grant={grant}
                    busy={busy}
                    onRevoke={() => setPending(grant)}
                  />
                ))}
              </ul>
            ) : (
              <p>{t("issuesMcp.empty")}</p>
            )}
          </>
        )}
      </dialog>
      <dialog
        ref={confirmation}
        className={`issues-mcp-dialog ${dialogStyles}`}
        aria-labelledby={confirmTitleId}
        aria-describedby={confirmDescriptionId}
        closedby="closerequest"
        data-feedback-private
        onClose={(event) => {
          const dialog = event.currentTarget
          const accepted = dialog.returnValue === "confirm"
          dialog.returnValue = ""
          setPending(undefined)
          if (accepted && pending) void update(pending)
        }}
      >
        {pending && (
          <>
            <h2 className={titleStyles} id={confirmTitleId}>
              {t("issuesMcp.revokeTitle")}
            </h2>
            <div id={confirmDescriptionId}>
              <p>
                <bdi>{pending.clientName}</bdi>
              </p>
              <code className="issues-mcp-value" dir="ltr">
                {pending.redirectUri}
              </code>
              <p>{t("issuesMcp.revokeHelp")}</p>
            </div>
            <form method="dialog" className={actions}>
              <Button
                ref={(button) => {
                  // Set native autofocus for showModal(), not mount-time focus in a closed dialog.
                  const element = button?.UNSAFE_getDOMNode()
                  if (element) element.autofocus = true
                }}
                type="submit"
                value="cancel"
                variant="secondary"
                fillStyle="outline"
                size="XL"
              >
                {t("issuesMcp.cancel")}
              </Button>
              <Button type="submit" value="confirm" variant="negative" size="XL">
                {t("issuesMcp.revoke")}
              </Button>
            </form>
          </>
        )}
      </dialog>
    </>
  )
}

function GrantRow({ grant, busy, onRevoke }: { grant: Grant; busy: boolean; onRevoke(): void }) {
  const nameId = useId()
  const expiresAt = new Date(grant.expiresAt)
  return (
    <li className="issues-mcp-grant">
      <h3 className={grantTitleStyles} id={nameId}>
        <bdi>{grant.clientName}</bdi>
      </h3>
      <dl className="issues-mcp-details">
        <div>
          <dt>{t("issuesMcp.callback")}</dt>
          <dd>
            <code dir="ltr">{grant.redirectUri}</code>
          </dd>
        </div>
        <div>
          <dt>{t("issuesMcp.scope")}</dt>
          <dd>
            {t(grant.scope === "issues:read" ? "issuesMcp.readTitle" : "issuesMcp.writeTitle")} (
            <code>{grant.scope}</code>)
          </dd>
        </div>
        <div>
          <dt>{t("issuesMcp.expires")}</dt>
          <dd>
            <time dateTime={expiresAt.toISOString()}>
              {expiresAt.toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </dd>
        </div>
      </dl>
      <Button
        type="button"
        variant="negative"
        fillStyle="outline"
        size="XL"
        aria-describedby={nameId}
        isDisabled={busy}
        onPress={onRevoke}
      >
        {t("issuesMcp.revoke")}
      </Button>
    </li>
  )
}
