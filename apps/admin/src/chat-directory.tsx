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
import { t } from "./i18n.js"
import { countText } from "./status-text.js"
import { Prose } from "./surfaces.js"

export function chatName(chat: Chat) {
  const name = chat.name?.trim()
  return name && name !== String(chat.id)
    ? name
    : chat.type
      ? t("chat.unnamedType", { type: chat.type })
      : t("chat.unnamed")
}

export type SelectedChatMetadata = { chat?: Chat; loading: boolean; error: string }

export function directoryPath(offset: number, query = "") {
  const params = new URLSearchParams({ offset: String(offset) })
  if (query.trim()) params.set("q", query.trim())
  return `chats?${params}`
}

function readError(error: unknown) {
  return error instanceof ApiError && error.status === 403
    ? "chat.metadataDenied"
    : "chat.metadataFailed"
}

type MetadataError = ReturnType<typeof readError> | ""

export function useChatDirectory(enabled: boolean, chat: string, onExpired: () => void) {
  const [page, setPage] = useState({ offset: 0, query: "" })
  const [revision, setRevision] = useState(0)
  const [knownChats, setKnownChats] = useState<Chat[]>([])
  const path = directoryPath(page.offset, page.query)
  const key = `${path}:${revision}`
  const [result, setResult] = useState<{ key: string; chats: Chat[]; error: MetadataError }>()
  const selectionKey = `${chat}:${revision}`
  const [selection, setSelection] = useState<{
    key: string
    chat?: Chat
    error: MetadataError
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
    error: current?.error ? t(current.error) : "",
    query: page.query,
    offset: page.offset,
    setQuery: (query: string) => setPage({ offset: 0, query }),
    setOffset: (offset: number) => setPage((value) => ({ ...value, offset })),
    refresh: () => setRevision((value) => value + 1),
    selected: {
      chat: selected?.chat,
      loading: Boolean(enabled && chat && !selected),
      error: selected?.error ? t(selected.error) : "",
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
  actions,
  footer,
  title = t("chat.find"),
  summary,
  columns,
}: {
  directory: ChatDirectory
  chat: string
  onSelect(chat: string): void
  searchRef?: Ref<HTMLInputElement>
  filters?: ReactNode
  visibleChats?: Chat[]
  badge?(chat: Chat): ReactNode
  actions?(chat: Chat): ReactNode
  footer?: ReactNode
  title?: string | null
  summary?: ReactNode
  columns?: {
    model(chat: Chat): ReactNode
    issues(chat: Chat): ReactNode
    copyId(chat: Chat): ReactNode
    href(chat: Chat): string
  }
}) {
  const searchId = useId()
  const ChatControl = columns ? "a" : "button"
  return (
    <>
      <div className="directory-header">
        {title && (
          <Flex className="directory-heading" align="center" gap="2">
            <ChatBubbleIcon aria-hidden="true" />
            <Heading size="3">{title}</Heading>
          </Flex>
        )}
        <div className="directory-toolbar">
          <label className="directory-search" htmlFor={searchId}>
            <Text size="1" weight="medium">
              {t("chat.searchStored")}
            </Text>
            <TextField.Root
              id={searchId}
              ref={searchRef}
              value={directory.query}
              maxLength={128}
              onChange={(event) => directory.setQuery(event.target.value)}
              placeholder={t("chat.nameOrId")}
            >
              <TextField.Slot>
                <MagnifyingGlassIcon aria-hidden="true" />
              </TextField.Slot>
            </TextField.Root>
          </label>
        </div>
        <details className="directory-options">
          <summary>{filters ? t("chat.filtersSearchScope") : t("chat.searchScope")}</summary>
          {filters}
          <Prose size="1" color="gray">
            {t("chat.directoryScope")}
          </Prose>
        </details>
        <div className="directory-result-status" aria-live="polite" aria-busy={directory.loading}>
          {directory.loading ? (
            <Text as="p" role="status">
              {t("chat.loading")}
            </Text>
          ) : directory.error ? (
            <>
              <Text as="p" role="alert">
                {directory.error}
              </Text>
              <Button onClick={directory.refresh}>{t("chat.retry")}</Button>
            </>
          ) : !directory.chats.length ? (
            <Text as="p">{directory.query ? t("chat.noSearchMatches") : t("chat.noObserved")}</Text>
          ) : !visibleChats.length ? (
            <Text as="p">{t("chat.noFilterMatches")}</Text>
          ) : (
            <Text as="p" size="1" color="gray">
              {t("chat.visibleCount", {
                visible: visibleChats.length,
                total: countText(directory.chats.length, "chat"),
              })}
            </Text>
          )}
        </div>
        {summary}
      </div>
      <div className="directory-list-region">
        {!directory.loading && !directory.error && (
          <>
            {actions && visibleChats.length > 0 && (
              <div
                className="directory-columns"
                data-management={Boolean(columns)}
                aria-hidden="true"
              >
                <span>{columns ? t("chat.chat") : t("chat.chatId")}</span>
                <span>{columns ? t("chat.access") : t("chat.accessStatus")}</span>
                {columns && <span>{t("chat.effectiveModel")}</span>}
                {columns && <span>{t("chat.configurationIssues")}</span>}
                <span>{columns ? t("chat.actions") : ""}</span>
              </div>
            )}
            <ul className="chat-list" aria-label={t("chat.onPage")}>
              {visibleChats.map((value) => (
                <li
                  key={value.id}
                  className={actions ? "directory-row" : undefined}
                  data-management={Boolean(columns)}
                >
                  <div
                    className={columns ? "directory-identity-cell" : undefined}
                    style={columns ? undefined : { display: "contents" }}
                  >
                    <Button asChild variant="ghost" className="directory-chat">
                      <ChatControl
                        type={columns ? undefined : "button"}
                        href={columns?.href(value)}
                        aria-current={chat === String(value.id) ? "true" : undefined}
                        aria-label={t("chat.identity", { name: chatName(value), id: value.id })}
                        aria-describedby={badge ? `directory-state-${value.id}` : undefined}
                        onClick={(event) => {
                          if (
                            columns &&
                            (event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey)
                          )
                            return
                          event.preventDefault()
                          onSelect(String(value.id))
                        }}
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
                          <span>{value.type || t("chat.typeUnknown")}</span>
                          <Code variant="ghost">{value.id}</Code>
                        </Text>
                        {badge && !actions && (
                          <span id={`directory-state-${value.id}`} className="directory-chat-state">
                            {badge(value)}
                          </span>
                        )}
                      </ChatControl>
                    </Button>
                    {columns?.copyId(value)}
                  </div>
                  {actions && (
                    <>
                      <div id={`directory-state-${value.id}`} className="directory-row-state">
                        {badge?.(value)}
                      </div>
                      {columns && (
                        <section className="directory-model" aria-label={t("chat.effectiveModel")}>
                          {columns.model(value)}
                        </section>
                      )}
                      {columns && (
                        <section
                          className="directory-issues"
                          aria-label={t("chat.configurationIssues")}
                        >
                          {columns.issues(value)}
                        </section>
                      )}
                      <div className="directory-row-actions">{actions(value)}</div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
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
                {t("chat.previousChats")}
              </Button>
              <Button
                variant="soft"
                disabled={
                  directory.loading || Boolean(directory.error) || directory.chats.length < 100
                }
                onClick={() => directory.setOffset(directory.offset + 100)}
              >
                {t("chat.nextChats")}
              </Button>
              <Text size="1" color="gray">
                {t("chat.page", { page: Math.floor(directory.offset / 100) + 1 })}
              </Text>
            </>
          )}
          <Button
            variant="ghost"
            className="navigation-control"
            disabled={directory.loading}
            onClick={directory.refresh}
          >
            {t("chat.refresh")}
          </Button>
        </Flex>
        {footer}
      </footer>
    </>
  )
}
