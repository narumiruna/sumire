import type { Chat } from "@narumitw/sumire-contracts"
import { ActionButton } from "@react-spectrum/s2/ActionButton"
import { Button } from "@react-spectrum/s2/Button"
import ChatIcon from "@react-spectrum/s2/icons/Chat"
import Search from "@react-spectrum/s2/icons/Search"
import User from "@react-spectrum/s2/icons/User"
import VolumeTwo from "@react-spectrum/s2/icons/VolumeTwo"
import { TextField, type TextFieldProps, type TextFieldRef } from "@react-spectrum/s2/TextField"
import { type ReactNode, type Ref, useCallback, useEffect, useState } from "react"
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

export function ChatSearchField({
  inputRef,
  "aria-label": name,
  ...props
}: Pick<
  TextFieldProps,
  "aria-label" | "autoComplete" | "label" | "maxLength" | "onChange" | "placeholder" | "value"
> & { inputRef?: Ref<HTMLInputElement> }) {
  const setInput = useCallback(
    (field: TextFieldRef | null) => {
      const input = field?.getInputElement() ?? null
      if (typeof inputRef === "function") return inputRef(input)
      if (inputRef) inputRef.current = input
    },
    [inputRef],
  )
  return (
    <TextField
      {...props}
      {...(!props.label && name
        ? { label: name, UNSAFE_className: "chat-search-field chat-search-with-hidden-label" }
        : { UNSAFE_className: "chat-search-field" })}
      ref={inputRef ? setInput : undefined}
      size="XL"
      prefix={<Search />}
    />
  )
}

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
  return (
    <>
      <div className="directory-header">
        {title && (
          <div className="directory-heading">
            <ChatIcon />
            <h3 className="chat-heading">{title}</h3>
          </div>
        )}
        <div className="directory-toolbar">
          <div className="directory-search">
            <ChatSearchField
              label={t("chat.searchStored")}
              inputRef={searchRef}
              value={directory.query}
              maxLength={128}
              onChange={directory.setQuery}
              placeholder={t("chat.nameOrId")}
            />
          </div>
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
            <Prose role="status">{t("chat.loading")}</Prose>
          ) : directory.error ? (
            <>
              <Prose role="alert">{directory.error}</Prose>
              <Button size="XL" onPress={directory.refresh}>
                {t("chat.retry")}
              </Button>
            </>
          ) : !directory.chats.length ? (
            <Prose>{directory.query ? t("chat.noSearchMatches") : t("chat.noObserved")}</Prose>
          ) : !visibleChats.length ? (
            <Prose>{t("chat.noFilterMatches")}</Prose>
          ) : (
            <Prose size="1" color="gray">
              {t("chat.visibleCount", {
                visible: visibleChats.length,
                total: countText(directory.chats.length, "chat"),
              })}
            </Prose>
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
              {visibleChats.map((value) => {
                const id = String(value.id)
                const name = chatName(value)
                const attributes = {
                  "aria-current": chat === id ? ("true" as const) : undefined,
                  "aria-label": t("chat.identity", { name, id: value.id }),
                  "aria-describedby": badge ? `directory-state-${id}` : undefined,
                }
                const identity = (
                  <>
                    <span className="directory-chat-identity">
                      {value.type === "private" ? (
                        <User />
                      ) : value.type === "channel" ? (
                        <VolumeTwo />
                      ) : (
                        <ChatIcon />
                      )}
                      <strong title={name}>{name}</strong>
                    </span>
                    <span className="directory-chat-meta">
                      <span>{value.type || t("chat.typeUnknown")}</span>
                      <code>{value.id}</code>
                    </span>
                    {badge && !actions && (
                      <span id={`directory-state-${id}`} className="directory-chat-state">
                        {badge(value)}
                      </span>
                    )}
                  </>
                )
                return (
                  <li
                    key={value.id}
                    className={actions ? "directory-row" : undefined}
                    data-management={Boolean(columns)}
                  >
                    <div
                      className={columns ? "directory-identity-cell" : undefined}
                      style={columns ? undefined : { display: "contents" }}
                    >
                      {columns ? (
                        <a
                          {...attributes}
                          className="directory-chat"
                          href={columns.href(value)}
                          onClick={(event) => {
                            if (
                              event.defaultPrevented ||
                              event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return
                            event.preventDefault()
                            onSelect(id)
                          }}
                        >
                          {identity}
                        </a>
                      ) : (
                        <ActionButton
                          {...attributes}
                          size="XL"
                          UNSAFE_className="directory-chat"
                          isQuiet
                          onPress={() => onSelect(id)}
                        >
                          {identity}
                        </ActionButton>
                      )}
                      {columns?.copyId(value)}
                    </div>
                    {actions && (
                      <>
                        <div id={`directory-state-${value.id}`} className="directory-row-state">
                          {badge?.(value)}
                        </div>
                        {columns && (
                          <section
                            className="directory-model"
                            aria-label={t("chat.effectiveModel")}
                          >
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
                )
              })}
            </ul>
          </>
        )}
      </div>
      <footer className="directory-footer">
        <div className="chat-control-row">
          {(directory.offset !== 0 ||
            directory.loading ||
            Boolean(directory.error) ||
            directory.chats.length >= 100) && (
            <>
              <Button
                size="XL"
                variant="secondary"
                isDisabled={directory.loading || directory.offset === 0}
                onPress={() => directory.setOffset(Math.max(0, directory.offset - 100))}
              >
                {t("chat.previousChats")}
              </Button>
              <Button
                size="XL"
                variant="secondary"
                isDisabled={
                  directory.loading || Boolean(directory.error) || directory.chats.length < 100
                }
                onPress={() => directory.setOffset(directory.offset + 100)}
              >
                {t("chat.nextChats")}
              </Button>
              <span className="directory-page">
                {t("chat.page", { page: Math.floor(directory.offset / 100) + 1 })}
              </span>
            </>
          )}
          <ActionButton
            size="XL"
            isQuiet
            UNSAFE_className="navigation-control"
            isDisabled={directory.loading}
            onPress={directory.refresh}
          >
            {t("chat.refresh")}
          </ActionButton>
        </div>
        {footer}
      </footer>
    </>
  )
}
