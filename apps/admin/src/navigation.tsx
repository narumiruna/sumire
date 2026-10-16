import { GearIcon, HamburgerMenuIcon } from "@radix-ui/react-icons"
import { Button, Heading, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"

export const pages = [
  "Chats",
  "Access",
  "Defaults",
  "Tool permissions",
  "MCP connections",
  "Model Providers",
  "Audit",
] as const
export type Page = (typeof pages)[number]

export function readNavigation(url: URL) {
  const section = url.searchParams.get("section")
  const chat = url.searchParams.get("chat") ?? ""
  return {
    page:
      section === "Tools / MCP"
        ? "Tool permissions"
        : (pages.find((page) => page === section) ?? "Chats"),
    chat: /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat)) ? chat : "",
  }
}

export function navigationHref(page: Page, chat: string, url = new URL(window.location.href)) {
  url.searchParams.set("section", page)
  if (/^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat)))
    url.searchParams.set("chat", chat)
  else url.searchParams.delete("chat")
  return `${url.pathname}${url.search}${url.hash}`
}

export function useNavigation() {
  const [state, setState] = useState(() => readNavigation(new URL(window.location.href)))
  useEffect(() => {
    const restore = () => setState(readNavigation(new URL(window.location.href)))
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [])
  return {
    ...state,
    setPage: (page: Page, anchor?: string) => {
      const url = new URL(window.location.href)
      if (anchor) url.hash = anchor
      else if (url.hash === "#default-tool-permissions") url.hash = ""
      const href = navigationHref(page, readNavigation(url).chat, url)
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== href)
        window.history.pushState(null, "", href)
      setState((current) => ({ ...current, page }))
    },
    setChat: (chat: string) => {
      window.history.replaceState(null, "", navigationHref(state.page, chat))
      setState((current) => ({ ...current, chat }))
    },
  }
}

export function SideNavigation({
  page,
  chat,
  actor,
  onNavigate,
}: {
  page: Page
  chat: string
  actor: string
  onNavigate(page: Page): void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <aside className="sidebar" aria-label="Administration navigation">
      <Heading size="5" className="brand">
        <GearIcon aria-hidden /> Sumire
      </Heading>
      <Button
        ref={trigger}
        className="mobile-menu"
        variant="soft"
        aria-expanded={open}
        aria-controls="section-navigation"
        onClick={() => setOpen(!open)}
      >
        <HamburgerMenuIcon aria-hidden /> Sections · {page}
      </Button>
      <nav id="section-navigation" aria-label="Administration sections" data-open={open}>
        {pages.map((item) => (
          <a
            key={item}
            href={navigationHref(item, chat)}
            aria-current={page === item ? "page" : undefined}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              event.preventDefault()
              onNavigate(item)
              setOpen(false)
              if (open) trigger.current?.focus()
            }}
          >
            {item}
          </a>
        ))}
      </nav>
      <Text className="sidebar-account" size="2">
        Administrator <span>{actor}</span>
      </Text>
    </aside>
  )
}
