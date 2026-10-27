import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser"
import { ApiError } from "./api.js"

export function captureSetupLink(location: Location, history: History) {
  const params = new URLSearchParams(location.hash.slice(1))
  const value = params.get("setup") ?? ""
  if (params.has("setup")) history.replaceState(null, "", location.pathname + location.search)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ""
}

async function post<T>(path: string, value: unknown): Promise<T> {
  const response = await fetch(`/auth/passkey/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  })
  const data = await response.json()
  if (!response.ok) throw new ApiError(response.status, data.error ?? "Passkey sign-in failed")
  return data as T
}

export async function signInWithPasskey(setup: string) {
  const kind = setup ? "register" : "authenticate"
  const response = setup
    ? await startRegistration({
        optionsJSON: await post<PublicKeyCredentialCreationOptionsJSON>(`${kind}/options`, {
          setup,
        }),
      })
    : await startAuthentication({
        optionsJSON: await post<PublicKeyCredentialRequestOptionsJSON>(`${kind}/options`, {}),
      })
  return post<{ csrf: string; actor: string }>(`${kind}/verify`, { response })
}
