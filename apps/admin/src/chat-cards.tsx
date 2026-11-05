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
import { navigationHref } from "./navigation.js"
import { withChatAccess } from "./policy-changes.js"
import { SectionActive, SectionSelect } from "./sections.js"

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
  if (!model) return "尚未設定"
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
  const [copyStatus, setCopyStatus] = useState("")
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
  const status = !saved.approved ? "待核准" : saved.enabled ? "已啟用" : "已停用"
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(String(chat.id))
      setCopyStatus("已複製聊天 ID")
    } catch {
      setCopyStatus(`無法複製，請至詳細資料手動複製聊天 ID：${chat.id}`)
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
          aria-label={`${name} · ${chat.id}`}
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
          title="已儲存政策狀態，尚未驗證模型回應"
          data-status={!saved.approved ? "pending" : saved.enabled ? "enabled" : "disabled"}
        >
          <span aria-hidden="true" />
          {status}
        </span>
      </div>
      {saved.approved ? (
        <dl className="chat-card-facts">
          <div>
            <dt>模型</dt>
            <dd title={saved.effective.model ?? undefined}>
              {chatModelName(saved.effective.model, inventory)}
            </dd>
          </div>
          <div>
            <dt>來源</dt>
            <dd>{saved.effective.sources.model === "chat" ? "個別設定" : "共用設定"}</dd>
          </div>
        </dl>
      ) : (
        <p className="chat-card-waiting">等待管理員核准</p>
      )}
      {pending && (
        <p className="chat-card-pending" role="status">
          {approved ? "核准待儲存" : "撤銷核准待儲存"}
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
            <span>聊天已停用</span>
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
            <span>需要處理{issues.length > 1 ? `（${issues.length}）` : ""}</span>
            <ChevronRightIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="chat-card-actions">
        {saved.approved ? (
          <Button className="chat-card-primary" disabled={busy} onClick={() => onConfigure(chat)}>
            <GearIcon aria-hidden="true" />
            設定
          </Button>
        ) : (
          <>
            <Button
              className="chat-card-primary"
              disabled={busy}
              onClick={() => onChange(withChatAccess(policy, chat.id, !approved))}
            >
              <CheckIcon aria-hidden="true" />
              {approved ? "取消核准" : "核准"}
            </Button>
            <Button
              variant="outline"
              className="chat-card-secondary"
              disabled={busy}
              onClick={() => onOpen(chat)}
            >
              查看
            </Button>
          </>
        )}
        <DropdownMenu.Root open={menuOpen && active && !busy} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger>
            <Button
              variant="ghost"
              className="chat-card-menu"
              disabled={busy}
              aria-label={`${name}的更多操作`}
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
            <DropdownMenu.Item onSelect={() => onOpen(chat)}>查看詳細資料</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void copyId()}>複製聊天 ID</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => onRepair(chat, "access")}>
              管理存取權限
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              color={approved ? "red" : undefined}
              onSelect={() => onChange(withChatAccess(policy, chat.id, !approved))}
            >
              {approved
                ? pending
                  ? "取消待儲存核准"
                  : "撤銷核准"
                : pending
                  ? "取消待儲存撤銷"
                  : "核准存取"}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      {copyStatus && (
        <p className="chat-card-copy" role="status">
          {copyStatus}
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
          ? "載入中…"
          : directory.error
            ? "無法載入聊天"
            : `${visible.length} 個聊天${directory.offset || directory.chats.length >= 100 || scope !== "all" || type !== "all" ? "（本頁）" : ""}`}
      </p>
      <div className="chat-card-toolbar">
        <TextField.Root
          id={searchId}
          ref={searchRef}
          aria-label="搜尋聊天"
          placeholder="搜尋聊天"
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
          aria-label="篩選"
          variant="outline"
          aria-expanded={filtersOpen}
          aria-controls={filterId}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <ChatFilterIcon />
          篩選
          {(type !== "all" || access !== "all") && (
            <span className="chat-filter-dot" role="img" aria-label="已套用類型篩選" />
          )}
        </Button>
      </div>
      <fieldset className="chat-card-scopes" aria-label="聊天狀態篩選">
        {(
          [
            ["all", "全部"],
            ["enabled", "已啟用"],
            ["pending", "待核准"],
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
            {label}
          </button>
        ))}
      </fieldset>
      <section
        className="chat-card-filters"
        id={filterId}
        hidden={!filtersOpen}
        aria-label="搜尋與篩選選項"
      >
        <label htmlFor={typeId}>Chat type</label>
        <SectionSelect.Root value={type} onValueChange={setType}>
          <SectionSelect.Trigger id={typeId} />
          <SectionSelect.Content>
            <SectionSelect.Item value="all">All types</SectionSelect.Item>
            <SectionSelect.Item value="private">Private</SectionSelect.Item>
            <SectionSelect.Item value="group">Group / supergroup</SectionSelect.Item>
            <SectionSelect.Item value="channel">Channel</SectionSelect.Item>
            <SectionSelect.Item value="unknown">Unknown type</SectionSelect.Item>
          </SectionSelect.Content>
        </SectionSelect.Root>
        <label htmlFor={accessId}>Access status</label>
        <SectionSelect.Root
          value={access}
          onValueChange={(value) => {
            setAccess(value)
            setScope("all")
          }}
        >
          <SectionSelect.Trigger id={accessId} />
          <SectionSelect.Content>
            <SectionSelect.Item value="all">All access</SectionSelect.Item>
            <SectionSelect.Item value="allowed">Approved and enabled</SectionSelect.Item>
            <SectionSelect.Item value="denied">Not approved or disabled</SectionSelect.Item>
          </SectionSelect.Content>
        </SectionSelect.Root>
        <p>
          可搜尋名稱或完整聊天
          ID。搜尋涵蓋已儲存的聊天；類型與狀態篩選僅套用本頁，狀態以已儲存的設定為準，不代表已驗證模型可用。
        </p>
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
            清除搜尋與篩選
          </Button>
        )}
        {children}
      </section>
      {directory.error ? (
        <div className="chat-card-empty">
          <p role="alert">{directory.error}</p>
          <Button onClick={directory.refresh}>重新載入</Button>
        </div>
      ) : !directory.loading && visible.length === 0 ? (
        <p className="chat-card-empty">
          {directory.query ? "找不到符合搜尋的聊天" : "本頁沒有符合條件的聊天"}
        </p>
      ) : null}
      <ul className="chat-cards chat-list directory-list-region" aria-label="Chats on this page">
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
            Show selected chat
          </Button>
        )}
        {(directory.offset > 0 || directory.chats.length >= 100) && (
          <nav className="chat-card-pagination" aria-label="聊天分頁">
            <Button
              variant="outline"
              disabled={directory.loading || directory.offset === 0}
              onClick={() => directory.setOffset(Math.max(0, directory.offset - 100))}
            >
              上一頁
            </Button>
            <span>第 {Math.floor(directory.offset / 100) + 1} 頁</span>
            <Button
              variant="outline"
              disabled={
                directory.loading || Boolean(directory.error) || directory.chats.length < 100
              }
              onClick={() => directory.setOffset(directory.offset + 100)}
            >
              下一頁
            </Button>
          </nav>
        )}
      </footer>
    </>
  )
}
