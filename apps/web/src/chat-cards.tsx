import type { Chat } from "@narumitw/sumire-contracts"
import { effectivePolicy } from "@narumitw/sumire-policy"
import { ActionButton } from "@react-spectrum/s2/ActionButton"
import { Button } from "@react-spectrum/s2/Button"
import AlertTriangle from "@react-spectrum/s2/icons/AlertTriangle"
import Checkmark from "@react-spectrum/s2/icons/Checkmark"
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight"
import Filter from "@react-spectrum/s2/icons/Filter"
import Group from "@react-spectrum/s2/icons/Group"
import More from "@react-spectrum/s2/icons/More"
import Settings from "@react-spectrum/s2/icons/Settings"
import User from "@react-spectrum/s2/icons/User"
import UsersLock from "@react-spectrum/s2/icons/UsersLock"
import VolumeTwo from "@react-spectrum/s2/icons/VolumeTwo"
import { Menu, MenuItem, MenuSection, MenuTrigger } from "@react-spectrum/s2/Menu"
import { ToggleButton } from "@react-spectrum/s2/ToggleButton"
import { type ReactNode, type Ref, useContext, useEffect, useId, useState } from "react"
import type { Inventory, Policy, Snapshot } from "./api.js"
import { type ChatDirectory, ChatSearchField, chatName } from "./chat-directory.js"
import { type ChatRepair, chatState } from "./chat-state.js"
import { t } from "./i18n.js"
import { navigationHref } from "./navigation.js"
import { withChatAccess } from "./policy-changes.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { SectionActive } from "./sections.js"
import { countText } from "./status-text.js"
import { StatusLabel } from "./surfaces.js"

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

export { UsersLock as ChatAccessIcon }

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
          {chat.type === "private" ? <User /> : chat.type === "channel" ? <VolumeTwo /> : <Group />}
        </span>
        <a
          className="chat-card-name directory-chat"
          aria-label={t("chat.identity", { name, id: chat.id })}
          href={navigationHref("Chats", String(chat.id))}
          aria-current={selected === String(chat.id) ? "true" : undefined}
          title={name}
          onClick={(event) => {
            if (
              event.defaultPrevented ||
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
        <div
          className="chat-card-status"
          title={t("chat.savedStatusHint")}
          data-status={!saved.approved ? "pending" : saved.enabled ? "enabled" : "disabled"}
        >
          <StatusLabel tone={!saved.approved ? "warning" : saved.enabled ? "success" : "neutral"}>
            {status}
          </StatusLabel>
        </div>
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
            <AlertTriangle />
            <span>{t("chat.chatDisabled")}</span>
            <ChevronRight />
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
            <AlertTriangle />
            <span>
              {issues.length > 1
                ? t("chat.needsAttentionCount", { count: issues.length })
                : t("chat.needsAttention")}
            </span>
            <ChevronRight />
          </button>
        </div>
      )}
      <div className="chat-card-actions">
        {saved.approved ? (
          <Button
            UNSAFE_className="chat-card-primary"
            variant="accent"
            size="XL"
            isDisabled={busy}
            onPress={() => onConfigure(chat)}
          >
            <Settings />
            {t("chat.configure")}
          </Button>
        ) : (
          <>
            <Button
              UNSAFE_className="chat-card-primary"
              variant="accent"
              size="XL"
              isDisabled={busy}
              onPress={() => onChange(withChatAccess(policy, chat.id, !approved))}
            >
              <Checkmark />
              {approved ? t("chat.cancelApproval") : t("chat.approve")}
            </Button>
            <Button
              variant="secondary"
              fillStyle="outline"
              size="XL"
              UNSAFE_className="chat-card-secondary"
              isDisabled={busy}
              onPress={() => onOpen(chat)}
            >
              {t("chat.view")}
            </Button>
          </>
        )}
        <MenuTrigger align="end" isOpen={menuOpen && active && !busy} onOpenChange={setMenuOpen}>
          <ActionButton
            UNSAFE_className="chat-card-menu"
            size="XL"
            isQuiet
            isDisabled={busy || !active}
            aria-label={t("chat.moreActions", { name })}
          >
            <More />
          </ActionButton>
          {menuOpen && active && !busy && (
            <Menu size="XL">
              <MenuSection>
                <MenuItem onAction={() => onOpen(chat)}>{t("chat.viewDetails")}</MenuItem>
                <MenuItem onAction={() => void copyId()}>{t("chat.copyId")}</MenuItem>
                <MenuItem onAction={() => onRepair(chat, "access")}>
                  {t("chat.manageAccess")}
                </MenuItem>
              </MenuSection>
              <MenuSection>
                <MenuItem onAction={() => onChange(withChatAccess(policy, chat.id, !approved))}>
                  {approved
                    ? pending
                      ? t("chat.cancelPendingApproval")
                      : t("chat.revokeApproval")
                    : pending
                      ? t("chat.cancelPendingRevocation")
                      : t("chat.approveAccess")}
                </MenuItem>
              </MenuSection>
            </Menu>
          )}
        </MenuTrigger>
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
        <ChatSearchField
          inputRef={searchRef}
          aria-label={t("chat.search")}
          placeholder={t("chat.search")}
          value={directory.query}
          maxLength={128}
          onChange={directory.setQuery}
        />
        <Button
          UNSAFE_className="chat-card-filter"
          aria-label={t("chat.filter")}
          variant="secondary"
          fillStyle="outline"
          size="XL"
          aria-expanded={filtersOpen}
          aria-controls={filterId}
          onPress={() => setFiltersOpen(!filtersOpen)}
        >
          <Filter />
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
          <ToggleButton
            key={value}
            size="XL"
            isEmphasized
            isSelected={scope === value}
            onPress={() => {
              setScope(value)
              setAccess("all")
            }}
          >
            {t(label)}
          </ToggleButton>
        ))}
      </fieldset>
      <section
        className="chat-card-filters"
        id={filterId}
        hidden={!filtersOpen}
        aria-label={t("chat.searchFilterOptions")}
      >
        <label htmlFor={typeId}>{t("chat.chatType")}</label>
        <SectionPicker
          value={type}
          onValueChange={setType}
          id={typeId}
          aria-label={t("chat.chatType")}
        >
          <PickerOption id="all">{t("chat.allTypes")}</PickerOption>
          <PickerOption id="private">{t("chat.private")}</PickerOption>
          <PickerOption id="group">{t("chat.groupSupergroup")}</PickerOption>
          <PickerOption id="channel">{t("chat.channel")}</PickerOption>
          <PickerOption id="unknown">{t("chat.unknownType")}</PickerOption>
        </SectionPicker>
        <label htmlFor={accessId}>{t("chat.accessFilter")}</label>
        <SectionPicker
          value={access}
          onValueChange={(value) => {
            setAccess(value)
            setScope("all")
          }}
          id={accessId}
          aria-label={t("chat.accessFilter")}
        >
          <PickerOption id="all">{t("chat.allAccess")}</PickerOption>
          <PickerOption id="allowed">{t("chat.approvedEnabled")}</PickerOption>
          <PickerOption id="denied">{t("chat.notApprovedDisabled")}</PickerOption>
        </SectionPicker>
        <p>{t("chat.filterHelp")}</p>
        {(directory.query || type !== "all" || scope !== "all" || access !== "all") && (
          <Button
            variant="secondary"
            size="XL"
            onPress={() => {
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
          <Button size="XL" onPress={directory.refresh}>
            {t("chat.reload")}
          </Button>
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
            variant="secondary"
            size="XL"
            UNSAFE_className="chat-card-return"
            onPress={() => {
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
              variant="secondary"
              fillStyle="outline"
              size="XL"
              isDisabled={directory.loading || directory.offset === 0}
              onPress={() => directory.setOffset(Math.max(0, directory.offset - 100))}
            >
              {t("chat.previous")}
            </Button>
            <span>{t("chat.page", { page: Math.floor(directory.offset / 100) + 1 })}</span>
            <Button
              variant="secondary"
              fillStyle="outline"
              size="XL"
              isDisabled={
                directory.loading || Boolean(directory.error) || directory.chats.length < 100
              }
              onPress={() => directory.setOffset(directory.offset + 100)}
            >
              {t("chat.next")}
            </Button>
          </nav>
        )}
      </footer>
    </>
  )
}
