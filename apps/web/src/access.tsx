import { Button } from "@react-spectrum/s2/Button"
import InfoCircle from "@react-spectrum/s2/icons/InfoCircle"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { useEffect, useRef, useState } from "react"
import { ApiError, request, type Snapshot } from "./api.js"
import { t } from "./i18n.js"
import { Panel, Prose, StatusLabel } from "./surfaces.js"

type Props = {
  csrf: string
  snapshot: Snapshot
  disabled: boolean
  run: (action: () => Promise<void>, focusFailure?: boolean) => Promise<void>
  refresh: () => Promise<void>
}
type Pending = { id: number; type: string; name: string; expires: number; revision: number }

export function AccessApproval({
  token,
  clear,
  csrf,
  snapshot,
  disabled,
  run,
  refresh,
}: Props & {
  token: string
  clear: () => void
}) {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [chat, setChat] = useState<Pending>()
  const [reload, setReload] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-resolve server state after policy changes and explicit reloads.
  useEffect(() => {
    let active = true
    setChat(undefined)
    void request<Pending>("access/resolve", csrf, { token }).then(
      (next) => {
        if (active) setChat(next)
      },
      (error: unknown) => {
        if (!active) return
        if (error instanceof ApiError && error.status === 410) clear()
        void run(async () => {
          throw error
        }, false)
      },
    )
    return () => {
      active = false
    }
  }, [token, csrf, snapshot.revision, reload, run, clear])
  useEffect(() => {
    if (!chat) return
    const timer = window.setTimeout(clear, Math.max(0, chat.expires - Date.now()))
    return () => window.clearTimeout(timer)
  }, [chat, clear])
  return (
    <Panel className="access-approval" aria-label={t("access.requestLabel")}>
      <header
        className={`section-heading ${style({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 })}`}
      >
        <h2 className={style({ font: "heading-sm", margin: 0 })}>{t("access.review")}</h2>
        <StatusLabel tone="warning">{t("access.linkRequest")}</StatusLabel>
      </header>
      {chat ? (
        <>
          <dl className="data-list access-approval__identity">
            <div className="data-row">
              <dt>{t("access.chat")}</dt>
              <dd>{chat.name}</dd>
            </div>
            <div className="data-row">
              <dt>{t("access.type")}</dt>
              <dd>{chat.type}</dd>
            </div>
            <div className="data-row">
              <dt>{t("access.telegramId")}</dt>
              <dd>
                <code className="access-id">{chat.id}</code>
              </dd>
            </div>
          </dl>
          <p
            className={`access-approval__notice ${style({ display: "flex", gap: 8, padding: 12, borderRadius: "default", backgroundColor: "notice-subtle", color: "notice-1000" })}`}
          >
            <InfoCircle /> <span>{t("access.approvalNotice")}</span>
          </p>
          <Button
            size="XL"
            variant="accent"
            isDisabled={disabled || chat.expires <= Date.now()}
            onPress={() =>
              void run(async () => {
                try {
                  await request<Snapshot>("access/approve", csrf, {
                    token,
                    revision: chat.revision,
                  })
                  if (mounted.current) clear()
                } catch (error) {
                  if (mounted.current) {
                    if (error instanceof ApiError && error.status === 410) clear()
                    setChat(undefined)
                  }
                  throw error
                } finally {
                  await refresh()
                }
              })
            }
          >
            {t("access.approveChat")}
          </Button>
        </>
      ) : (
        <Prose size="2" className="empty-state" role="status">
          {t("access.loadBeforeApproval")}
        </Prose>
      )}
      <div
        className={`access-approval__actions ${style({ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 })}`}
      >
        <Button variant="secondary" isDisabled={disabled} onPress={() => setReload((v) => v + 1)}>
          {t("access.reloadRequest")}
        </Button>
        <Button variant="secondary" isDisabled={disabled} onPress={clear}>
          {t("access.dismissRequest")}
        </Button>
      </div>
    </Panel>
  )
}
