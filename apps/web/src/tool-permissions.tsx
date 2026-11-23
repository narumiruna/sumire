import { effectivePolicy } from "@narumitw/sumire-policy"
import { ActionButton } from "@react-spectrum/s2/ActionButton"
import { Badge } from "@react-spectrum/s2/Badge"
import { Button } from "@react-spectrum/s2/Button"
import ChevronDown from "@react-spectrum/s2/icons/ChevronDown"
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { t } from "./i18n.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { countText } from "./status-text.js"
import { Panel, Prose, StatusLabel, TableToolbar } from "./surfaces.js"
import "./spectrum-permissions.css"

const layoutTokens = style({
  "--permission-surface": { type: "backgroundColor", value: "layer-2" },
  "--permission-divider": { type: "borderColor", value: "gray-300" },
  "--permission-highlight": { type: "outlineColor", value: "accent-900" },
  "--permission-muted": { type: "color", value: "neutral-subdued" },
})
const headingStyle = style({ font: "heading-xs", color: "title" })
const body = style({ font: "body-lg", color: "body" })
const code = style({ font: "code", fontWeight: "medium" })
const actions = style({ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" })
const notice = style({
  font: "body",
  color: "notice-1000",
  backgroundColor: "notice-subtle",
  borderRadius: "default",
  padding: 12,
  margin: 0,
})

export function defaultPermissionSummary(policy: Policy) {
  const effective = effectivePolicy(policy, 0)
  return t("permissions.defaultSummary", {
    tools: countText(effective.tools.length, "default tool name"),
    servers: countText(effective.servers.length, "default MCP server gate"),
  })
}

export function permissionNames(
  key: "tools" | "servers",
  policy: Policy,
  saved: Policy,
  inventory: Inventory,
) {
  return [
    ...new Set([
      ...(key === "tools"
        ? [...inventory.tools, ...inventory.mcp.flatMap((m) => m.tools)]
        : inventory.mcp.map((m) => m.name)),
      ...policy[key],
      ...saved[key],
      ...(policy.defaults[key] ?? []),
      ...(saved.defaults[key] ?? []),
      ...Object.values(policy.chats).flatMap((chat) => chat[key] ?? []),
    ]),
  ]
}

export function permissionConflicts(policy: Policy) {
  return (["tools", "servers"] as const).flatMap((key) => {
    const names = new Set([
      ...(policy.defaults[key] ?? []),
      ...Object.values(policy.chats).flatMap((chat) => chat[key] ?? []),
    ])
    return [...names]
      .filter((name) => !policy[key].includes(name))
      .map((name) => ({
        key,
        name,
        defaults: policy.defaults[key]?.includes(name) ?? false,
        chats: Object.entries(policy.chats)
          .filter(([, chat]) => chat[key]?.includes(name))
          .map(([id]) => id),
      }))
  })
}

export function permissionResult(
  key: "tools" | "servers",
  name: string,
  policy: Policy,
  inventory: Inventory,
  chat?: { selection: Selection; effective: ReturnType<typeof effectivePolicy> },
) {
  const effective = chat?.effective ?? effectivePolicy(policy, 0)
  const selection = chat?.selection[key] ?? policy.defaults[key] ?? []
  const source = effective.sources[key] === "chat" ? "Chat override" : "Shared defaults"
  const sourceLabel = t(
    effective.sources[key] === "chat" ? "permissions.sourceChat" : "permissions.sourceDefaults",
  )
  const gates = key === "tools" ? inventory.mcp.filter((server) => server.tools.includes(name)) : []
  const blockedServers = gates.filter((server) => !effective.servers.includes(server.name))
  return {
    selected: selection.includes(name),
    source,
    sourceLabel,
    statusLabel: !policy[key].includes(name)
      ? t("permissions.unavailableGlobally")
      : !effective[key].includes(name)
        ? t("permissions.notSelected")
        : blockedServers.length
          ? t("permissions.serverBlocked")
          : t("permissions.allowed"),
    blockingLabel: !policy[key].includes(name)
      ? t("permissions.globalPolicy")
      : !selection.includes(name)
        ? sourceLabel
        : blockedServers.length
          ? t("permissions.serverBlocking", {
              servers: blockedServers.map((server) => server.name).join(", "),
            })
          : null,
    status: !policy[key].includes(name)
      ? "Unavailable globally"
      : !effective[key].includes(name)
        ? "Not selected"
        : blockedServers.length
          ? "Server gate blocked"
          : "Allowed",
    blocking: !policy[key].includes(name)
      ? "Global policy"
      : !selection.includes(name)
        ? source
        : blockedServers.length
          ? `MCP server permission: ${blockedServers.map((server) => server.name).join(", ")}`
          : null,
    blockedServers,
  }
}

export type PermissionFilter =
  | "all"
  | "missing"
  | "unavailable"
  | "selected"
  | "blocked"
  | "changed"

export function permissionMatches(
  key: "tools" | "servers",
  name: string,
  inventory: Inventory,
  filter: PermissionFilter,
  policy?: Policy,
  saved?: Policy,
) {
  if (filter === "all") return true
  if (filter === "selected") return Boolean(policy?.defaults[key]?.includes(name))
  if (filter === "changed")
    return Boolean(
      policy &&
        saved &&
        (policy[key].includes(name) !== saved[key].includes(name) ||
          Boolean(policy.defaults[key]?.includes(name)) !==
            Boolean(saved.defaults[key]?.includes(name))),
    )
  if (filter === "blocked") {
    if (!policy?.defaults[key]?.includes(name)) return false
    if (!policy[key].includes(name)) return true
    const sources =
      key === "tools" ? inventory.mcp.filter((server) => server.tools.includes(name)) : []
    return sources.some(
      (server) =>
        !policy.servers.includes(server.name) || !policy.defaults.servers?.includes(server.name),
    )
  }
  if (filter === "unavailable")
    return key === "tools" && inventory.toolAvailability?.[name]?.available === false
  return key === "tools"
    ? !inventory.tools.includes(name) &&
        !inventory.mcp.some((server) => server.tools.includes(name))
    : !inventory.mcp.some((server) => server.name === name)
}

export function permissionChangeCounts(policy: Policy, saved: Policy, inventory: Inventory) {
  let global = 0
  let defaults = 0
  for (const key of ["tools", "servers"] as const) {
    for (const name of permissionNames(key, policy, saved, inventory)) {
      if (policy[key].includes(name) !== saved[key].includes(name)) global++
      if (
        Boolean(policy.defaults[key]?.includes(name)) !==
        Boolean(saved.defaults[key]?.includes(name))
      )
        defaults++
    }
  }
  return { global, defaults }
}

export type ToolPermissionGroup = { id: string; label: string; names: string[] }

export function toolPermissionGroups(names: string[], inventory: Inventory): ToolPermissionGroup[] {
  const known = new Set([
    ...(inventory.builtInTools ?? []),
    ...inventory.mcp.flatMap((server) => server.tools),
  ])
  return [
    {
      id: "built-in",
      label: t("permissions.builtIn"),
      names: names.filter((name) => inventory.builtInTools?.includes(name)),
    },
    ...inventory.mcp.map((server) => ({
      id: `mcp:${server.name}`,
      label: `MCP: ${server.name}`,
      names: names.filter((name) => server.tools.includes(name)),
    })),
    {
      id: "unknown",
      label: t("permissions.unknownSource"),
      names: names.filter((name) => !known.has(name)),
    },
  ].filter((group) => group.names.length > 0)
}

export function expansionStorageKey(actor: string) {
  return `sumire:tool-permissions:expanded:v1:${encodeURIComponent(actor)}`
}

function readExpansion(actor: string): string[] | undefined {
  try {
    const raw = localStorage.getItem(expansionStorageKey(actor))
    if (raw === null) return undefined
    const stored: unknown = JSON.parse(raw)
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : undefined
  } catch {
    return undefined
  }
}

function PermissionGroup({
  group,
  expanded,
  globalEditing,
  searching,
  onToggle,
  children,
}: {
  group?: ToolPermissionGroup
  expanded: boolean
  globalEditing: boolean
  searching: boolean
  onToggle(): void
  children: ReactNode
}) {
  const id = useId()
  const columns = (
    <div className="permission-matrix-heading" aria-hidden="true">
      <strong>{group ? t("permissions.toolName") : t("permissions.serverName")}</strong>
      <strong hidden={!globalEditing}>{t("permissions.globalAllowed")}</strong>
      <strong>{t("permissions.defaultChat")}</strong>
      <strong>{t("permissions.effective")}</strong>
    </div>
  )
  const content = <ul className="permission-list">{children}</ul>
  if (!group)
    return (
      <>
        {columns}
        {content}
      </>
    )
  return (
    <section className="permission-group" aria-label={group.label}>
      <div className="permission-group-heading">
        <h4 className={headingStyle}>
          {searching ? (
            <span>
              {group.label} · {countText(group.names.length, "tool")}
            </span>
          ) : (
            <ActionButton
              isQuiet
              UNSAFE_className="permission-group-toggle"
              aria-expanded={expanded}
              aria-controls={id}
              onPress={onToggle}
            >
              {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              <span>{group.label} ·</span>
              <Badge variant="neutral" fillStyle="subtle">
                {countText(group.names.length, "tool")}
              </Badge>
            </ActionButton>
          )}
        </h4>
        {expanded && columns}
      </div>
      <div id={id} hidden={!expanded}>
        {content}
      </div>
    </section>
  )
}

export function ToolPermissions({
  actor,
  policy,
  saved,
  inventory,
  onChange,
  onChat,
  defaultContext,
  dirty,
  selectedChat = "",
}: {
  actor: string
  policy: Policy
  saved: Policy
  inventory: Inventory
  onChange(policy: Policy): void
  onChat(id: string): void
  defaultContext: boolean
  dirty: boolean
  selectedChat?: string
}) {
  const prefix = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [query, setQuery] = useState("")
  const [globalEditing, setGlobalEditing] = useState(false)
  const [filter, setFilter] = useState<PermissionFilter>("all")
  const scope = useRef<HTMLElement>(null)
  const filtering = Boolean(query.trim()) || filter !== "all"
  const changes = permissionChangeCounts(policy, saved, inventory)
  const conflicts = permissionConflicts(policy)
  const matrix = useRef<HTMLDivElement>(null)
  function repairPermission(key: "tools" | "servers", name: string, global = true) {
    setGlobalEditing(global)
    setQuery("")
    setFilter("all")
    changeExpansion(allGroups.map((group) => group.id))
    requestAnimationFrame(() => {
      const row = [
        ...(matrix.current?.querySelectorAll<HTMLElement>("[data-permission-name]") ?? []),
      ].find((row) => row.dataset.permissionName === name && row.dataset.permissionKey === key)
      row
        ?.querySelector<HTMLElement>(
          `[data-permission-control="${global ? "global" : "default"}"] input[type="checkbox"]`,
        )
        ?.focus()
    })
  }
  useEffect(() => {
    const element = scope.current
    if (!element) return
    const measure = () =>
      element.parentElement?.style.setProperty(
        "--permission-scope-height",
        `${element.offsetHeight}px`,
      )
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  const term = query.trim().toLowerCase()
  const allGroups = toolPermissionGroups(
    permissionNames("tools", policy, saved, inventory),
    inventory,
  )
  const groups = allGroups
    .map((group) => ({
      ...group,
      names: group.names.filter(
        (name) =>
          `${name} ${group.label}`.toLowerCase().includes(term) &&
          permissionMatches("tools", name, inventory, filter, policy, saved),
      ),
    }))
    .filter((group) => group.names.length > 0)
  const servers = permissionNames("servers", policy, saved, inventory).filter(
    (name) =>
      name.toLowerCase().includes(term) &&
      permissionMatches("servers", name, inventory, filter, policy, saved),
  )
  const [expansion, setExpansion] = useState(() => readExpansion(actor))
  const expanded = expansion ?? allGroups.slice(0, 1).map((group) => group.id)
  function changeExpansion(next: string[]) {
    setExpansion(next)
    try {
      localStorage.setItem(expansionStorageKey(actor), JSON.stringify(next))
    } catch {
      // Expansion still works when local storage is unavailable.
    }
  }
  useEffect(() => {
    if (defaultContext) {
      setGlobalEditing(false)
      heading.current?.focus()
    }
  }, [defaultContext])
  return (
    <div
      className={`settings-stack tool-permissions ${layoutTokens}`}
      ref={matrix}
      data-global-editing={globalEditing}
    >
      <section ref={scope} className="permission-scope" aria-label={t("permissions.editScope")}>
        <h2 ref={heading} tabIndex={-1} id="default-tool-permissions" className={headingStyle}>
          {globalEditing ? t("permissions.editGlobalDefaults") : t("permissions.editDefaults")}
        </h2>
        <fieldset className="permission-scope-actions" aria-label={t("permissions.scope")}>
          <Button
            variant={globalEditing ? "accent" : "secondary"}
            aria-pressed={globalEditing}
            onPress={() => setGlobalEditing(true)}
          >
            {t("permissions.globalPolicy")}
          </Button>
          <Button
            variant={globalEditing ? "secondary" : "accent"}
            aria-pressed={!globalEditing}
            onPress={() => setGlobalEditing(false)}
          >
            {t("permissions.sourceDefaults")}
          </Button>
          <Button
            variant="secondary"
            aria-label={
              selectedChat
                ? t("permissions.selectedChat", { id: selectedChat })
                : t("permissions.noSelectedChat")
            }
            isDisabled={!selectedChat}
            onPress={() => onChat(selectedChat)}
          >
            {selectedChat ? t("permissions.chatName", { id: selectedChat }) : t("permissions.chat")}
          </Button>
        </fieldset>
        <p className={style({ font: "body-sm", color: "body", margin: 0 })}>
          {globalEditing ? t("permissions.globalHelp") : t("permissions.defaultsHelp")}
        </p>
        {(changes.global > 0 || changes.defaults > 0) && (
          <Prose size="2">
            {t("permissions.changedCounts", {
              global: countText(changes.global, "changed global tool/server name"),
              defaults: countText(changes.defaults, "changed shared-default tool/server name"),
            })}
          </Prose>
        )}
      </section>
      <section className={notice} aria-label={t("permissions.credentialAccess")}>
        {t("permissions.hostWarning")}
      </section>
      {conflicts.length > 0 && (
        <section className="permission-conflicts" aria-label={t("permissions.retainedConflicts")}>
          <h3 className={headingStyle}>
            {t("permissions.cannotSaveCount", {
              count: countText(conflicts.length, "tool/server name"),
            })}
          </h3>
          <Prose size="2">{t("permissions.conflictsHelp")}</Prose>
          <ul>
            {conflicts.map((conflict) => (
              <li key={`${conflict.key}:${conflict.name}`}>
                <code className={code}>{conflict.name}</code> ·{" "}
                {conflict.defaults ? t("permissions.conflictDefaults") : ""}
                {conflict.chats.length > 0
                  ? t("permissions.chatOverrides", {
                      count: countText(conflict.chats.length, "explicit chat override"),
                      chats: conflict.chats.join(", "),
                    })
                  : ""}
                <ActionButton isQuiet onPress={() => repairPermission(conflict.key, conflict.name)}>
                  {t("permissions.reviewGlobalName", { name: conflict.name })}
                </ActionButton>
                {conflict.defaults && (
                  <ActionButton
                    isQuiet
                    onPress={() => repairPermission(conflict.key, conflict.name, false)}
                  >
                    {t("permissions.reviewSharedName", { name: conflict.name })}
                  </ActionButton>
                )}
                {conflict.chats.map((id) => (
                  <ActionButton key={id} isQuiet onPress={() => onChat(id)}>
                    {t("permissions.reviewChat", { id })}
                  </ActionButton>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TableToolbar className="tool-search">
        <TextField
          id={`${prefix}-search`}
          label={t("permissions.search")}
          UNSAFE_className="form-field"
          styles={style({ width: "full" })}
          value={query}
          onChange={setQuery}
        />
        <label className="form-field" htmlFor={`${prefix}-filter`}>
          {t("permissions.toolStatus")}
          <SectionPicker
            value={filter}
            onValueChange={(value) => setFilter(value as PermissionFilter)}
            id={`${prefix}-filter`}
            aria-label={t("permissions.toolStatus")}
          >
            <PickerOption id="all">{t("permissions.all")}</PickerOption>
            <PickerOption id="selected">{t("permissions.selectedDefault")}</PickerOption>
            <PickerOption id="blocked">{t("permissions.blockedPolicy")}</PickerOption>
            <PickerOption id="changed">{t("permissions.pendingChanges")}</PickerOption>
            <PickerOption id="missing">{t("permissions.notInventory")}</PickerOption>
            <PickerOption id="unavailable">{t("permissions.capabilityUnavailable")}</PickerOption>
          </SectionPicker>
        </label>
        <Button
          variant="secondary"
          aria-pressed={globalEditing}
          onPress={() => setGlobalEditing(!globalEditing)}
        >
          {t("permissions.editGlobal")}
        </Button>
      </TableToolbar>
      {filtering && (
        <div className={actions}>
          <span role="status" className={body}>
            {t("permissions.matchCounts", {
              tools: countText(
                new Set(groups.flatMap((group) => group.names)).size,
                "matching tool",
              ),
              servers: countText(servers.length, "matching server"),
            })}
          </span>
          <ActionButton
            isQuiet
            onPress={() => {
              setQuery("")
              setFilter("all")
            }}
          >
            {t("permissions.clearFilters")}
          </ActionButton>
        </div>
      )}
      {filtering && !groups.length && !servers.length && (
        <Prose role="status">{t("permissions.noMatches")}</Prose>
      )}
      {(["tools", "servers"] as const).map((key) => (
        <Panel
          key={key}
          className="permission-section"
          hidden={filtering && (key === "tools" ? !groups.length : !servers.length)}
          aria-label={
            key === "tools"
              ? t("permissions.individualPermissions")
              : t("permissions.serverPermissions")
          }
        >
          <h3 className={`section-heading ${headingStyle}`}>
            {key === "tools" ? t("permissions.tools") : t("permissions.servers")}
          </h3>
          {key === "servers" && (
            <Prose size="2" color="gray">
              {t("permissions.gateHelp")}
            </Prose>
          )}
          {!permissionNames(key, policy, saved, inventory).length && (
            <Prose size="2" className="empty-state">
              {t(key === "tools" ? "permissions.noKnownTools" : "permissions.noKnownServers")}
            </Prose>
          )}
          {key === "tools" && (
            <div hidden={filtering} className="permission-toolbar">
              <span className={style({ font: "body-lg", color: "neutral-subdued" })}>
                {t("permissions.groupCounts", {
                  tools: countText(
                    permissionNames(key, policy, saved, inventory).length,
                    "tool name",
                  ),
                  groups: countText(groups.length, "source group"),
                })}
              </span>
              <div className={actions}>
                <Button
                  variant="secondary"
                  onPress={() => changeExpansion(allGroups.map((group) => group.id))}
                >
                  {t("permissions.expandAll")}
                </Button>
                <Button variant="secondary" onPress={() => changeExpansion([])}>
                  {t("permissions.collapseAll")}
                </Button>
              </div>
            </div>
          )}
          {(key === "tools"
            ? groups
            : [
                {
                  id: "servers",
                  label: t("permissions.serverGates"),
                  names: servers,
                },
              ]
          ).map((group, groupIndex) => (
            <PermissionGroup
              key={group.id}
              group={key === "tools" ? group : undefined}
              expanded={filtering || expanded.includes(group.id)}
              globalEditing={globalEditing}
              searching={filtering}
              onToggle={() =>
                changeExpansion(
                  expanded.includes(group.id)
                    ? expanded.filter((id) => id !== group.id)
                    : [...expanded, group.id],
                )
              }
            >
              {group.names.map((name, index) => {
                const id = `${prefix}-${key}-${groupIndex}-${index}`
                const availability =
                  key === "tools" ? inventory.toolAvailability?.[name] : undefined
                const result = permissionResult(key, name, policy, inventory)
                const global = policy[key].includes(name)
                const selected = policy.defaults[key]?.includes(name) ?? false
                const refs = Object.entries(policy.chats).filter(([, chat]) =>
                  chat[key]?.includes(name),
                )
                const removed = saved[key].includes(name) && !global
                const restored =
                  !saved[key].includes(name) && global && (selected || refs.length > 0)
                const servers =
                  key === "tools" ? inventory.mcp.filter((m) => m.tools.includes(name)) : []
                return (
                  <li
                    key={name}
                    className="permission-row"
                    data-permission-key={key}
                    data-permission-name={name}
                  >
                    <div className="permission-name">
                      <code className={code}>{name}</code>
                      {availability && (
                        <div className="permission-availability">
                          <Badge
                            variant={availability.available ? "neutral" : "notice"}
                            fillStyle="subtle"
                          >
                            {availability.available
                              ? t("permissions.capabilityConfigured")
                              : t("permissions.capabilityUnavailable")}
                          </Badge>
                          <Prose size="2">{availability.reason}</Prose>
                        </div>
                      )}
                      {servers.length > 1 && (
                        <Prose size="2">
                          {t("permissions.serverRequirement", {
                            servers: servers.map((m) => m.name).join(", "),
                          })}
                        </Prose>
                      )}
                      {key === "tools" && !inventory.tools.includes(name) && !servers.length && (
                        <div>
                          <StatusLabel>{t("permissions.notInventory")}</StatusLabel>
                        </div>
                      )}
                      {key === "servers" && !inventory.mcp.some((m) => m.name === name) && (
                        <div>
                          <StatusLabel>{t("permissions.notInventory")}</StatusLabel>
                        </div>
                      )}
                    </div>
                    <label
                      className="check"
                      htmlFor={`${id}-global`}
                      hidden={!globalEditing}
                      data-permission-control="global"
                    >
                      <input
                        type="checkbox"
                        id={`${id}-global`}
                        aria-label={t(
                          key === "tools" ? "permissions.globalTool" : "permissions.globalServer",
                          { name },
                        )}
                        checked={global}
                        onChange={(event) =>
                          onChange({
                            ...policy,
                            [key]: event.target.checked
                              ? [...policy[key], name]
                              : policy[key].filter((v) => v !== name),
                          })
                        }
                      />
                      <span className="permission-mobile-label">
                        {t("permissions.globalAllowed")}
                      </span>
                    </label>
                    <div>
                      <label
                        className="check"
                        htmlFor={`${id}-default`}
                        data-permission-control="default"
                      >
                        <input
                          type="checkbox"
                          id={`${id}-default`}
                          aria-describedby={`${id}-status`}
                          aria-label={t(
                            key === "tools"
                              ? "permissions.defaultTool"
                              : "permissions.defaultServer",
                            { name },
                          )}
                          checked={selected}
                          disabled={!global && !selected}
                          onChange={(event) =>
                            onChange({
                              ...policy,
                              defaults: {
                                ...policy.defaults,
                                [key]: event.target.checked
                                  ? [...(policy.defaults[key] ?? []), name]
                                  : (policy.defaults[key] ?? []).filter((v) => v !== name),
                              },
                            })
                          }
                        />
                        <span className="permission-mobile-label">
                          {t("permissions.useDefault")}
                        </span>
                      </label>
                    </div>
                    <div>
                      <div id={`${id}-status`}>
                        <StatusLabel tone={!global && selected ? "warning" : "neutral"}>
                          {result.statusLabel}
                        </StatusLabel>
                        {!global && selected && (
                          <Prose size="2">{t("permissions.selectionRetained")}</Prose>
                        )}
                      </div>
                      <Prose size="2">
                        {t("permissions.configuredSummary", {
                          selection: t(selected ? "permissions.allow" : "permissions.deny"),
                          source: result.sourceLabel,
                        })}
                      </Prose>
                      {result.blocking && (
                        <div>
                          <Prose size="2">
                            {t("permissions.blockingSource", {
                              source: result.blockingLabel ?? "",
                            })}
                          </Prose>
                          {!global ? (
                            <ActionButton isQuiet onPress={() => repairPermission(key, name)}>
                              {t("permissions.reviewGlobal")}
                            </ActionButton>
                          ) : !selected ? (
                            <ActionButton
                              isQuiet
                              onPress={() => repairPermission(key, name, false)}
                            >
                              {t("permissions.reviewShared")}
                            </ActionButton>
                          ) : (
                            result.blockedServers.map((server) => (
                              <ActionButton
                                key={server.name}
                                isQuiet
                                onPress={() =>
                                  repairPermission(
                                    "servers",
                                    server.name,
                                    !policy.servers.includes(server.name),
                                  )
                                }
                              >
                                {t("permissions.reviewServer", { name: server.name })}
                              </ActionButton>
                            ))
                          )}
                        </div>
                      )}
                      {servers.map((server) => (
                        <Prose key={server.name} size="2">
                          {t("permissions.serverGateState", {
                            name: server.name,
                            state: t(
                              policy.servers.includes(server.name) &&
                                policy.defaults.servers?.includes(server.name)
                                ? "permissions.gateAllowed"
                                : "permissions.serverPermissionBlocked",
                            ),
                          })}
                        </Prose>
                      ))}
                    </div>
                    {removed && (
                      <Prose size="2" color="orange" className="permission-impact">
                        {t("permissions.removalImpact")}
                      </Prose>
                    )}
                    {restored && (
                      <Prose size="2" color="orange" className="permission-impact">
                        {t("permissions.restoreImpact")}
                      </Prose>
                    )}
                    {!global && (selected || refs.length > 0) && (
                      <p className={`permission-impact ${notice}`}>
                        {t("permissions.cannotSaveRetained", {
                          defaults: selected ? t("permissions.retainedDefaults") : "",
                          chats: refs.length > 0 ? t("permissions.retainedChats") : "",
                        })}
                      </p>
                    )}
                    {(global !== saved[key].includes(name) ||
                      selected !== (saved.defaults[key]?.includes(name) ?? false)) && (
                      <Badge
                        variant="notice"
                        fillStyle="subtle"
                        UNSAFE_className="permission-pending"
                      >
                        {t("permissions.pendingPolicy")}
                      </Badge>
                    )}
                  </li>
                )
              })}
            </PermissionGroup>
          ))}
        </Panel>
      ))}
      <details className="permission-rules">
        <summary>{t("permissions.rules")}</summary>
        <Prose size="2" color="gray">
          {t("permissions.rulesHelp")}
        </Prose>
        <Prose size="2">{t("permissions.registrationHelp")}</Prose>
        <Panel className="permission-summary">
          <dl className="data-list">
            <div className="data-row">
              <dt>{t("permissions.savedDefaults")}</dt>
              <dd>{defaultPermissionSummary(saved)}.</dd>
            </div>
            {dirty && (
              <div className="data-row">
                <dt>{t("permissions.draftDefaults")}</dt>
                <dd>{defaultPermissionSummary(policy)}.</dd>
              </div>
            )}
          </dl>
          <Prose size="2" color="gray" className="section-copy">
            {t("permissions.countsHelp")}
          </Prose>
        </Panel>
      </details>
    </div>
  )
}
