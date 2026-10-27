import { useState } from "react"
import type { Session } from "./api.js"
import { errorMessage } from "./api.js"
import { signInWithPasskey } from "./passkey.js"

export function SignIn({ setup, onSession }: { setup: string; onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return (
    <main className="signin" id="main">
      <div className="signin__panel">
        <p className="wordmark">Sumire</p>
        <h1>{setup ? "Register this passkey" : "Sign in to the console"}</h1>
        <p className="signin__lede">
          {setup
            ? "This setup link adds a passkey for the bot administrator."
            : "Use the passkey registered for the bot administrator."}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          aria-busy={busy}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError("")
            try {
              onSession(await signInWithPasskey(setup))
            } catch (e) {
              setError(errorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? "Waiting for passkey" : setup ? "Register passkey" : "Sign in with passkey"}
        </button>
        <p className="field__help" role="alert">
          {error}
        </p>
      </div>
    </main>
  )
}
