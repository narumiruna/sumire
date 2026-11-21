import { InfoCircledIcon } from "@radix-ui/react-icons"
import { Badge, Button, Callout, Code, DataList, Flex, Heading } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request, type Snapshot } from "./api.js"
import { t } from "./i18n.js"
import { Panel, Prose } from "./surfaces.js"

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
      <Flex gap="3" align="center" justify="between" wrap="wrap" className="section-heading">
        <Heading as="h2" size="4">
          {t("access.review")}
        </Heading>
        <Badge color="orange">{t("access.linkRequest")}</Badge>
      </Flex>
      {chat ? (
        <>
          <DataList.Root size="2" className="data-list access-approval__identity">
            <DataList.Item className="data-row">
              <DataList.Label>{t("access.chat")}</DataList.Label>
              <DataList.Value>{chat.name}</DataList.Value>
            </DataList.Item>
            <DataList.Item className="data-row">
              <DataList.Label>{t("access.type")}</DataList.Label>
              <DataList.Value>{chat.type}</DataList.Value>
            </DataList.Item>
            <DataList.Item className="data-row">
              <DataList.Label>{t("access.telegramId")}</DataList.Label>
              <DataList.Value>
                <Code variant="ghost" className="access-id">
                  {chat.id}
                </Code>
              </DataList.Value>
            </DataList.Item>
          </DataList.Root>
          <Callout.Root color="orange" size="1" className="access-approval__notice">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>{t("access.approvalNotice")}</Callout.Text>
          </Callout.Root>
          <Button
            disabled={disabled || chat.expires <= Date.now()}
            onClick={() =>
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
      <Flex gap="2" mt="3" wrap="wrap" className="access-approval__actions">
        <Button variant="soft" disabled={disabled} onClick={() => setReload((v) => v + 1)}>
          {t("access.reloadRequest")}
        </Button>
        <Button variant="soft" disabled={disabled} onClick={clear}>
          {t("access.dismissRequest")}
        </Button>
      </Flex>
    </Panel>
  )
}
