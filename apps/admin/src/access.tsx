import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request, type Snapshot } from "./api.js"

type Props = {
  csrf: string
  snapshot: Snapshot
  disabled: boolean
  run: (action: () => Promise<void>) => Promise<void>
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
        })
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
    <Card>
      <Heading size="4">Review chat access</Heading>
      {chat ? (
        <>
          <Text as="p">
            {chat.name} · {chat.type} · {chat.id}
          </Text>
          <Text as="p">
            Approve only this chat. Existing capability limits remain unchanged. Application cancels
            active work.
          </Text>
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
        <Text as="p">Load and review the chat before approval.</Text>
      )}
      <Flex gap="2" mt="2">
        <Button variant="soft" disabled={disabled} onClick={() => setReload((v) => v + 1)}>
          Reload request
        </Button>
        <Button variant="soft" disabled={disabled} onClick={clear}>
          Dismiss request
        </Button>
      </Flex>
    </Card>
  )
}
