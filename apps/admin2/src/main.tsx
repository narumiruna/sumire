import "./styles.css"
import { StrictMode, useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { AccessPage } from "./access.js"
import {
  ApiError,
  errorMessage,
  loadSettings,
  type Policy,
  request,
  type Session,
  type Snapshot,
  saveSettings,
} from "./api.js"
import { AuditPage } from "./audit.js"
import { ChatsPage } from "./chats.js"
import { captureSetupLink } from "./passkey.js"
import { href, liveSections, parseRoute, type Route, v1Sections } from "./routes.js"
import { SignIn } from "./sign-in.js"
import { Failure, type Load, Skeleton } from "./ui.js"

export type Settings = {
  load: Load<Snapshot>
  reload: () => Promise<void>
  /** Derive a policy from the latest snapshot and save it against that revision. */
  save: (change: (policy: Policy) => Policy) => Promise<Snapshot>
}
export type Navigate = (to: string, replace?: boolean) => void

const setup = captureSetupLink(window.location, window.history)

function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(() => parseRoute(window.location))
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location))
    window.addEventListener("popstate", sync)
    return () => window.removeEventListener("popstate", sync)
  }, [])
  const navigate = useCallback<Navigate>((to, replace) => {
    if (replace) window.history.replaceState(null, "", to)
    else window.history.pushState(null, "", to)
    setRoute(parseRoute(window.location))
  }, [])
  return [route, navigate]
}

function useSettings(session: Session, expire: () => void): Settings {
  const [load, setLoad] = useState<Load<Snapshot>>({ state: "loading" })
  const reload = useCallback(async () => {
    try {
      setLoad({ state: "ready", value: await loadSettings() })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) expire()
      setLoad({ state: "error", message: errorMessage(e) })
    }
  }, [expire])
  useEffect(() => {
    void reload()
  }, [reload])
  const save = useCallback<Settings["save"]>(
    async (change) => {
      const current = await loadSettings()
      try {
        const next = await saveSettings(session.csrf, current.revision, change(current.policy))
        setLoad({ state: "ready", value: next })
        return next
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) expire()
        throw e
      }
    },
    [session.csrf, expire],
  )
  return { load, reload, save }
}

function Shell({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [route, navigate] = useRoute()
  const settings = useSettings(session, onSignOut)
  const [menu, setMenu] = useState(false)
  const snapshot = settings.load.state === "ready" ? settings.load.value : undefined
  const link = (to: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    setMenu(false)
    navigate(to)
  }
  return (
    <div className="shell" data-menu={menu}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="bar">
        <a
          className="wordmark"
          href={href("chats")}
          onClick={link(href("chats"))}
          aria-label="Sumire console home"
        >
          Sumire
        </a>
        <button
          type="button"
          className="btn btn--quiet bar__menu"
          aria-expanded={menu}
          aria-controls="sidebar"
          onClick={() => setMenu(!menu)}
        >
          {menu ? "Close menu" : "Menu"}
        </button>
      </header>
      <nav className="sidebar" id="sidebar" aria-label="Console sections">
        <a
          className="wordmark sidebar__mark"
          href={href("chats")}
          onClick={link(href("chats"))}
          aria-label="Sumire console home"
        >
          Sumire
        </a>
        <ul className="nav">
          {liveSections.map((s) => (
            <li key={s.path}>
              <a
                className="nav__link"
                href={href(s.path)}
                aria-current={route.section === s.path ? "page" : undefined}
                onClick={link(href(s.path))}
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="nav__group" id="v1-group">
          Still in the v1 console
        </p>
        <ul className="nav nav--v1" aria-labelledby="v1-group">
          {v1Sections.map((label) => (
            <li key={label}>
              <a className="nav__link nav__link--v1" href="/">
                {label}
              </a>
            </li>
          ))}
        </ul>
        <div className="sidebar__foot">
          <dl className="facts">
            <div>
              <dt>Signed in</dt>
              <dd className="measured person">{session.actor}</dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd>
                {snapshot ? (
                  <>
                    <span className="measured instrument">r{snapshot.revision}</span>{" "}
                    {snapshot.applied === snapshot.revision
                      ? "applied"
                      : `saved, r${snapshot.applied} running`}
                  </>
                ) : (
                  "Loading"
                )}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={async () => {
              await request("logout", { csrf: session.csrf }).catch(() => undefined)
              onSignOut()
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="main" id="main">
        {settings.load.state === "loading" && <Skeleton rows={8} label="Loading settings" />}
        {settings.load.state === "error" && (
          <Failure message={settings.load.message} retry={() => void settings.reload()} />
        )}
        {settings.load.state === "ready" &&
          (route.section === "chats" ? (
            <ChatsPage route={route} navigate={navigate} settings={settings} />
          ) : route.section === "access" ? (
            <AccessPage navigate={navigate} settings={settings} />
          ) : (
            <AuditPage route={route} navigate={navigate} settings={settings} />
          ))}
      </main>
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>()
  const [error, setError] = useState("")
  const [setupLink, setSetupLink] = useState(setup)
  const check = useCallback(() => {
    setError("")
    request<Session>("session").then(setSession, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setSession(null)
      else setError(errorMessage(e))
    })
  }, [])
  useEffect(check, [check])
  const signOut = useCallback(() => setSession(null), [])
  if (error)
    return (
      <main className="signin" id="main">
        <Failure message={error} retry={check} />
      </main>
    )
  if (session === undefined)
    return (
      <main className="signin" id="main">
        <Skeleton rows={3} label="Checking administrator session" />
      </main>
    )
  if (!session || setupLink)
    return (
      <SignIn
        setup={setupLink}
        onSession={(next) => {
          setSetupLink("")
          setSession(next)
        }}
      />
    )
  return <Shell session={session} onSignOut={signOut} />
}

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
