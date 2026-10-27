import { effectivePolicy } from "@narumitw/sumire-policy"
import { useCallback, useEffect, useState } from "react"
import { accessState, withChatAccess } from "./access-policy.js"
import { type ChatResponse, errorMessage, request } from "./api.js"
import type { Navigate, Settings } from "./main.js"
import { href, type Route } from "./routes.js"
import { Chip, Empty, Failure, type Load, Skeleton, type Undo, UndoBar } from "./ui.js"

const pageSize = 100
const typeLabel = (type: string) =>
  type === "private"
    ? "Person"
    : type === "supergroup"
      ? "Supergroup"
      : type === "group"
        ? "Group"
        : type

export function ChatsPage({
  route,
  navigate,
  settings,
}: {
  route: Route
  navigate: Navigate
  settings: Settings
}) {
  const q = route.params.get("q") ?? ""
  const offset = Math.max(0, Number(route.params.get("offset")) || 0)
  const selected = route.params.get("chat") ?? ""
  const [draft, setDraft] = useState(q)
  const [chats, setChats] = useState<Load<ChatResponse[]>>({ state: "loading" })
  const [reload, setReload] = useState(0)
  useEffect(() => setDraft(q), [q])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload after access changes.
  useEffect(() => {
    const controller = new AbortController()
    setChats({ state: "loading" })
    const query = new URLSearchParams({ offset: String(offset) })
    if (q) query.set("q", q)
    request<ChatResponse[]>(`chats?${query}`, undefined, controller.signal).then(
      (value) => setChats({ state: "ready", value }),
      (e: unknown) => {
        if (!controller.signal.aborted) setChats({ state: "error", message: errorMessage(e) })
      },
    )
    return () => controller.abort()
  }, [q, offset, reload])
  const to = (next: { q?: string; offset?: number; chat?: string }) =>
    href("chats", {
      q: next.q ?? q,
      offset: (next.offset ?? offset) || undefined,
      chat: next.chat === undefined ? selected : next.chat,
    })
  const rows = chats.state === "ready" ? chats.value : []
  const chat = rows.find((c) => String(c.id) === selected)
  return (
    <div className="page">
      <header className="page__head">
        <h1>Chats</h1>
        <p className="page__lede">Every chat that has written to the bot, and what it may use.</p>
      </header>
      <search>
        <form
          className="filters"
          aria-label="Search chats"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(to({ q: draft.trim(), offset: 0, chat: "" }))
          }}
        >
          <div className="field field--grow">
            <label htmlFor="chat-q">Name or Telegram ID</label>
            <input
              id="chat-q"
              className="input"
              name="q"
              type="search"
              autoComplete="off"
              maxLength={128}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <button type="submit" className="btn">
            Search
          </button>
          {q && (
            <a
              className="btn btn--quiet"
              href={href("chats")}
              onClick={(e) => {
                e.preventDefault()
                navigate(href("chats"))
              }}
            >
              Clear
            </a>
          )}
        </form>
      </search>
      <div className="split" data-detail={Boolean(selected)}>
        <section className="panel panel--scroll" aria-label="Chat directory">
          {chats.state === "loading" && <Skeleton rows={6} label="Loading chats" />}
          {chats.state === "error" && (
            <Failure message={chats.message} retry={() => setReload((n) => n + 1)} />
          )}
          {chats.state === "ready" && rows.length === 0 && (
            <Empty title={q ? `No chat matches “${q}”.` : "No chat has written to the bot yet."}>
              <p className="state__body">
                {q
                  ? "Search matches names and exact Telegram IDs."
                  : "Chats appear here after their first message. Approve one ahead of time from Access."}
              </p>
            </Empty>
          )}
          {rows.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Chat</th>
                  <th scope="col">Telegram ID</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Access</th>
                  <th scope="col">Model</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} aria-selected={String(c.id) === selected}>
                    <th scope="row">
                      <a
                        className="row-link"
                        href={to({ chat: String(c.id) })}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(to({ chat: String(c.id) }), true)
                        }}
                      >
                        {c.name || "Unnamed chat"}
                      </a>
                    </th>
                    <td className="measured instrument">{c.id}</td>
                    <td>{typeLabel(c.type)}</td>
                    <td>
                      {c.effective.enabled ? (
                        <Chip tone="ok">Approved</Chip>
                      ) : (
                        <Chip tone="quiet">Not approved</Chip>
                      )}
                    </td>
                    <td className="measured">{c.effective.model ?? "Default"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(offset > 0 || rows.length === pageSize) && (
            <div className="pager">
              <a
                className="btn btn--quiet"
                aria-disabled={offset === 0}
                href={to({ offset: Math.max(0, offset - pageSize), chat: "" })}
                onClick={(e) => {
                  e.preventDefault()
                  if (offset > 0) navigate(to({ offset: Math.max(0, offset - pageSize), chat: "" }))
                }}
              >
                Previous {pageSize}
              </a>
              <span className="measured">
                {offset + 1} to {offset + rows.length}
              </span>
              <a
                className="btn btn--quiet"
                aria-disabled={rows.length < pageSize}
                href={to({ offset: offset + pageSize, chat: "" })}
                onClick={(e) => {
                  e.preventDefault()
                  if (rows.length === pageSize)
                    navigate(to({ offset: offset + pageSize, chat: "" }))
                }}
              >
                Next {pageSize}
              </a>
            </div>
          )}
        </section>
        {selected && (
          <ChatDetail
            key={selected}
            id={Number(selected)}
            chat={chat}
            settings={settings}
            close={() => navigate(to({ chat: "" }), true)}
            changed={() => setReload((n) => n + 1)}
          />
        )}
      </div>
    </div>
  )
}

function ChatDetail({
  id,
  chat,
  settings,
  close,
  changed,
}: {
  id: number
  chat: ChatResponse | undefined
  settings: Settings
  close: () => void
  changed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [undo, setUndo] = useState<Undo>()
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(undefined), 8000)
    return () => window.clearTimeout(timer)
  }, [undo])
  const policy = settings.load.state === "ready" ? settings.load.value.policy : undefined
  const apply = useCallback(
    async (allowed: boolean) => {
      setBusy(true)
      setError("")
      try {
        await settings.save((p) => withChatAccess(p, id, allowed))
        changed()
      } catch (e) {
        setError(errorMessage(e))
        throw e
      } finally {
        setBusy(false)
      }
    },
    [settings, id, changed],
  )
  if (!policy || !Number.isSafeInteger(id) || id === 0) return null
  const access = accessState(policy, id)
  const effective = effectivePolicy(policy, id)
  const list = (values: string[]) =>
    values.length ? (
      <ul className="tags">
        {values.map((v) => (
          <li key={v} className="measured">
            {v}
          </li>
        ))}
      </ul>
    ) : (
      <span className="measured muted">none</span>
    )
  const source = (key: string) =>
    effective.sources[key] === "chat" ? <Chip tone="person">Set for this chat</Chip> : null
  return (
    <aside className="panel detail" aria-labelledby="chat-title">
      <div className="detail__head">
        <div>
          <h2 id="chat-title">{chat?.name || "Chat"}</h2>
          <p>
            <span className="measured instrument">{id}</span>{" "}
            {chat && <span className="muted">{typeLabel(chat.type)}</span>}
          </p>
        </div>
        <button type="button" className="btn btn--quiet" onClick={close}>
          Close
        </button>
      </div>
      <div className="detail__access">
        <p className="reading-label">Access</p>
        <p className={`reading ${access.allowed ? "reading--ok" : ""}`}>{access.label}</p>
        {access.allowed ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              void apply(false).then(
                () =>
                  setUndo({
                    message: "Access revoked.",
                    undo: () => apply(true).catch(() => undefined),
                  }),
                () => undefined,
              )
            }
          >
            Revoke access
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || access.label !== "Not approved"}
            aria-busy={busy}
            onClick={() => void apply(true).catch(() => undefined)}
          >
            Approve this chat
          </button>
        )}
        <p className="field__help" role="alert">
          {error ||
            (access.label === "Approved, chat disabled"
              ? "Approved, but a chat override disables it. Change that in the v1 console."
              : "Saving applies the policy at once and cancels this chat’s active work.")}
        </p>
        <UndoBar value={undo} dismiss={() => setUndo(undefined)} />
      </div>
      <dl className="facts facts--grid">
        <div>
          <dt>Model {source("model")}</dt>
          <dd className="measured">{effective.model ?? "None selected"}</dd>
        </div>
        <div>
          <dt>Thinking {source("thinking")}</dt>
          <dd className="measured">{effective.thinking}</dd>
        </div>
        <div>
          <dt>Tools {source("tools")}</dt>
          <dd>{list(effective.tools)}</dd>
        </div>
        <div>
          <dt>Skills {source("skills")}</dt>
          <dd>{list(effective.skills)}</dd>
        </div>
        <div>
          <dt>MCP servers {source("servers")}</dt>
          <dd>{list(effective.servers)}</dd>
        </div>
      </dl>
    </aside>
  )
}
