import { InfoCircledIcon } from "@radix-ui/react-icons"
import { Badge, Button, Callout, Code, DataList, Flex, Heading } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request, type Snapshot } from "./api.js"
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
    <Panel className="access-approval" aria-label="Chat access approval request">
      <Flex gap="3" align="center" justify="between" wrap="wrap" className="section-heading">
        <Heading as="h2" size="4">
          Review chat access
        </Heading>
        <Badge color="orange">Approval link request</Badge>
      </Flex>
      {chat ? (
        <>
          <DataList.Root size="2" className="data-list access-approval__identity">
            <DataList.Item className="data-row">
              <DataList.Label>Chat</DataList.Label>
              <DataList.Value>{chat.name}</DataList.Value>
            </DataList.Item>
            <DataList.Item className="data-row">
              <DataList.Label>Type</DataList.Label>
              <DataList.Value>{chat.type}</DataList.Value>
            </DataList.Item>
            <DataList.Item className="data-row">
              <DataList.Label>Telegram ID</DataList.Label>
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
            <Callout.Text>
              Approve only this chat. Existing capability limits remain unchanged. Application
              cancels active work. This approval applies immediately, separately from pending policy
              changes.
            </Callout.Text>
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
            Approve chat
          </Button>
        </>
      ) : (
        <Prose size="2" className="empty-state" role="status">
          Load and review the chat before approval.
        </Prose>
      )}
      <Flex gap="2" mt="3" wrap="wrap" className="access-approval__actions">
        <Button variant="soft" disabled={disabled} onClick={() => setReload((v) => v + 1)}>
          Reload request
        </Button>
        <Button variant="soft" disabled={disabled} onClick={clear}>
          Dismiss request
        </Button>
      </Flex>
    </Panel>
  )
}
