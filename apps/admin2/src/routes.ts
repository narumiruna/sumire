export const base = "/v2/"

export const liveSections = [
  { path: "chats", label: "Chats" },
  { path: "access", label: "Access" },
  { path: "audit", label: "Audit trail" },
] as const
export type SectionPath = (typeof liveSections)[number]["path"]

/** Sections that v2 does not rebuild yet; each opens the v1 console. */
export const v1Sections = [
  "Conversation records",
  "Shared defaults",
  "Tool permissions",
  "Skills",
  "MCP connections",
  "Model providers",
] as const

export type Route = { section: SectionPath; params: URLSearchParams }

export function parseRoute(location: Pick<Location, "pathname" | "search">): Route {
  const rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : ""
  const name = rest.replace(/\/+$/, "")
  const section = liveSections.find((s) => s.path === name)?.path ?? "chats"
  return { section, params: new URLSearchParams(location.search) }
}

export function href(section: SectionPath, params?: Record<string, string | number | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {}))
    if (value !== undefined && value !== "") search.set(key, String(value))
  const query = search.toString()
  return `${base}${section}${query ? `?${query}` : ""}`
}
