import {
  ActivityLogIcon,
  ChatBubbleIcon,
  ComponentInstanceIcon,
  GearIcon,
  HamburgerMenuIcon,
  LayersIcon,
  LockClosedIcon,
  MixerHorizontalIcon,
  ReaderIcon,
  TokensIcon,
} from "@radix-ui/react-icons"
import { Button, Flex, Heading, Separator, Text } from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"

export const pages = [
  "Chats",
  "Durable",
  "Access",
  "Defaults",
  "Tool permissions",
  "MCP connections",
  "Model Providers",
  "Audit",
] as const
export type Page = (typeof pages)[number]
const pageIcons = {
  Chats: ChatBubbleIcon,
  Durable: LayersIcon,
  Access: LockClosedIcon,
  Defaults: MixerHorizontalIcon,
  "Tool permissions": TokensIcon,
  "MCP connections": ComponentInstanceIcon,
  "Model Providers": ReaderIcon,
  Audit: ActivityLogIcon,
} satisfies Record<Page, typeof GearIcon>
export const pageLabel = (page: Page) => (page === "Model Providers" ? "Model providers" : page)

export function readNavigation(url: URL) {
  const raw = url.searchParams.get("section")
  const section = raw === "Model providers" ? "Model Providers" : raw
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
  if (page !== "Durable" || url.searchParams.get("chat") !== chat) {
    for (const key of ["view", "conversationId", "scope", "taskId", "objectId"])
      url.searchParams.delete(key)
  }
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
      const href = navigationHref(state.page, chat)
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== href)
        window.history.pushState(null, "", href)
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
      <Flex direction="column" gap="1" className="sidebar-brand">
        <Heading size="5" className="brand">
          <GearIcon aria-hidden /> Sumire
        </Heading>
        <Text size="1" color="gray" className="brand-caption">
          Administration
        </Text>
      </Flex>
      <Button
        ref={trigger}
        className="mobile-menu"
        variant="soft"
        aria-expanded={open}
        aria-controls="section-navigation"
        onClick={() => setOpen(!open)}
      >
        <HamburgerMenuIcon aria-hidden /> Sections · {pageLabel(page)}
      </Button>
      <nav id="section-navigation" aria-label="Administration sections" data-open={open}>
        {pages.map((item) => {
          const Icon = pageIcons[item]
          return (
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
              <Icon aria-hidden />
              <span>{pageLabel(item)}</span>
            </a>
          )
        })}
      </nav>
      <Flex direction="column" gap="3" className="sidebar-account">
        <Separator size="4" />
        <Text size="1" color="gray">
          Administrator
        </Text>
        <Text size="2" weight="medium">
          {actor}
        </Text>
      </Flex>
    </aside>
  )
}
