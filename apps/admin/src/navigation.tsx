import {
  ActivityLogIcon,
  ChatBubbleIcon,
  ComponentInstanceIcon,
  HamburgerMenuIcon,
  LayersIcon,
  LockClosedIcon,
  MixerHorizontalIcon,
  ReaderIcon,
  TokensIcon,
} from "@radix-ui/react-icons"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import { Button, Flex, Heading, Separator, Text } from "@radix-ui/themes"
import { Fragment, useEffect, useRef, useState } from "react"
import { BrandIcon } from "./brand-icon.js"

export const pages = [
  "Chats",
  "Durable",
  "Access",
  "Defaults",
  "Tool permissions",
  "Skills",
  "MCP connections",
  "Model Providers",
  "Audit",
] as const
export type Page = (typeof pages)[number]

export type EditorTarget = { page: Page; selector: string; chat?: string }

export const pendingEditors = {
  access: {
    label: "Chat access — Telegram ID to approve",
    target: { page: "Access", selector: "#access-id-input" },
  },
  tool: {
    label: "Tool permissions — Additional approved tool name",
    target: { page: "Tool permissions", selector: "#tool-input" },
  },
  endpoint: {
    label: "Model providers — Custom endpoint",
    target: { page: "Model Providers", selector: "#endpoint-provider-id" },
  },
  secret: {
    label: "MCP Servers — Secret replacement",
    target: { page: "MCP connections", selector: "#secret-name" },
  },
} satisfies Record<string, { label: string; target: EditorTarget }>
export type PendingEditor = keyof typeof pendingEditors

/** Open native disclosures before focusing. Never read or copy field values. */
export function focusEditor(selector: string) {
  const target = document.querySelector<HTMLElement>(selector)
  if (!target) return
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  if (!target.checkVisibility()) return
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: "center", behavior: "instant" })
}
const pageIcons = {
  Chats: ChatBubbleIcon,
  Durable: LayersIcon,
  Access: LockClosedIcon,
  Defaults: MixerHorizontalIcon,
  "Tool permissions": TokensIcon,
  Skills: ReaderIcon,
  "MCP connections": ComponentInstanceIcon,
  "Model Providers": ReaderIcon,
  Audit: ActivityLogIcon,
} satisfies Record<Page, typeof ChatBubbleIcon>
const pageLabels = {
  Chats: "Chats",
  Durable: "Conversation records",
  Access: "Chat access",
  Defaults: "Shared defaults",
  "Tool permissions": "Tool permissions",
  Skills: "Skills",
  "MCP connections": "MCP Servers",
  "Model Providers": "Model providers",
  Audit: "Audit",
} satisfies Record<Page, string>
export const pageLabel = (page: Page) => pageLabels[page]
const navigationGroups = [
  { id: "chat-management", label: "Chats", pages: ["Chats", "Access", "Durable"] },
  { id: "models", label: "Models", pages: ["Model Providers"] },
  {
    id: "tools-and-skills",
    label: "Tools & skills",
    pages: ["Tool permissions", "Skills", "MCP connections"],
  },
  { id: "system-settings", label: "Defaults", pages: ["Defaults"] },
  { id: "activity", label: "Activity", pages: ["Audit"] },
] as const satisfies readonly { id: string; label: string; pages: readonly Page[] }[]
const technicalDescriptions: Partial<Record<Page, string>> = {
  Durable: "Durable Inspector: stored conversations and execution records.",
  "MCP connections": "Model Context Protocol (MCP) connections.",
}

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

const sectionAnchors: Record<string, Page> = {
  "#model-availability": "Model Providers",
  "#default-tool-permissions": "Tool permissions",
}

export function navigationHref(page: Page, chat: string, url = new URL(window.location.href)) {
  if (sectionAnchors[url.hash] && sectionAnchors[url.hash] !== page) url.hash = ""
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

export function useNavigation(ready = true) {
  const [state, setState] = useState(() => {
    const url = new URL(window.location.href)
    const navigation = readNavigation(url)
    return {
      ...navigation,
      target: sectionAnchors[url.hash] === navigation.page ? url.hash.slice(1) : undefined,
    }
  })
  const targetFrame = useRef<number | undefined>(undefined)
  const hasBeenReady = useRef(ready)
  const cancelTargetFocus = () => {
    if (targetFrame.current !== undefined) cancelAnimationFrame(targetFrame.current)
    targetFrame.current = undefined
  }
  useEffect(() => {
    const restore = () => {
      if (targetFrame.current !== undefined) cancelAnimationFrame(targetFrame.current)
      targetFrame.current = undefined
      setState({ ...readNavigation(new URL(window.location.href)), target: undefined })
    }
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [])
  useEffect(() => {
    // Wait for the first destination render, but do not retain a request across session expiry.
    if (!ready) {
      if (hasBeenReady.current && state.target)
        setState((current) => ({ ...current, target: undefined }))
      return
    }
    hasBeenReady.current = true
    const target = state.target
    if (target) {
      targetFrame.current = requestAnimationFrame(() => {
        targetFrame.current = undefined
        focusEditor(`#${CSS.escape(target)}`)
        setState((current) => (current === state ? { ...current, target: undefined } : current))
      })
    }
    return () => {
      if (targetFrame.current !== undefined) cancelAnimationFrame(targetFrame.current)
      targetFrame.current = undefined
    }
  }, [ready, state])
  return {
    page: state.page,
    chat: state.chat,
    setPage: (page: Page, anchor?: string) => {
      cancelTargetFocus()
      const url = new URL(window.location.href)
      if (anchor) url.hash = anchor
      else if (sectionAnchors[url.hash]) url.hash = ""
      const href = navigationHref(page, readNavigation(url).chat, url)
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== href)
        window.history.pushState(null, "", href)
      setState((current) => ({ ...current, page, target: anchor || undefined }))
    },
    setChat: (chat: string) => {
      cancelTargetFocus()
      const href = navigationHref(state.page, chat)
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== href)
        window.history.pushState(null, "", href)
      setState((current) => ({ ...current, chat, target: undefined }))
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
  const navigationFrame = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current)
    },
    [],
  )
  return (
    <aside className="sidebar" aria-label="Administration navigation">
      <Flex direction="column" gap="1" className="sidebar-brand">
        <Heading size="5" className="brand">
          <BrandIcon /> Sumire
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
        <HamburgerMenuIcon aria-hidden />
        <span className="section-trigger-label">Sections · {pageLabel(page)}</span>
      </Button>
      <nav id="section-navigation" aria-label="Administration sections" data-open={open}>
        {navigationGroups.map((group) => (
          <section
            key={group.id}
            className="navigation-group"
            aria-labelledby={`navigation-${group.id}`}
          >
            <Heading
              as="h2"
              id={`navigation-${group.id}`}
              aria-label={`${group.label} navigation`}
              className="navigation-group-title"
              size="1"
              weight="medium"
              color="gray"
            >
              {group.label}
            </Heading>
            {group.pages.map((item) => {
              const Icon = pageIcons[item]
              const description = technicalDescriptions[item]
              const descriptionId = `navigation-description-${item.replaceAll(" ", "-")}`
              return (
                <Fragment key={item}>
                  <a
                    href={navigationHref(item, chat)}
                    aria-current={page === item ? "page" : undefined}
                    aria-describedby={description ? descriptionId : undefined}
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
                      if (navigationFrame.current !== undefined)
                        cancelAnimationFrame(navigationFrame.current)
                      onNavigate(item)
                      setOpen(false)
                      if (trigger.current?.checkVisibility()) trigger.current.focus()
                      else {
                        const link = event.currentTarget
                        navigationFrame.current = requestAnimationFrame(() => {
                          navigationFrame.current = undefined
                          if (!link.isConnected || link.getAttribute("aria-current") !== "page")
                            return
                          const heading = document.getElementById("current-section-heading")
                          heading?.focus({ preventScroll: true })
                          window.scrollTo({ top: 0, behavior: "instant" })
                        })
                      }
                    }}
                  >
                    <Icon aria-hidden />
                    <span>{pageLabel(item)}</span>
                  </a>
                  {description && (
                    <VisuallyHidden.Root id={descriptionId}>{description}</VisuallyHidden.Root>
                  )}
                </Fragment>
              )
            })}
          </section>
        ))}
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
