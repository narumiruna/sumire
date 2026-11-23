import { effectivePolicy } from "@narumitw/sumire-policy"
import { ActionButton } from "@react-spectrum/s2/ActionButton"
import { Button } from "@react-spectrum/s2/Button"
import { Content } from "@react-spectrum/s2/Content"
import { Heading } from "@react-spectrum/s2/Heading"
import { InlineAlert } from "@react-spectrum/s2/InlineAlert"
import ChevronLeft from "@react-spectrum/s2/icons/ChevronLeft"
import More from "@react-spectrum/s2/icons/More"
import { Menu, MenuItem, MenuTrigger } from "@react-spectrum/s2/Menu"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { RouterProvider } from "react-aria-components"
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components/Tabs"
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

const chatViews = [
  ["overview", "chat.overview"],
  ["access", "chat.access"],
  ["configuration", "chat.modelTools"],
  ["history", "chat.history"],
] as const

type ChatView = (typeof chatViews)[number][0]

const chatHeading = style({ font: "heading-sm", margin: 0 })
const chatTitle = style({ font: "heading", margin: 0 })

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
    <div className="chat-fact">
      <dt>{label}</dt>
      <dd className="chat-fact-value">
        <div>
          {children}
          {detail && <span className="chat-fact-detail">{detail}</span>}
        </div>
        {action}
      </dd>
    </div>
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
  const [tab, setTab] = useState<ChatView>("overview")
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
  const changeTab = (value: ChatView) => {
    setTab(value)
    tabsRef.current?.querySelector<HTMLElement>(`[data-view="${value}"]`)?.focus()
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
      enabled: '.chat-policy-editor input[type="checkbox"]',
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
    <Prose color="gray" className="chat-ready-summary">
      {t("chat.statusSummary", { label: state.label, reason: state.reason })}
    </Prose>
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
          hidden={!showDirectory}
          inert={!active || !showDirectory}
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
              <TextField
                id="chat-id"
                size="XL"
                label={t("chat.id")}
                value={chatDraft}
                onChange={setChatDraft}
              />
              <Button
                variant="secondary"
                size="XL"
                isDisabled={!validDraft}
                onPress={() => openChat(chatDraft)}
              >
                {t("chat.openDetails")}
              </Button>
            </details>
          </ChatCards>
        </aside>
      </SectionActive>
      <SectionActive value={active && !showDirectory}>
        <section
          className="chat-detail"
          hidden={showDirectory}
          inert={!active || showDirectory}
          aria-label={t("chat.details")}
        >
          {!chat ? (
            <Panel className="chat-initial">
              <h2 className={chatHeading}>{t("chat.select")}</h2>
              <Prose color="gray">{t("chat.selectHelp")}</Prose>
            </Panel>
          ) : (
            <>
              <ActionButton
                UNSAFE_className="directory-action"
                size="XL"
                isQuiet
                onPress={() => setShowDirectory(true)}
              >
                <ChevronLeft />
                {t("chat.back")}
              </ActionButton>
              {metadataState.error && (
                <>
                  <Prose role="alert">{metadataState.error}</Prose>
                  <Button size="XL" variant="secondary" onPress={directory.refresh}>
                    {t("chat.retryMetadata")}
                  </Button>
                </>
              )}
              <header className="chat-header">
                <div className="chat-identity">
                  <h2
                    className={`chat-detail-name ${chatTitle}`}
                    title={detailName}
                    ref={headerRef}
                    tabIndex={-1}
                  >
                    {detailName}
                  </h2>
                  <div className="chat-identity-meta chat-control-row">
                    <span>{metadata?.type || t("chat.typeUnknown")}</span>
                    <code>{chat}</code>
                  </div>
                </div>
                <div className="chat-header-actions">
                  <ActionButton size="XL" isQuiet onPress={() => void copyChatId()}>
                    {t("chat.copyId")}
                  </ActionButton>
                  <RouterProvider navigate={onDurable}>
                    <MenuTrigger
                      align="end"
                      isOpen={actionsOpen && active && !showDirectory}
                      onOpenChange={setActionsOpen}
                    >
                      <ActionButton
                        size="XL"
                        UNSAFE_className="chat-actions"
                        aria-label={t("chat.chatActions")}
                        isDisabled={!active || showDirectory}
                      >
                        <More />
                      </ActionButton>
                      <Menu size="XL">
                        <MenuItem onAction={() => void copyChatId()}>{t("chat.copyId")}</MenuItem>
                        {valid && (
                          <MenuItem href={navigationHref("Durable", chat)}>
                            {t("chat.viewConversation")}
                          </MenuItem>
                        )}
                      </Menu>
                    </MenuTrigger>
                  </RouterProvider>
                </div>
              </header>
              <Prose role="status" className="chat-copy-status">
                {copyStatus.chat === chat && copyStatus.message ? t(copyStatus.message) : ""}
              </Prose>
              {!valid ? (
                <Prose role="alert">{t("chat.invalidId")}</Prose>
              ) : (
                <>
                  <section
                    className="chat-status"
                    aria-label={t("chat.setupStatus")}
                    data-blocked={Boolean(state.primary)}
                    hidden={!state.primary && !preview && tab === "overview"}
                  >
                    {state.primary ? (
                      <InlineAlert
                        UNSAFE_className="chat-setup-callout"
                        variant="notice"
                        fillStyle="subtleFill"
                      >
                        <Heading level={3}>{state.label}</Heading>
                        <Content UNSAFE_className="chat-setup-body">
                          <Prose>{state.reason}</Prose>
                          {primary && (
                            <Button size="XL" onPress={() => repair(primary.target)}>
                              {primary.action}
                            </Button>
                          )}
                        </Content>
                      </InlineAlert>
                    ) : (
                      tab !== "overview" && configuredStatus
                    )}

                    {preview && (
                      <Prose className="chat-draft-status">
                        {t("chat.draftPreview", {
                          label: draftState.label,
                          reason: draftState.reason,
                        })}
                      </Prose>
                    )}
                  </section>
                  {/* Spectrum Tabs collapse to a picker. Keep all four views visible at narrow widths. */}
                  <Tabs
                    selectedKey={tab}
                    onSelectionChange={(key) => {
                      const view = chatViews.find(([id]) => id === key)
                      if (view) setTab(view[0])
                    }}
                  >
                    <TabList ref={tabsRef} className="chat-tabs" aria-label={t("chat.views")}>
                      {chatViews.map(([id, label]) => (
                        <Tab key={id} id={id} data-view={id} className="chat-tab">
                          {t(label)}
                        </Tab>
                      ))}
                    </TabList>

                    {preview && (
                      <Prose className="draft-context" color="gray">
                        {t("chat.unsavedPreview")}
                      </Prose>
                    )}
                    {preview && (
                      <Prose>
                        {t("chat.savedPreview", {
                          access: saved.enabled
                            ? t("chat.approvedEnabled")
                            : t("chat.blockedPolicy"),
                          model: saved.model ?? t("chat.noAllowedModel"),
                        })}
                      </Prose>
                    )}
                    <TabPanel
                      className="chat-view"
                      id="overview"
                      shouldForceMount
                      hidden={tab !== "overview"}
                    >
                      <dl className="chat-facts chat-overview-facts overview-settings">
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
                            <ActionButton size="XL" isQuiet onPress={() => changeTab("access")}>
                              {t("chat.manageAccess")}
                            </ActionButton>
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
                            <ActionButton size="XL" isQuiet onPress={() => repair("model")}>
                              {t("chat.changeModel")}
                            </ActionButton>
                          }
                        >
                          <code>{effective.model ?? t("chat.noAllowedModel")}</code>
                        </ChatFact>
                        <ChatFact
                          label={t("chat.tools")}
                          detail={
                            effective.sources.tools === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.sharedDefault")
                          }
                          action={
                            <ActionButton size="XL" isQuiet onPress={() => repair("tools")}>
                              {t("chat.viewPermissions")}
                            </ActionButton>
                          }
                        >
                          {t("chat.allowedCount", { count: effective.tools.length })}
                        </ChatFact>
                      </dl>
                      {!state.primary && configuredStatus}
                      {unavailableTools.length > 0 && (
                        <div className="blocker">
                          <span>
                            {t("chat.excludedTools", { names: unavailableTools.join(", ") })}
                          </span>
                          <Button
                            size="XL"
                            variant="secondary"
                            onPress={() => changeTab("configuration")}
                          >
                            {t("chat.reviewToolPermissions")}
                          </Button>
                        </div>
                      )}
                    </TabPanel>
                    <TabPanel
                      className="chat-view"
                      id="access"
                      shouldForceMount
                      hidden={tab !== "access"}
                    >
                      <section className="chat-access-editor">
                        <h3 className={chatHeading} tabIndex={-1}>
                          {t("chat.accessForChat")}
                        </h3>
                        <Prose>{t(id > 0 ? "access.privateScope" : "access.groupScope")}</Prose>
                        <dl className="chat-facts effective-settings">
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
                        </dl>
                        <Prose role="status">
                          {accessPending
                            ? approved
                              ? t("chat.pendingGrant")
                              : t("chat.pendingRevocation")
                            : t("chat.noPendingApproval")}
                        </Prose>
                        <div className="chat-control-row">
                          <Button
                            size="XL"
                            variant={approved ? "negative" : "accent"}
                            fillStyle={approved ? "outline" : "fill"}
                            onPress={() => onPolicyChange(withChatAccess(policy, id, !approved))}
                          >
                            {approved
                              ? t("chat.revoke")
                              : savedApproval
                                ? t("chat.undoRevocation")
                                : t("chat.grant")}
                          </Button>
                          {accessPending && approved && (
                            <Button
                              size="XL"
                              variant="secondary"
                              onPress={() =>
                                onPolicyChange(withChatAccess(policy, id, savedApproval))
                              }
                            >
                              {t("chat.undoGrant")}
                            </Button>
                          )}
                          <ActionButton size="XL" isQuiet onPress={onAccess}>
                            {t("chat.manageChatAccess")}
                          </ActionButton>
                        </div>
                        <Prose color="gray" mt="3">
                          {t("chat.accessStageHelp")}
                        </Prose>
                      </section>
                    </TabPanel>
                    <TabPanel
                      className="chat-view"
                      id="configuration"
                      shouldForceMount
                      hidden={tab !== "configuration"}
                    >
                      <h3 className={chatHeading}>{t("chat.modelTools")}</h3>
                      <section className="chat-override-editor" aria-label={t("chat.overrides")}>
                        <h4 className={chatHeading}>{t("chat.overrides")}</h4>
                        <SectionActive value={active && !showDirectory && tab === "configuration"}>
                          {children}
                        </SectionActive>
                      </section>
                      <details className="configuration-summary">
                        <summary>{t("chat.effectiveAuthentication")}</summary>
                        <dl className="chat-facts effective-settings">
                          <ChatFact label={t("chat.effectiveModel")}>
                            <code>{effective.model ?? t("chat.noAllowedModel")}</code> ·{" "}
                            {effective.sources.model === "chat"
                              ? t("chat.chatOverride")
                              : t("chat.fromDefaults")}
                          </ChatFact>
                          <ChatFact label={t("chat.modelOverride")}>
                            <code>{override?.model ?? t("chat.inheritDefaults")}</code>
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
                        </dl>
                        <div className="chat-control-row">
                          <Button
                            size="XL"
                            variant="secondary"
                            onPress={() => onProviders(saved.model?.split("/")[0] ?? "")}
                          >
                            {t("chat.manageModelAuthentication")}
                          </Button>
                          <Button size="XL" variant="secondary" onPress={onTools}>
                            {t("chat.manageToolPermissions")}
                          </Button>
                        </div>
                      </details>
                      <details className="permission-details">
                        <summary>{t("chat.inspectPermissions")}</summary>
                        <Prose>{t("chat.capabilitiesHelp")}</Prose>
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
                                    <Prose>
                                      {t("chat.blockingSource", {
                                        source: result.blockingLabel ?? result.blocking,
                                      })}
                                    </Prose>
                                    <ActionButton
                                      size="XL"
                                      isQuiet
                                      onPress={() =>
                                        result.blockedServers.length
                                          ? repair("servers")
                                          : result.blocking === "Global policy"
                                            ? onTools()
                                            : repair("tools")
                                      }
                                    >
                                      {t("chat.reviewBlocking", { name })}
                                    </ActionButton>
                                  </>
                                )}
                                {inventory.toolAvailability?.[name]?.available === false && (
                                  <Prose>
                                    {t("chat.capabilityUnavailable", {
                                      reason: inventory.toolAvailability[name]?.reason ?? "",
                                    })}
                                  </Prose>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                      {!!effective.servers.length && (
                        <Panel mt="3">
                          <h4 className={chatHeading}>{t("chat.mcpStatus")}</h4>
                          <Prose>{t("chat.connectionHelp")}</Prose>
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
                    </TabPanel>
                    <TabPanel
                      className="chat-view"
                      id="history"
                      shouldForceMount
                      hidden={tab !== "history"}
                    >
                      <h3 className={chatHeading}>{t("chat.auditHistory")}</h3>
                      <Prose color="gray">{t("chat.auditHelp")}</Prose>
                      {history.length ? (
                        <SectionErrorBoundary label={t("chat.chatHistory")}>
                          <Activity entries={history} />
                        </SectionErrorBoundary>
                      ) : (
                        <Prose>{t("chat.noAuditRecords")}</Prose>
                      )}
                      <Button size="XL" variant="secondary" onPress={onAudit}>
                        {t("chat.openAudit")}
                      </Button>
                    </TabPanel>
                    <details className="setup-details">
                      <summary className="chat-readiness-toggle">
                        {t("chat.readinessDetails")}
                      </summary>
                      <dl className="chat-facts effective-settings readiness">
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
                      </dl>
                      {state.issues.slice(1).map((issue) => (
                        <div className="blocker" key={issue.code}>
                          <span>{issue.reason}</span>
                          <Button
                            size="XL"
                            variant="secondary"
                            onPress={() => repair(issue.target)}
                          >
                            {issue.action}
                          </Button>
                        </div>
                      ))}
                      <Prose color="gray">
                        {t(saved.enabled ? "chat.runtimeApproval" : "chat.runtimeDenied")}
                      </Prose>
                    </details>
                    <details className="permission-details" hidden={tab !== "overview"}>
                      <summary>{t("chat.advanced")}</summary>
                      <dl className="chat-facts effective-settings">
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
                      </dl>
                      <Prose>{t("chat.remoteUnchecked")}</Prose>
                      <div className="chat-control-row">
                        <Button
                          size="XL"
                          variant="secondary"
                          onPress={() => onProviders(saved.model?.split("/")[0] ?? "")}
                        >
                          {t("chat.manageAuthentication")}
                        </Button>
                        <Button size="XL" variant="secondary" onPress={onTools}>
                          {t("chat.manageToolPermissions")}
                        </Button>
                        <Button
                          size="XL"
                          variant="secondary"
                          onPress={() => changeTab("configuration")}
                        >
                          {t("chat.reviewOverrides")}
                        </Button>
                      </div>
                    </details>
                  </Tabs>
                </>
              )}
            </>
          )}
        </section>
      </SectionActive>
    </div>
  )
}
