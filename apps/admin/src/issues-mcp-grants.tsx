import { Button, Callout, Flex, Heading, Text } from "@radix-ui/themes"
import { useEffect, useId, useRef, useState } from "react"
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
        variant="soft"
        aria-haspopup="dialog"
        onClick={() => {
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
        className="issues-mcp-dialog"
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
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Heading as="h2" size="4" id={titleId}>
            {t("issuesMcp.title")}
          </Heading>
          <form method="dialog">
            <Button variant="soft" type="submit">
              {t("issuesMcp.close")}
            </Button>
          </form>
        </Flex>
        {busy && <Text role="status">{t(list ? "issuesMcp.saving" : "issuesMcp.loading")}</Text>}
        {outcome && (
          <div tabIndex={-1} ref={result}>
            {outcome === "revoked" ? (
              <Text as="p" role="status">
                {t("issuesMcp.revoked")}
              </Text>
            ) : (
              <Callout.Root color="red" role="alert">
                <Callout.Text>{t(`issuesMcp.${outcome}`)}</Callout.Text>
              </Callout.Root>
            )}
          </div>
        )}
        {outcome && outcome !== "revoked" && (
          <Button type="button" variant="soft" onClick={() => void update()}>
            {t("issuesMcp.reload")}
          </Button>
        )}
        {list && (
          <>
            {list.endpoint ? (
              <div>
                <Text as="p">{t("issuesMcp.clientHelp")}</Text>
                <code className="issues-mcp-value" dir="ltr">
                  {list.endpoint}
                </code>
              </div>
            ) : (
              <Text as="p">{t("issuesMcp.noEndpoint")}</Text>
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
              <Text as="p">{t("issuesMcp.empty")}</Text>
            )}
          </>
        )}
      </dialog>
      <dialog
        ref={confirmation}
        className="issues-mcp-dialog"
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
            <Heading as="h2" size="4" id={confirmTitleId}>
              {t("issuesMcp.revokeTitle")}
            </Heading>
            <div id={confirmDescriptionId}>
              <Text as="p">
                <bdi>{pending.clientName}</bdi>
              </Text>
              <code className="issues-mcp-value" dir="ltr">
                {pending.redirectUri}
              </code>
              <Text as="p">{t("issuesMcp.revokeHelp")}</Text>
            </div>
            <form method="dialog">
              <Flex gap="2" wrap="wrap">
                <Button
                  ref={(button) => {
                    if (button) button.autofocus = true
                  }}
                  type="submit"
                  value="cancel"
                  variant="soft"
                >
                  {t("issuesMcp.cancel")}
                </Button>
                <Button type="submit" value="confirm" color="red">
                  {t("issuesMcp.revoke")}
                </Button>
              </Flex>
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
      <Heading as="h3" size="3" id={nameId}>
        <bdi>{grant.clientName}</bdi>
      </Heading>
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
        variant="soft"
        color="red"
        aria-describedby={nameId}
        disabled={busy}
        onClick={onRevoke}
      >
        {t("issuesMcp.revoke")}
      </Button>
    </li>
  )
}
