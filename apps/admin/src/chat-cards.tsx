import type { Chat } from "@narumitw/sumire-contracts"
import { effectivePolicy } from "@narumitw/sumire-policy"
import {
  CheckIcon,
  ChevronRightIcon,
  DotsHorizontalIcon,
  ExclamationTriangleIcon,
  GearIcon,
  MagnifyingGlassIcon,
  PersonIcon,
  SpeakerLoudIcon,
} from "@radix-ui/react-icons"
import { Button, DropdownMenu, TextField } from "@radix-ui/themes"
import { type ReactNode, type Ref, useContext, useEffect, useId, useState } from "react"
import type { Inventory, Policy, Snapshot } from "./api.js"
import { type ChatDirectory, chatName } from "./chat-directory.js"
import { type ChatRepair, chatState } from "./chat-state.js"
import { t } from "./i18n.js"
import { navigationHref } from "./navigation.js"
import { withChatAccess } from "./policy-changes.js"
import { SectionActive, SectionSelect } from "./sections.js"
import { countText } from "./status-text.js"

export type ChatScope = "all" | "enabled" | "pending"

/** Filters describe saved approval and enablement, never runtime availability. */
export function matchesChatScope(chat: Chat, policy: Policy, scope: ChatScope) {
  const approved = policy[chat.id > 0 ? "privateUsers" : "groups"].includes(chat.id)
  return (
    scope === "all" ||
    (scope === "pending" ? !approved : approved && effectivePolicy(policy, chat.id).enabled)
  )
}

export function chatModelName(model: string | null, inventory: Inventory) {
  if (!model) return t("chat.notConfigured")
  for (const provider of inventory.providers) {
    const found = provider.models.find((candidate) => `${provider.id}/${candidate.id}` === model)
    if (found) return found.name || found.id
  }
  return model.slice(model.indexOf("/") + 1)
}

export function ChatAccessIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 3.5 6v6c0 5 8.5 9 8.5 9s8.5-4 8.5-9V6L12 3Z" />
      <path d="m8 12 2.5 2.5L16 9" />
    </svg>
  )
}

function ChatFilterIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4h18l-7 9v7l-4-2v-5L3 4Z" />
    </svg>
  )
}

function GroupIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="7" r="3" />
      <circle cx="4.5" cy="8.5" r="2.5" />
      <circle cx="19.5" cy="8.5" r="2.5" />
      <path d="M7 20v-5a5 5 0 0 1 10 0v5H7ZM1 19v-4a3.5 3.5 0 0 1 5.2-3.1A6.8 6.8 0 0 0 5 16v3H1Zm18 0v-3a6.8 6.8 0 0 0-1.2-4.1A3.5 3.5 0 0 1 23 15v4h-4Z" />
    </svg>
  )
}

type Application = Pick<Snapshot, "revision" | "applied" | "status">

type CardProps = {
  chat: Chat
  selected: string
  policy: Policy
  savedPolicy: Policy
  inventory: Inventory
  application: Application
  busy: boolean
  onOpen(chat: Chat): void
  onConfigure(chat: Chat): void
  onRepair(chat: Chat, target: ChatRepair): void
  onChange(policy: Policy): void
}

export function ChatCard({
  chat,
  selected,
  policy,
  savedPolicy,
  inventory,
  application,
  busy,
  onOpen,
  onConfigure,
  onRepair,
  onChange,
}: CardProps) {
  const active = useContext(SectionActive)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState<"" | "copied" | "failed">("")
  useEffect(() => {
    if (!active || busy) setMenuOpen(false)
  }, [active, busy])
  const saved = chatState(chat.id, savedPolicy, inventory, application)
  const approved = policy[chat.id > 0 ? "privateUsers" : "groups"].includes(chat.id)
  const pending = approved !== saved.approved
  const issues = saved.issues.filter(
    (issue) => issue.code !== "approval" && issue.code !== "disabled",
  )
  const issue = issues[0]
  const name = chatName(chat)
  const status = !saved.approved
    ? t("chat.pendingApproval")
    : saved.enabled
      ? t("chat.enabled")
      : t("chat.disabled")
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(String(chat.id))
      setCopyStatus("copied")
    } catch {
      setCopyStatus("failed")
    }
  }
  return (
    <li className="chat-card" data-chat-id={chat.id}>
      <div className="chat-card-header">
        <span className="chat-card-avatar">
          {chat.type === "private" ? (
            <PersonIcon />
          ) : chat.type === "channel" ? (
            <SpeakerLoudIcon />
          ) : (
            <GroupIcon />
          )}
        </span>
        <a
          className="chat-card-name directory-chat"
          aria-label={t("chat.identity", { name, id: chat.id })}
          href={navigationHref("Chats", String(chat.id))}
          aria-current={selected === String(chat.id) ? "true" : undefined}
          title={name}
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
            onOpen(chat)
          }}
        >
          <strong title={name}>{name}</strong>
        </a>
        <span
          className="chat-card-status"
          title={t("chat.savedStatusHint")}
          data-status={!saved.approved ? "pending" : saved.enabled ? "enabled" : "disabled"}
        >
          <span aria-hidden="true" />
          {status}
        </span>
      </div>
      {saved.approved ? (
        <dl className="chat-card-facts">
          <div>
            <dt>{t("chat.model")}</dt>
            <dd title={saved.effective.model ?? undefined}>
              {chatModelName(saved.effective.model, inventory)}
            </dd>
          </div>
          <div>
            <dt>{t("chat.source")}</dt>
            <dd>
              {saved.effective.sources.model === "chat"
                ? t("chat.individualSettings")
                : t("chat.sharedSettings")}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="chat-card-waiting">{t("chat.waitingApproval")}</p>
      )}
      {pending && (
        <p className="chat-card-pending" role="status">
          {approved ? t("chat.approvalUnsaved") : t("chat.revocationUnsaved")}
        </p>
      )}
      {saved.approved && !saved.enabled && (
        <div className="chat-card-warning-slot">
          <button
            type="button"
            className="chat-card-warning"
            disabled={busy}
            onClick={() => onRepair(chat, "enabled")}
          >
            <ExclamationTriangleIcon aria-hidden="true" />
            <span>{t("chat.chatDisabled")}</span>
            <ChevronRightIcon aria-hidden="true" />
          </button>
        </div>
      )}
      {saved.approved && issue && (
        <div className="chat-card-warning-slot">
          <button
            type="button"
            className="chat-card-warning"
            disabled={busy}
            onClick={() => onRepair(chat, issue.target)}
          >
            <ExclamationTriangleIcon aria-hidden="true" />
            <span>
              {issues.length > 1
                ? t("chat.needsAttentionCount", { count: issues.length })
                : t("chat.needsAttention")}
            </span>
            <ChevronRightIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="chat-card-actions">
        {saved.approved ? (
          <Button className="chat-card-primary" disabled={busy} onClick={() => onConfigure(chat)}>
            <GearIcon aria-hidden="true" />
            {t("chat.configure")}
          </Button>
        ) : (
          <>
            <Button
              className="chat-card-primary"
              disabled={busy}
              onClick={() => onChange(withChatAccess(policy, chat.id, !approved))}
            >
              <CheckIcon aria-hidden="true" />
              {approved ? t("chat.cancelApproval") : t("chat.approve")}
            </Button>
            <Button
              variant="outline"
              className="chat-card-secondary"
              disabled={busy}
              onClick={() => onOpen(chat)}
            >
              {t("chat.view")}
            </Button>
          </>
        )}
        <DropdownMenu.Root open={menuOpen && active && !busy} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger>
            <Button
              variant="ghost"
              className="chat-card-menu"
              disabled={busy}
              aria-label={t("chat.moreActions", { name })}
            >
              <DotsHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            align="end"
            onCloseAutoFocus={(event) => {
              if (!active || busy) event.preventDefault()
            }}
          >
            <DropdownMenu.Item onSelect={() => onOpen(chat)}>
              {t("chat.viewDetails")}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void copyId()}>{t("chat.copyId")}</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => onRepair(chat, "access")}>
              {t("chat.manageAccess")}
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              color={approved ? "red" : undefined}
              onSelect={() => onChange(withChatAccess(policy, chat.id, !approved))}
            >
              {approved
                ? pending
                  ? t("chat.cancelPendingApproval")
                  : t("chat.revokeApproval")
                : pending
                  ? t("chat.cancelPendingRevocation")
                  : t("chat.approveAccess")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      {copyStatus && (
        <p className="chat-card-copy" role="status">
          {copyStatus === "copied" ? t("chat.copied") : t("chat.copyManualId", { id: chat.id })}
        </p>
      )}
    </li>
  )
}

export function ChatCards({
  directory,
  searchRef,
  children,
  ...props
}: Omit<CardProps, "chat"> & {
  directory: ChatDirectory
  searchRef?: Ref<HTMLInputElement>
  children?: ReactNode
}) {
  const [scope, setScope] = useState<ChatScope>("all")
  const [type, setType] = useState("all")
  const [access, setAccess] = useState("all")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const searchId = useId()
  const typeId = useId()
  const accessId = useId()
  const filterId = useId()
  const visible = directory.chats.filter(
    (chat) =>
      matchesChatScope(chat, props.savedPolicy, scope) &&
      (access === "all" ||
        effectivePolicy(props.savedPolicy, chat.id).enabled === (access === "allowed")) &&
      (type === "all" ||
        (type === "group"
          ? ["group", "supergroup"].includes(chat.type)
          : type === "unknown"
            ? !["private", "group", "supergroup", "channel"].includes(chat.type)
            : chat.type === type)),
  )
  return (
    <>
      <p className="chat-card-count" aria-live="polite" aria-busy={directory.loading}>
        {directory.loading
          ? t("chat.loadingShort")
          : directory.error
            ? t("chat.loadFailed")
            : t(
                directory.offset ||
                  directory.chats.length >= 100 ||
                  scope !== "all" ||
                  type !== "all"
                  ? "chat.pageCount"
                  : "chat.count",
                { count: countText(visible.length, "chat") },
              )}
      </p>
      <div className="chat-card-toolbar">
        <TextField.Root
          id={searchId}
          ref={searchRef}
          aria-label={t("chat.search")}
          placeholder={t("chat.search")}
          value={directory.query}
          maxLength={128}
          onChange={(event) => directory.setQuery(event.target.value)}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon aria-hidden="true" />
          </TextField.Slot>
        </TextField.Root>
        <Button
          className="chat-card-filter"
          aria-label={t("chat.filter")}
          variant="outline"
          aria-expanded={filtersOpen}
          aria-controls={filterId}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <ChatFilterIcon />
          {t("chat.filter")}
          {(type !== "all" || access !== "all") && (
            <span className="chat-filter-dot" role="img" aria-label={t("chat.typeFilterApplied")} />
          )}
        </Button>
      </div>
      <fieldset className="chat-card-scopes" aria-label={t("chat.statusFilter")}>
        {(
          [
            ["all", "chat.all"],
            ["enabled", "chat.enabled"],
            ["pending", "chat.pendingApproval"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            onClick={() => {
              setScope(value)
              setAccess("all")
            }}
          >
            {t(label)}
          </button>
        ))}
      </fieldset>
      <section
        className="chat-card-filters"
        id={filterId}
        hidden={!filtersOpen}
        aria-label={t("chat.searchFilterOptions")}
      >
        <label htmlFor={typeId}>{t("chat.chatType")}</label>
        <SectionSelect.Root value={type} onValueChange={setType}>
          <SectionSelect.Trigger id={typeId} />
          <SectionSelect.Content>
            <SectionSelect.Item value="all">{t("chat.allTypes")}</SectionSelect.Item>
            <SectionSelect.Item value="private">{t("chat.private")}</SectionSelect.Item>
            <SectionSelect.Item value="group">{t("chat.groupSupergroup")}</SectionSelect.Item>
            <SectionSelect.Item value="channel">{t("chat.channel")}</SectionSelect.Item>
            <SectionSelect.Item value="unknown">{t("chat.unknownType")}</SectionSelect.Item>
          </SectionSelect.Content>
        </SectionSelect.Root>
        <label htmlFor={accessId}>{t("chat.accessFilter")}</label>
        <SectionSelect.Root
          value={access}
          onValueChange={(value) => {
            setAccess(value)
            setScope("all")
          }}
        >
          <SectionSelect.Trigger id={accessId} />
          <SectionSelect.Content>
            <SectionSelect.Item value="all">{t("chat.allAccess")}</SectionSelect.Item>
            <SectionSelect.Item value="allowed">{t("chat.approvedEnabled")}</SectionSelect.Item>
            <SectionSelect.Item value="denied">{t("chat.notApprovedDisabled")}</SectionSelect.Item>
          </SectionSelect.Content>
        </SectionSelect.Root>
        <p>{t("chat.filterHelp")}</p>
        {(directory.query || type !== "all" || scope !== "all" || access !== "all") && (
          <Button
            variant="soft"
            onClick={() => {
              directory.setQuery("")
              setType("all")
              setScope("all")
              setAccess("all")
            }}
          >
            {t("chat.clearFilters")}
          </Button>
        )}
        {children}
      </section>
      {directory.error ? (
        <div className="chat-card-empty">
          <p role="alert">{directory.error}</p>
          <Button onClick={directory.refresh}>{t("chat.reload")}</Button>
        </div>
      ) : !directory.loading && visible.length === 0 ? (
        <p className="chat-card-empty">
          {directory.query ? t("chat.noSearchMatchesShort") : t("chat.noPageMatches")}
        </p>
      ) : null}
      <ul className="chat-cards chat-list directory-list-region" aria-label={t("chat.onPage")}>
        {!directory.loading &&
          !directory.error &&
          visible.map((chat) => <ChatCard key={chat.id} {...props} chat={chat} />)}
      </ul>
      <footer className="directory-footer chat-card-footer">
        {props.selected && (
          <Button
            variant="soft"
            className="chat-card-return"
            onClick={() => {
              const current = directory.knownChats.find(
                (entry) => String(entry.id) === props.selected,
              ) ?? { id: Number(props.selected), name: "", type: "" }
              props.onOpen(current)
            }}
          >
            {t("chat.selected")}
          </Button>
        )}
        {(directory.offset > 0 || directory.chats.length >= 100) && (
          <nav className="chat-card-pagination" aria-label={t("chat.pagination")}>
            <Button
              variant="outline"
              disabled={directory.loading || directory.offset === 0}
              onClick={() => directory.setOffset(Math.max(0, directory.offset - 100))}
            >
              {t("chat.previous")}
            </Button>
            <span>{t("chat.page", { page: Math.floor(directory.offset / 100) + 1 })}</span>
            <Button
              variant="outline"
              disabled={
                directory.loading || Boolean(directory.error) || directory.chats.length < 100
              }
              onClick={() => directory.setOffset(directory.offset + 100)}
            >
              {t("chat.next")}
            </Button>
          </nav>
        )}
      </footer>
    </>
  )
}
