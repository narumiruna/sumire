const key = "sumire.pending-chat-access"
const pattern = /^[a-f0-9]{64}$/

export function tabStorage(browser: Pick<Window, "sessionStorage">) {
  try {
    return browser.sessionStorage
  } catch {
    return undefined
  }
}

export function clearAccessLink(storage: Storage | undefined) {
  try {
    storage?.removeItem(key)
  } catch {
    // Storage can be disabled. The caller also clears its in-memory intent.
  }
}

export function captureAccessLink(
  location: Location,
  history: History,
  storage: Storage | undefined,
  now = Date.now(),
) {
  const params = new URLSearchParams(location.hash.slice(1))
  const incoming = params.get("allow")
  if (incoming !== null) {
    history.replaceState(null, "", location.pathname + location.search)
    clearAccessLink(storage)
    if (!pattern.test(incoming)) return ""
    try {
      storage?.setItem(key, JSON.stringify({ token: incoming, expires: now + 900_000 }))
    } catch {
      // The current page can still review the link without persistent browser storage.
    }
    return incoming
  }
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? "null")
    if (
      saved &&
      typeof saved.token === "string" &&
      pattern.test(saved.token) &&
      Number.isFinite(saved.expires) &&
      saved.expires > now
    )
      return saved.token as string
  } catch {
    // Invalid or unavailable tab storage must not prevent administrator sign-in.
  }
  clearAccessLink(storage)
  return ""
}
