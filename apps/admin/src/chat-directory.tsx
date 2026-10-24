import type { Chat } from "@narumitw/sumire-contracts"
import {
  ChatBubbleIcon,
  MagnifyingGlassIcon,
  PersonIcon,
  SpeakerLoudIcon,
} from "@radix-ui/react-icons"
import { Button, Code, Flex, Heading, Text, TextField } from "@radix-ui/themes"
import { type ReactNode, type Ref, useEffect, useId, useState } from "react"
import { ApiError, request } from "./api.js"
import { countText } from "./status-text.js"
import { Prose } from "./surfaces.js"

export function chatName(chat: Chat) {
  const name = chat.name?.trim()
  return name && name !== String(chat.id) ? name : `Unnamed ${chat.type || "chat"}`
}

export type SelectedChatMetadata = { chat?: Chat; loading: boolean; error: string }

export function directoryPath(offset: number, query = "") {
  const params = new URLSearchParams({ offset: String(offset) })
  if (query.trim()) params.set("q", query.trim())
  return `chats?${params}`
}

function readError(error: unknown) {
  return error instanceof ApiError && error.status === 403
    ? "Permission denied. Chat metadata is not available."
    : "Could not read chat metadata. Retry chats."
}

export function useChatDirectory(enabled: boolean, chat: string, onExpired: () => void) {
  const [page, setPage] = useState({ offset: 0, query: "" })
  const [revision, setRevision] = useState(0)
  const [knownChats, setKnownChats] = useState<Chat[]>([])
  const path = directoryPath(page.offset, page.query)
  const key = `${path}:${revision}`
  const [result, setResult] = useState<{ key: string; chats: Chat[]; error: string }>()
  const selectionKey = `${chat}:${revision}`
  const [selection, setSelection] = useState<{
    key: string
    chat?: Chat
    error: string
  }>()
  useEffect(() => {
    if (!enabled) {
      setKnownChats([])
      setResult(undefined)
      setSelection(undefined)
      return
    }
    const controller = new AbortController()
    void request<Chat[]>(path, undefined, undefined, "GET", controller.signal).then(
      (chats) => {
        if (controller.signal.aborted) return
        setResult({ key, chats, error: "" })
        setKnownChats((previous) => [
          ...new Map([...previous, ...chats].map((c) => [c.id, c])).values(),
        ])
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) return onExpired()
        setResult({ key, chats: [], error: readError(error) })
      },
    )
    return () => controller.abort()
  }, [enabled, key, path, onExpired])
  useEffect(() => {
    if (!enabled || !/^-?[1-9]\d*$/.test(chat) || !Number.isSafeInteger(Number(chat))) return
    const controller = new AbortController()
    void request<Chat[]>(
      `chats?id=${encodeURIComponent(chat)}`,
      undefined,
      undefined,
      "GET",
      controller.signal,
    ).then(
      (chats) => {
        if (controller.signal.aborted) return
        const metadata = chats.find((value) => String(value.id) === chat)
        setSelection({ key: selectionKey, chat: metadata, error: "" })
        if (metadata)
          setKnownChats((previous) => [
            ...new Map([...previous, metadata].map((c) => [c.id, c])).values(),
          ])
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) return onExpired()
        setSelection({ key: selectionKey, error: readError(error) })
      },
    )
    return () => controller.abort()
  }, [enabled, chat, selectionKey, onExpired])
  const current = enabled && result?.key === key ? result : undefined
  const selected = enabled && selection?.key === selectionKey ? selection : undefined
  return {
    chats: current?.chats ?? [],
    knownChats: enabled ? knownChats : [],
    loading: enabled && !current,
    error: current?.error ?? "",
    query: page.query,
    offset: page.offset,
    setQuery: (query: string) => setPage({ offset: 0, query }),
    setOffset: (offset: number) => setPage((value) => ({ ...value, offset })),
    refresh: () => setRevision((value) => value + 1),
    selected: {
      chat: selected?.chat,
      loading: Boolean(enabled && chat && !selected),
      error: selected?.error ?? "",
    } satisfies SelectedChatMetadata,
  }
}

export type ChatDirectory = ReturnType<typeof useChatDirectory>

export function ChatSelector({
  directory,
  chat,
  onSelect,
  searchRef,
  filters,
  visibleChats = directory.chats,
  badge,
  footer,
  title = "Find a chat",
  summary,
}: {
  directory: ChatDirectory
  chat: string
  onSelect(chat: string): void
  searchRef?: Ref<HTMLInputElement>
  filters?: ReactNode
  visibleChats?: Chat[]
  badge?(chat: Chat): ReactNode
  footer?: ReactNode
  title?: string
  summary?: ReactNode
}) {
  const searchId = useId()
  return (
    <>
      <div className="directory-header">
        <Flex className="directory-heading" align="center" gap="2">
          <ChatBubbleIcon aria-hidden="true" />
          <Heading size="3">{title}</Heading>
        </Flex>
        <div className="directory-toolbar">
          <label className="directory-search" htmlFor={searchId}>
            <Text size="1" weight="medium">
              Search stored chats
            </Text>
            <TextField.Root
              id={searchId}
              ref={searchRef}
              value={directory.query}
              maxLength={128}
              onChange={(event) => directory.setQuery(event.target.value)}
              placeholder="Name or complete chat ID"
            >
              <TextField.Slot>
                <MagnifyingGlassIcon aria-hidden="true" />
              </TextField.Slot>
            </TextField.Root>
          </label>
        </div>
        <details className="directory-options">
          <summary>{filters ? "Filters and search scope" : "Search scope"}</summary>
          {filters}
          <Prose size="1" color="gray">
            Search covers the stored directory, not all Telegram chats. Up to 100 matches per page.
          </Prose>
        </details>
        <div className="directory-result-status" aria-live="polite" aria-busy={directory.loading}>
          {directory.loading ? (
            <Text as="p" role="status">
              Loading chats…
            </Text>
          ) : directory.error ? (
            <>
              <Text as="p" role="alert">
                {directory.error}
              </Text>
              <Button onClick={directory.refresh}>Retry chats</Button>
            </>
          ) : !directory.chats.length ? (
            <Text as="p">
              {directory.query
                ? "No stored chats match this search."
                : "No chats observed on this page."}
            </Text>
          ) : !visibleChats.length ? (
            <Text as="p">No chats match the filters on this page.</Text>
          ) : (
            <Text as="p" size="1" color="gray">
              {visibleChats.length} of {countText(directory.chats.length, "chat")} on this page
            </Text>
          )}
        </div>
        {summary}
      </div>
      <div className="directory-list-region">
        {!directory.loading && !directory.error && (
          <ul className="chat-list" aria-label="Chats on this page">
            {visibleChats.map((value) => (
              <li key={value.id}>
                <Button asChild variant="ghost" className="directory-chat">
                  <button
                    type="button"
                    aria-current={chat === String(value.id) ? "true" : undefined}
                    aria-label={`${chatName(value)} · ${value.id}`}
                    aria-describedby={badge ? `directory-state-${value.id}` : undefined}
                    onClick={() => onSelect(String(value.id))}
                  >
                    <Flex asChild className="directory-chat-identity" align="start" gap="2">
                      <span>
                        {value.type === "private" ? (
                          <PersonIcon aria-hidden="true" />
                        ) : value.type === "channel" ? (
                          <SpeakerLoudIcon aria-hidden="true" />
                        ) : (
                          <ChatBubbleIcon aria-hidden="true" />
                        )}
                        <strong title={chatName(value)}>{chatName(value)}</strong>
                      </span>
                    </Flex>
                    <Text as="span" size="1" color="gray" className="directory-chat-meta">
                      <span>{value.type || "Type not known"}</span>
                      <Code variant="ghost">{value.id}</Code>
                    </Text>
                    {badge && (
                      <span id={`directory-state-${value.id}`} className="directory-chat-state">
                        {badge(value)}
                      </span>
                    )}
                  </button>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="directory-footer">
        <Flex gap="2" wrap="wrap" align="center">
          {(directory.offset !== 0 ||
            directory.loading ||
            Boolean(directory.error) ||
            directory.chats.length >= 100) && (
            <>
              <Button
                variant="soft"
                disabled={directory.loading || directory.offset === 0}
                onClick={() => directory.setOffset(Math.max(0, directory.offset - 100))}
              >
                Previous chats
              </Button>
              <Button
                variant="soft"
                disabled={
                  directory.loading || Boolean(directory.error) || directory.chats.length < 100
                }
                onClick={() => directory.setOffset(directory.offset + 100)}
              >
                Next chats
              </Button>
              <Text size="1" color="gray">
                Page {Math.floor(directory.offset / 100) + 1}
              </Text>
            </>
          )}
          <Button
            variant="ghost"
            className="navigation-control"
            disabled={directory.loading}
            onClick={directory.refresh}
          >
            Refresh chats
          </Button>
        </Flex>
        {footer}
      </footer>
    </>
  )
}
