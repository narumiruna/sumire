import { useEffect, useState } from "react"
import { type ChatKind, isApproved, parseChatId, withChatAccess } from "./access-policy.js"
import { type ChatResponse, errorMessage, request } from "./api.js"
import type { Navigate, Settings } from "./main.js"
import { href } from "./routes.js"
import { Empty, type Undo, UndoBar } from "./ui.js"

const lookupLimit = 100

/** Names come from the bot's chat directory; an ID the bot never saw has none. */
function useNames(ids: number[]) {
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const key = ids.slice(0, lookupLimit).join(",")
  useEffect(() => {
    const controller = new AbortController()
    const wanted = key ? key.split(",").map(Number) : []
    void Promise.all(
      wanted.map((id) =>
        request<ChatResponse[]>(`chats?id=${id}`, undefined, controller.signal).then(
          (rows) => [id, rows[0]?.name ?? ""] as const,
          () => [id, ""] as const,
        ),
      ),
    ).then((pairs) => {
      if (!controller.signal.aborted) setNames(new Map(pairs))
    })
    return () => controller.abort()
  }, [key])
  return names
}

export function AccessPage({ navigate, settings }: { navigate: Navigate; settings: Settings }) {
  const policy = settings.load.state === "ready" ? settings.load.value.policy : undefined
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<Undo>()
  useEffect(() => {
    if (!undo) return
    const timer = window.setTimeout(() => setUndo(undefined), 8000)
    return () => window.clearTimeout(timer)
  }, [undo])
  const people = policy?.privateUsers ?? []
  const groups = policy?.groups ?? []
  const names = useNames([...people, ...groups])
  if (!policy) return null
  const change = async (id: number, allowed: boolean) => {
    setBusy(true)
    setError("")
    try {
      await settings.save((p) => withChatAccess(p, id, allowed))
    } finally {
      setBusy(false)
    }
  }
  const revoke = (id: number) =>
    change(id, false).then(
      () =>
        setUndo({
          message: `Revoked ${id}.`,
          undo: () => change(id, true).catch((e: unknown) => setError(errorMessage(e))),
        }),
      (e: unknown) => setError(errorMessage(e)),
    )
  const list = (kind: ChatKind, title: string, ids: number[], empty: string) => (
    <section className="panel" aria-labelledby={`${kind}-title`}>
      <div className="panel__head">
        <h2 id={`${kind}-title`}>{title}</h2>
      </div>
      {ids.length === 0 ? (
        <Empty title={empty} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Telegram ID</th>
              <th scope="col">Name</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <tr key={id}>
                <td className="measured instrument">{id}</td>
                <th scope="row">
                  <a
                    className="row-link"
                    href={href("chats", { q: String(id), chat: String(id) })}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(href("chats", { q: String(id), chat: String(id) }))
                    }}
                  >
                    {names.get(id) || "Not seen yet"}
                  </a>
                </th>
                <td className="table__action">
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    disabled={busy}
                    onClick={() => void revoke(id)}
                    aria-label={`Revoke ${names.get(id) || id}`}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
  return (
    <div className="page">
      <header className="page__head">
        <h1>Access</h1>
        <p className="page__lede">The bot answers only the people and groups approved here.</p>
        <div className="counts">
          <div>
            <p className="reading-label">People approved</p>
            <p className="reading reading--large">{people.length}</p>
          </div>
          <div>
            <p className="reading-label">Groups approved</p>
            <p className="reading reading--large">{groups.length}</p>
          </div>
        </div>
      </header>
      <form
        className="filters"
        aria-label="Approve a chat"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault()
          const id = parseChatId(draft)
          if (id === undefined) {
            setError("Enter one Telegram ID: positive for a person, negative for a group.")
            document.getElementById("access-id")?.focus()
            return
          }
          if (isApproved(policy, id)) {
            setError(`${id} is already approved.`)
            return
          }
          try {
            await change(id, true)
            setDraft("")
          } catch (e) {
            setError(errorMessage(e))
          }
        }}
      >
        <div className="field">
          <label htmlFor="access-id">Telegram ID</label>
          <input
            id="access-id"
            className="input input--id"
            name="telegram-id"
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby="access-help"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy}>
          Approve
        </button>
        <p className="field__help field__help--row" id="access-help" role="alert">
          {error || "Approving applies the policy at once."}
        </p>
        <UndoBar value={undo} dismiss={() => setUndo(undefined)} />
      </form>
      <div className="pair">
        {list("privateUsers", "People", people, "No person is approved yet.")}
        {list("groups", "Groups and channels", groups, "No group is approved yet.")}
      </div>
    </div>
  )
}
