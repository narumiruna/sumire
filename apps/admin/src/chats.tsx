import { effectivePolicy } from "@narumitw/sumire-policy"
import { ArrowLeftIcon, DotsHorizontalIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons"
import {
  Button,
  Callout,
  Code,
  DataList,
  DropdownMenu,
  Flex,
  Heading,
  Tabs,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { Activity, type AuditEntry } from "./activity.js"
import type { Inventory, Policy, Snapshot } from "./api.js"
import { ChatCards } from "./chat-cards.js"
import { type ChatDirectory, chatName } from "./chat-directory.js"
import { type ChatRepair, chatState } from "./chat-state.js"
import { t } from "./i18n.js"
import { type EditorTarget, focusEditor, navigationHref } from "./navigation.js"
import { policyChanges, withChatAccess } from "./policy-changes.js"
import { SectionErrorBoundary } from "./section-error-boundary.js"
import { SectionActive } from "./sections.js"
import { Panel, Prose } from "./surfaces.js"
import { permissionResult } from "./tool-permissions.js"

export type { Chat } from "@narumitw/sumire-contracts"
export { chatName } from "./chat-directory.js"

function ChatFact({
  label,
  children,
  detail,
  action,
}: {
  label: string
  children: ReactNode
  detail?: ReactNode
  action?: ReactNode
}) {
  return (
    <DataList.Item>
      <DataList.Label>{label}</DataList.Label>
      <DataList.Value>
        <Flex
          className="chat-fact-value"
          justify="between"
          align="start"
          gap="3"
          wrap="wrap"
          width="100%"
        >
          <div>
            {children}
            {detail && (
              <Text as="span" size="1" color="gray" className="chat-fact-detail">
                {detail}
              </Text>
            )}
          </div>
          {action}
        </Flex>
      </DataList.Value>
    </DataList.Item>
  )
}

export function ChatWorkspace({
  directory,
  chat,
  busy,
  detailsRequest,
  editorRequest,
  onSelect,
  policy,
  savedPolicy,
  application,
  inventory,
  onAccess,
  onApplication,
  onProviders,
  onTools,
  onDurable,
  onPolicyChange,
  audit,
  onAudit,
  children,
}: {
  directory: ChatDirectory
  chat: string
  busy: boolean
  detailsRequest: number
  editorRequest?: EditorTarget
  onSelect(value: string): void
  policy: Policy
  savedPolicy: Policy
  application: Pick<Snapshot, "revision" | "applied" | "status">
  inventory: Inventory
  onAccess(): void
  onApplication(): void
  onProviders(provider: string): void
  onTools(): void
  onDurable(): void
  onPolicyChange(value: Policy): void
  audit: AuditEntry[]
  onAudit(): void
  children: ReactNode
}) {
  const active = useContext(SectionActive)
  const [actionsOpen, setActionsOpen] = useState(false)
  const { selected: metadataState } = directory
  const [chatDraft, setChatDraft] = useState(chat)
  useEffect(() => setChatDraft(chat), [chat])
  const validDraft = /^-?[1-9]\d*$/.test(chatDraft) && Number.isSafeInteger(Number(chatDraft))
  const [tab, setTab] = useState("overview")
  const [showDirectory, setShowDirectory] = useState(!chat)
  useEffect(() => {
    if (!active || showDirectory) setActionsOpen(false)
  }, [active, showDirectory])
  useEffect(() => setShowDirectory(!chat), [chat])
  const directoryRef = useRef<HTMLElement>(null)
  const directoryScroll = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLHeadingElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const handledDetailsRequest = useRef(0)
  useEffect(() => {
    if (!active || !chat || handledDetailsRequest.current === detailsRequest) return
    handledDetailsRequest.current = detailsRequest
    setShowDirectory(false)
    const frame = requestAnimationFrame(() => {
      if (headerRef.current?.checkVisibility()) headerRef.current.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, chat, detailsRequest])
  const focusedDirectory = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (!active || focusedDirectory.current === showDirectory) return
    const initial = focusedDirectory.current === undefined
    focusedDirectory.current = showDirectory
    if (initial && showDirectory) return
    if (showDirectory) {
      const selected = directoryRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
      const target = selected ?? searchRef.current
      target?.focus({ preventScroll: true })
      window.scrollTo({ top: directoryScroll.current, behavior: "instant" })
    } else headerRef.current?.focus()
  }, [active, showDirectory])
  const changeTab = (value: string) => {
    setTab(value)
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-view="${value}"]`)?.focus()
  }
  const [repairRequest, setRepairRequest] = useState<{ target: ChatRepair | "tools" }>()
  useEffect(() => {
    if (editorRequest?.chat && chat) {
      setTab("configuration")
      setShowDirectory(false)
    }
  }, [editorRequest, chat])
  useEffect(() => {
    if (!repairRequest) return
    const selector = {
      access: ".chat-access-editor h3",
      enabled: '.chat-policy-editor [role="checkbox"]',
      model: "#model-selection",
      providers: "",
      application: "",
      tools: "#chat-tools-options",
      servers: "#chat-servers-options",
      skills: "#chat-skills-options",
    }[repairRequest.target]
    if (selector) {
      const frame = requestAnimationFrame(() => focusEditor(selector))
      return () => cancelAnimationFrame(frame)
    }
  }, [repairRequest])
  const repair = (target: ChatRepair | "tools") => {
    if (target === "providers") return onProviders(saved.model?.split("/")[0] ?? "")
    if (target === "application") return onApplication()
    setTab(target === "access" ? "access" : "configuration")
    setRepairRequest({ target })
  }
  const [copyStatus, setCopyStatus] = useState<{
    chat: string
    message: "" | "chat.copied" | "chat.copyFailed"
  }>({ chat: "", message: "" })
  const copyChatId = async (id = chat) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopyStatus({ chat: id, message: "chat.copied" })
    } catch {
      setCopyStatus({ chat: id, message: "chat.copyFailed" })
    }
  }
  const metadata = metadataState.chat
  const detailName = metadataState.loading
    ? t("chat.nameLoading")
    : metadataState.error
      ? t("chat.nameUnavailable")
      : metadata
        ? chatName(metadata)
        : t("chat.nameUnknown")
  const valid = /^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))
  const id = Number(chat)
  const effective = effectivePolicy(policy, id)
  const saved = effectivePolicy(savedPolicy, id)
  const list = id > 0 ? "privateUsers" : "groups"
  const approved = policy[list].includes(id)
  const savedApproval = savedPolicy[list].includes(id)
  const accessPending = approved !== savedApproval
  const override = policy.chats[chat]
  const state = chatState(id, savedPolicy, inventory, application)
  const primary = state.primary
  const draftState = chatState(id, policy, inventory, application)
  const provider = inventory.providers.find((p) => p.id === saved.model?.split("/")[0])
  const preview = policyChanges(savedPolicy, policy).length > 0
  const history = audit.filter((entry) => entry.target === `chat:${chat}`)
  const unavailableTools = (override?.tools ?? policy.defaults.tools ?? []).filter(
    (name) => !policy.tools.includes(name),
  )
  const showChatDetails = () => {
    directoryScroll.current = window.scrollY
    setShowDirectory(false)
  }
  const openChat = (value: string) => {
    onSelect(value)
    showChatDetails()
  }
  const configuredStatus = (
    <Text as="p" size="2" color="gray" className="chat-ready-summary">
      {t("chat.statusSummary", { label: state.label, reason: state.reason })}
    </Text>
  )
  return (
    <div
      className="chat-workspace"
      data-directory-visible={showDirectory}
      data-selected={Boolean(chat)}
    >
      <SectionActive value={active && showDirectory}>
        <aside
          ref={directoryRef}
          className="chat-directory chat-sidebar"
          aria-label={t("chat.find")}
        >
          <ChatCards
            directory={directory}
            selected={chat}
            searchRef={searchRef}
            policy={policy}
            savedPolicy={savedPolicy}
            inventory={inventory}
            application={application}
            busy={busy}
            onOpen={(value) => openChat(String(value.id))}
            onConfigure={(value) => {
              openChat(String(value.id))
              setTab("configuration")
            }}
            onRepair={(value, target) => {
              openChat(String(value.id))
              if (target === "providers") {
                const status = chatState(value.id, savedPolicy, inventory, application)
                onProviders(status.effective.model?.split("/")[0] ?? "")
              } else repair(target)
            }}
            onChange={onPolicyChange}
          >
            <details className="configure-id">
              <summary>{t("chat.openById")}</summary>
              <p>{t("chat.beforeFirstMessage")}</p>
              <label htmlFor="chat-id">{t("chat.id")}</label>
              <TextField.Root
                id="chat-id"
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
              />
              <Button variant="soft" disabled={!validDraft} onClick={() => openChat(chatDraft)}>
                {t("chat.openDetails")}
              </Button>
            </details>
          </ChatCards>
        </aside>
      </SectionActive>
      <SectionActive value={active && !showDirectory}>
        <section className="chat-detail" aria-label={t("chat.details")}>
          {!chat ? (
            <Panel className="chat-initial">
              <Heading size="4">{t("chat.select")}</Heading>
              <Prose color="gray">{t("chat.selectHelp")}</Prose>
            </Panel>
          ) : (
            <>
              <Button
                className="directory-action"
                variant="ghost"
                mb="0"
                onClick={() => setShowDirectory(true)}
              >
                <ArrowLeftIcon aria-hidden="true" />
                {t("chat.back")}
              </Button>
              {metadataState.error && (
                <>
                  <Text role="alert">{metadataState.error}</Text>
                  <Button variant="soft" onClick={directory.refresh}>
                    {t("chat.retryMetadata")}
                  </Button>
                </>
              )}
              <header className="chat-header">
                <div className="chat-identity">
                  <Heading
                    size="5"
                    className="chat-detail-name"
                    title={detailName}
                    ref={headerRef}
                    tabIndex={-1}
                  >
                    {detailName}
                  </Heading>
                  <Flex className="chat-identity-meta" gap="2" align="center" wrap="wrap">
                    <Text size="2">{metadata?.type || t("chat.typeUnknown")}</Text>
                    <Code size="2" variant="ghost">
                      {chat}
                    </Code>
                  </Flex>
                </div>
                <Button variant="ghost" onClick={() => void copyChatId()}>
                  {t("chat.copyId")}
                </Button>
                <DropdownMenu.Root
                  open={actionsOpen && active && !showDirectory}
                  onOpenChange={setActionsOpen}
                >
                  <DropdownMenu.Trigger>
                    <Button
                      className="chat-actions"
                      variant="soft"
                      aria-label={t("chat.chatActions")}
                    >
                      <DotsHorizontalIcon />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content
                    align="end"
                    onCloseAutoFocus={(event) => {
                      if (!active || showDirectory) event.preventDefault()
                    }}
                  >
                    <DropdownMenu.Item onSelect={() => void copyChatId()}>
                      {t("chat.copyId")}
                    </DropdownMenu.Item>
                    {valid && (
                      <DropdownMenu.Item asChild>
                        <a
                          href={navigationHref("Durable", chat)}
                          onKeyDownCapture={(event) => {
                            if (
                              event.key === "Enter" &&
                              (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            )
                              event.stopPropagation()
                          }}
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
                            onDurable()
                          }}
                        >
                          {t("chat.viewConversation")}
                        </a>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </header>
              <Text as="p" role="status" size="2" className="chat-copy-status">
                {copyStatus.chat === chat && copyStatus.message ? t(copyStatus.message) : ""}
              </Text>
              {!valid ? (
                <Text as="p" role="alert">
                  {t("chat.invalidId")}
                </Text>
              ) : (
                <>
                  <section
                    className="chat-status"
                    aria-label={t("chat.setupStatus")}
                    data-blocked={Boolean(state.primary)}
                    hidden={!state.primary && !preview && tab === "overview"}
                  >
                    {state.primary ? (
                      <Callout.Root className="chat-setup-callout" color="amber" size="1">
                        <Callout.Icon>
                          <ExclamationTriangleIcon />
                        </Callout.Icon>
                        <div className="chat-setup-body">
                          <Heading size="3">{state.label}</Heading>
                          <Text as="p" size="2">
                            {state.reason}
                          </Text>
                          {primary && (
                            <Button type="button" onClick={() => repair(primary.target)}>
                              {primary.action}
                            </Button>
                          )}
                        </div>
                      </Callout.Root>
                    ) : (
                      tab !== "overview" && configuredStatus
                    )}

                    {preview && (
                      <Text as="p" size="2" className="chat-draft-status">
                        {t("chat.draftPreview", {
                          label: draftState.label,
                          reason: draftState.reason,
                        })}
                      </Text>
                    )}
                  </section>
                  <Tabs.Root value={tab} onValueChange={changeTab}>
                    <Tabs.List ref={tabsRef} aria-label={t("chat.views")}>
                      <Tabs.Trigger type="button" value="overview" data-view="overview">
                        {t("chat.overview")}
                      </Tabs.Trigger>
                      <Tabs.Trigger type="button" value="access" data-view="access">
                        {t("chat.access")}
                      </Tabs.Trigger>
                      <Tabs.Trigger type="button" value="configuration" data-view="configuration">
                        {t("chat.modelTools")}
                      </Tabs.Trigger>
                      <Tabs.Trigger type="button" value="history" data-view="history">
                        {t("chat.history")}
                      </Tabs.Trigger>
                    </Tabs.List>

                    {preview && (
                      <Text className="draft-context" as="p" size="2" color="gray">
                        {t("chat.unsavedPreview")}
                      </Text>
                    )}
                    {preview && (
                      <Text as="p" size="2">
                        {t("chat.savedPreview", {
                          access: saved.enabled
                            ? t("chat.approvedEnabled")
                            : t("chat.blockedPolicy"),
                          model: saved.model ?? t("chat.noAllowedModel"),
                        })}
                      </Text>
                    )}
                    <Tabs.Content
                      className="chat-view"
                      value="overview"
                      forceMount
                      hidden={tab !== "overview"}
                    >
                      <DataList.Root
                        className="chat-facts chat-overview-facts overview-settings"
                        size="2"
                      >
                        <ChatFact
                          label={t("chat.access")}
                          detail={
                            effective.enabled
                              ? undefined
                              : t(
                                  approved
                                    ? override?.enabled === false
                                      ? "chat.approvalDisabled"
                                      : "chat.approvalEnabled"
                                    : override?.enabled === false
                                      ? "chat.noApprovalDisabled"
                                      : "chat.noApprovalEnabled",
                                )
                          }
                          action={
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => changeTab("access")}
                            >
                              {t("chat.manageAccess")}
                            </Button>
                          }
                        >
                          {effective.enabled ? t("chat.approvedEnabled") : t("chat.blockedPolicy")}
                        </ChatFact>
                        <ChatFact
                          label={t("chat.model")}
                          detail={
                            effective.sources.model === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.sharedDefault")
                          }
                          action={
                            <Button type="button" variant="ghost" onClick={() => repair("model")}>
                              {t("chat.changeModel")}
                            </Button>
                          }
                        >
                          <Code variant="ghost">{effective.model ?? t("chat.noAllowedModel")}</Code>
                        </ChatFact>
                        <ChatFact
                          label={t("chat.tools")}
                          detail={
                            effective.sources.tools === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.sharedDefault")
                          }
                          action={
                            <Button type="button" variant="ghost" onClick={() => repair("tools")}>
                              {t("chat.viewPermissions")}
                            </Button>
                          }
                        >
                          {t("chat.allowedCount", { count: effective.tools.length })}
                        </ChatFact>
                      </DataList.Root>
                      {!state.primary && configuredStatus}
                      {unavailableTools.length > 0 && (
                        <div className="blocker">
                          <Text size="2">
                            {t("chat.excludedTools", { names: unavailableTools.join(", ") })}
                          </Text>
                          <Button
                            type="button"
                            variant="soft"
                            onClick={() => changeTab("configuration")}
                          >
                            {t("chat.reviewToolPermissions")}
                          </Button>
                        </div>
                      )}
                    </Tabs.Content>
                    <Tabs.Content
                      className="chat-view"
                      value="access"
                      forceMount
                      hidden={tab !== "access"}
                    >
                      <section className="chat-access-editor">
                        <Heading as="h3" size="3" tabIndex={-1}>
                          {t("chat.accessForChat")}
                        </Heading>
                        <Text as="p" size="2" mt="2">
                          {t(id > 0 ? "access.privateScope" : "access.groupScope")}
                        </Text>
                        <DataList.Root className="chat-facts effective-settings" size="2">
                          <ChatFact label={t("chat.savedApproval")}>
                            {savedApproval ? t("chat.approved") : t("chat.notApproved")}
                          </ChatFact>
                          <ChatFact label={t("chat.draftApproval")}>
                            {approved ? t("chat.approved") : t("chat.notApproved")}
                          </ChatFact>
                          <ChatFact label={t("chat.policyAccess")}>
                            {override?.enabled === false
                              ? t("chat.independentlyDisabled", {
                                  access: effective.enabled
                                    ? t("chat.approvedEnabled")
                                    : t("chat.blockedPolicy"),
                                })
                              : effective.enabled
                                ? t("chat.approvedEnabled")
                                : t("chat.blockedPolicy")}
                          </ChatFact>
                        </DataList.Root>
                        <Text as="p" role="status">
                          {accessPending
                            ? approved
                              ? t("chat.pendingGrant")
                              : t("chat.pendingRevocation")
                            : t("chat.noPendingApproval")}
                        </Text>
                        <Flex gap="3" wrap="wrap" mt="3">
                          <Button
                            color={approved ? "red" : "teal"}
                            variant={approved ? "soft" : "solid"}
                            onClick={() => onPolicyChange(withChatAccess(policy, id, !approved))}
                          >
                            {approved
                              ? t("chat.revoke")
                              : savedApproval
                                ? t("chat.undoRevocation")
                                : t("chat.grant")}
                          </Button>
                          {accessPending && approved && (
                            <Button
                              variant="soft"
                              onClick={() =>
                                onPolicyChange(withChatAccess(policy, id, savedApproval))
                              }
                            >
                              {t("chat.undoGrant")}
                            </Button>
                          )}
                          <Button variant="ghost" onClick={onAccess}>
                            {t("chat.manageChatAccess")}
                          </Button>
                        </Flex>
                        <Text as="p" size="2" color="gray" mt="3">
                          {t("chat.accessStageHelp")}
                        </Text>
                      </section>
                    </Tabs.Content>
                    <Tabs.Content
                      className="chat-view"
                      value="configuration"
                      forceMount
                      hidden={tab !== "configuration"}
                    >
                      <Heading size="3">{t("chat.modelTools")}</Heading>
                      <section className="chat-override-editor" aria-label={t("chat.overrides")}>
                        <Heading size="3" mt="4">
                          {t("chat.overrides")}
                        </Heading>
                        {children}
                      </section>
                      <details className="configuration-summary">
                        <summary>{t("chat.effectiveAuthentication")}</summary>
                        <DataList.Root className="chat-facts effective-settings" size="2">
                          <ChatFact label={t("chat.effectiveModel")}>
                            <Code variant="ghost">
                              {effective.model ?? t("chat.noAllowedModel")}
                            </Code>{" "}
                            ·{" "}
                            {effective.sources.model === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.fromDefaults")}
                          </ChatFact>
                          <ChatFact label={t("chat.modelOverride")}>
                            <Code variant="ghost">
                              {override?.model ?? t("chat.inheritDefaults")}
                            </Code>
                          </ChatFact>
                          <ChatFact label={t("chat.tools")}>
                            {effective.tools.join(", ") || t("chat.none")} ·{" "}
                            {effective.sources.tools === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.fromDefaults")}
                          </ChatFact>
                          <ChatFact label={t("chat.skills")}>
                            {effective.skills.join(", ") || t("chat.none")} ·{" "}
                            {effective.sources.skills === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.fromDefaults")}
                          </ChatFact>
                          <ChatFact label={t("chat.mcpServers")}>
                            {effective.servers.join(", ") || t("chat.none")} ·{" "}
                            {effective.sources.servers === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.fromDefaults")}
                          </ChatFact>
                          <ChatFact label={t("chat.thinking")}>
                            {effective.thinking} ·{" "}
                            {effective.sources.thinking === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.fromDefaults")}
                          </ChatFact>
                        </DataList.Root>
                        <Flex gap="3" wrap="wrap">
                          <Button
                            variant="soft"
                            onClick={() => onProviders(saved.model?.split("/")[0] ?? "")}
                          >
                            {t("chat.manageModelAuthentication")}
                          </Button>
                          <Button variant="soft" onClick={onTools}>
                            {t("chat.manageToolPermissions")}
                          </Button>
                        </Flex>
                      </details>
                      <details className="permission-details">
                        <summary>{t("chat.inspectPermissions")}</summary>
                        <Text as="p" size="2">
                          {t("chat.capabilitiesHelp")}
                        </Text>
                        <ul>
                          {[
                            ...new Set([
                              ...inventory.tools,
                              ...inventory.mcp.flatMap((server) => server.tools),
                              ...policy.tools,
                              ...(override?.tools ?? policy.defaults.tools ?? []),
                            ]),
                          ].map((name) => {
                            const result = permissionResult("tools", name, policy, inventory, {
                              selection: override ?? policy.defaults,
                              effective,
                            })
                            return (
                              <li key={name}>
                                <strong>{name}</strong> ·{" "}
                                {t("chat.permissionSummary", {
                                  source: result.sourceLabel,
                                  selection: result.selected ? t("chat.allow") : t("chat.deny"),
                                  permission:
                                    result.status === "Allowed"
                                      ? t("chat.toolAllowed")
                                      : t("chat.toolDenied"),
                                })}
                                {result.blocking && (
                                  <>
                                    <Text as="p" size="2">
                                      {t("chat.blockingSource", {
                                        source: result.blockingLabel ?? result.blocking,
                                      })}
                                    </Text>
                                    <Button
                                      variant="ghost"
                                      onClick={() =>
                                        result.blockedServers.length
                                          ? repair("servers")
                                          : result.blocking === "Global policy"
                                            ? onTools()
                                            : repair("tools")
                                      }
                                    >
                                      {t("chat.reviewBlocking", { name })}
                                    </Button>
                                  </>
                                )}
                                {inventory.toolAvailability?.[name]?.available === false && (
                                  <Text as="p" size="2">
                                    {t("chat.capabilityUnavailable", {
                                      reason: inventory.toolAvailability[name]?.reason ?? "",
                                    })}
                                  </Text>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                      {!!effective.servers.length && (
                        <Panel mt="3">
                          <Heading size="2">{t("chat.mcpStatus")}</Heading>
                          <Text as="p" size="2">
                            {t("chat.connectionHelp")}
                          </Text>
                          <ul>
                            {effective.servers.map((name) => {
                              const server = inventory.mcp.find((entry) => entry.name === name)
                              return (
                                <li key={name}>
                                  {name}:{" "}
                                  {server
                                    ? server.enabled === false
                                      ? t("chat.disabledConnection", {
                                          connection: server.connection,
                                        })
                                      : server.connection
                                    : t("chat.notInInventory")}
                                </li>
                              )
                            })}
                          </ul>
                        </Panel>
                      )}
                    </Tabs.Content>
                    <Tabs.Content
                      className="chat-view"
                      value="history"
                      forceMount
                      hidden={tab !== "history"}
                    >
                      <Heading size="3">{t("chat.auditHistory")}</Heading>
                      <Text as="p" size="2" color="gray">
                        {t("chat.auditHelp")}
                      </Text>
                      {history.length ? (
                        <SectionErrorBoundary label={t("chat.chatHistory")}>
                          <Activity entries={history} />
                        </SectionErrorBoundary>
                      ) : (
                        <Text as="p">{t("chat.noAuditRecords")}</Text>
                      )}
                      <Button variant="soft" mt="3" onClick={onAudit}>
                        {t("chat.openAudit")}
                      </Button>
                    </Tabs.Content>
                    <details className="setup-details">
                      <summary className="chat-readiness-toggle">
                        {t("chat.readinessDetails")}
                      </summary>
                      <DataList.Root className="chat-facts effective-settings readiness" size="2">
                        <ChatFact label={t("chat.access")}>
                          {state.approved ? t("chat.approved") : t("chat.notApproved")}
                        </ChatFact>
                        <ChatFact label={t("chat.chat")}>
                          {state.enabled ? t("chat.enabled") : t("chat.disabled")}
                        </ChatFact>
                        <ChatFact label={t("chat.configuration")}>
                          {!saved.model
                            ? t("chat.setupRequired")
                            : state.issues.some((issue) => issue.code === "inventory") || !provider
                              ? t("chat.unknown")
                              : provider.configured
                                ? t("chat.configuredLocally")
                                : t("chat.setupRequired")}
                        </ChatFact>
                        <ChatFact label={t("chat.verification")}>
                          {t("chat.uncheckedRemote")}
                        </ChatFact>
                        <ChatFact label={t("chat.application")}>
                          {application.status === "failed"
                            ? t("chat.failed")
                            : application.status === "applied" &&
                                application.revision === application.applied
                              ? t("chat.applied")
                              : t("chat.pending")}
                        </ChatFact>
                      </DataList.Root>
                      {state.issues.slice(1).map((issue) => (
                        <div className="blocker" key={issue.code}>
                          <Text size="2">{issue.reason}</Text>
                          <Button type="button" variant="soft" onClick={() => repair(issue.target)}>
                            {issue.action}
                          </Button>
                        </div>
                      ))}
                      <Text as="p" size="2" color="gray">
                        {t(saved.enabled ? "chat.runtimeApproval" : "chat.runtimeDenied")}
                      </Text>
                    </details>
                    <details className="permission-details" hidden={tab !== "overview"}>
                      <summary>{t("chat.advanced")}</summary>
                      <DataList.Root className="chat-facts effective-settings" size="2">
                        <ChatFact label={t("chat.tools")}>
                          {effective.tools.join(", ") || t("chat.none")} ·{" "}
                          {effective.sources.tools === "chat"
                            ? t("chat.chatOverride")
                            : t("chat.fromDefaults")}
                        </ChatFact>
                        <ChatFact label={t("chat.skills")}>
                          {effective.skills.join(", ") || t("chat.none")} ·{" "}
                          {effective.sources.skills === "chat"
                            ? t("chat.chatOverride")
                            : t("chat.fromDefaults")}
                        </ChatFact>
                        <ChatFact label={t("chat.mcpServers")}>
                          {effective.servers.join(", ") || t("chat.none")} ·{" "}
                          {effective.sources.servers === "chat"
                            ? t("chat.chatOverride")
                            : t("chat.fromDefaults")}
                        </ChatFact>
                        <ChatFact label={t("chat.thinking")}>
                          {effective.thinking} ·{" "}
                          {effective.sources.thinking === "chat"
                            ? t("chat.chatOverride")
                            : t("chat.fromDefaults")}
                        </ChatFact>
                      </DataList.Root>
                      <Text as="p" size="2">
                        {t("chat.remoteUnchecked")}
                      </Text>
                      <Flex gap="3" wrap="wrap" mt="2">
                        <Button
                          type="button"
                          variant="soft"
                          onClick={() => onProviders(saved.model?.split("/")[0] ?? "")}
                        >
                          {t("chat.manageAuthentication")}
                        </Button>
                        <Button type="button" variant="soft" onClick={onTools}>
                          {t("chat.manageToolPermissions")}
                        </Button>
                        <Button
                          type="button"
                          variant="soft"
                          onClick={() => changeTab("configuration")}
                        >
                          {t("chat.reviewOverrides")}
                        </Button>
                      </Flex>
                    </details>
                  </Tabs.Root>
                </>
              )}
            </>
          )}
        </section>
      </SectionActive>
    </div>
  )
}
