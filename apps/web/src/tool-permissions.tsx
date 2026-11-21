import { effectivePolicy } from "@narumitw/sumire-policy"
import { ChevronDownIcon, ChevronRightIcon } from "@radix-ui/react-icons"
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Code,
  DataList,
  Flex,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import type { Inventory, Policy, Selection } from "./api.js"
import { t } from "./i18n.js"
import { SectionSelect as Select } from "./sections.js"
import { countText } from "./status-text.js"
import { Panel, Prose, StatusLabel, TableToolbar } from "./surfaces.js"

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
        <Heading as="h4" size="2">
          {searching ? (
            <Text>
              {group.label} · {countText(group.names.length, "tool")}
            </Text>
          ) : (
            <Button
              variant="ghost"
              className="permission-group-toggle"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={onToggle}
            >
              {expanded ? (
                <ChevronDownIcon aria-hidden="true" />
              ) : (
                <ChevronRightIcon aria-hidden="true" />
              )}
              <Text>{group.label} ·</Text>
              <Badge color="gray" variant="soft">
                {countText(group.names.length, "tool")}
              </Badge>
            </Button>
          )}
        </Heading>
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
          `[data-permission-control="${global ? "global" : "default"}"] [role="checkbox"]`,
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
    <Flex
      direction="column"
      gap="4"
      className="settings-stack tool-permissions"
      ref={matrix}
      data-global-editing={globalEditing}
    >
      <section ref={scope} className="permission-scope" aria-label={t("permissions.editScope")}>
        <Heading as="h2" ref={heading} tabIndex={-1} id="default-tool-permissions" size="3">
          {globalEditing ? t("permissions.editGlobalDefaults") : t("permissions.editDefaults")}
        </Heading>
        <Flex gap="2" wrap="wrap" aria-label={t("permissions.scope")}>
          <Button
            variant="soft"
            aria-pressed={globalEditing}
            onClick={() => setGlobalEditing(true)}
          >
            {t("permissions.globalPolicy")}
          </Button>
          <Button
            variant="soft"
            aria-pressed={!globalEditing}
            onClick={() => setGlobalEditing(false)}
          >
            {t("permissions.sourceDefaults")}
          </Button>
          <Button
            variant="soft"
            aria-label={
              selectedChat
                ? t("permissions.selectedChat", { id: selectedChat })
                : t("permissions.noSelectedChat")
            }
            disabled={!selectedChat}
            onClick={() => onChat(selectedChat)}
          >
            {selectedChat ? t("permissions.chatName", { id: selectedChat }) : t("permissions.chat")}
          </Button>
        </Flex>
        <Text as="p" size="1">
          {globalEditing ? t("permissions.globalHelp") : t("permissions.defaultsHelp")}
        </Text>
        {(changes.global > 0 || changes.defaults > 0) && (
          <Text as="p" size="2">
            {t("permissions.changedCounts", {
              global: countText(changes.global, "changed global tool/server name"),
              defaults: countText(changes.defaults, "changed shared-default tool/server name"),
            })}
          </Text>
        )}
      </section>
      <Callout.Root color="amber" aria-label={t("permissions.credentialAccess")}>
        <Callout.Text>{t("permissions.hostWarning")}</Callout.Text>
      </Callout.Root>
      {conflicts.length > 0 && (
        <section className="permission-conflicts" aria-label={t("permissions.retainedConflicts")}>
          <Heading as="h3" size="3">
            {t("permissions.cannotSaveCount", {
              count: countText(conflicts.length, "tool/server name"),
            })}
          </Heading>
          <Text as="p" size="2">
            {t("permissions.conflictsHelp")}
          </Text>
          <ul>
            {conflicts.map((conflict) => (
              <li key={`${conflict.key}:${conflict.name}`}>
                <Code>{conflict.name}</Code> ·{" "}
                {conflict.defaults ? t("permissions.conflictDefaults") : ""}
                {conflict.chats.length > 0
                  ? t("permissions.chatOverrides", {
                      count: countText(conflict.chats.length, "explicit chat override"),
                      chats: conflict.chats.join(", "),
                    })
                  : ""}
                <Button
                  variant="ghost"
                  onClick={() => repairPermission(conflict.key, conflict.name)}
                >
                  {t("permissions.reviewGlobalName", { name: conflict.name })}
                </Button>
                {conflict.defaults && (
                  <Button
                    variant="ghost"
                    onClick={() => repairPermission(conflict.key, conflict.name, false)}
                  >
                    {t("permissions.reviewSharedName", { name: conflict.name })}
                  </Button>
                )}
                {conflict.chats.map((id) => (
                  <Button key={id} variant="ghost" onClick={() => onChat(id)}>
                    {t("permissions.reviewChat", { id })}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TableToolbar className="tool-search">
        <label className="form-field" htmlFor={`${prefix}-search`}>
          {t("permissions.search")}
          <TextField.Root
            id={`${prefix}-search`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${prefix}-filter`}>
          {t("permissions.toolStatus")}
          <Select.Root
            value={filter}
            onValueChange={(value) => setFilter(value as PermissionFilter)}
          >
            <Select.Trigger id={`${prefix}-filter`} aria-label={t("permissions.toolStatus")} />
            <Select.Content>
              <Select.Item value="all">{t("permissions.all")}</Select.Item>
              <Select.Item value="selected">{t("permissions.selectedDefault")}</Select.Item>
              <Select.Item value="blocked">{t("permissions.blockedPolicy")}</Select.Item>
              <Select.Item value="changed">{t("permissions.pendingChanges")}</Select.Item>
              <Select.Item value="missing">{t("permissions.notInventory")}</Select.Item>
              <Select.Item value="unavailable">
                {t("permissions.capabilityUnavailable")}
              </Select.Item>
            </Select.Content>
          </Select.Root>
        </label>
        <Button
          variant="soft"
          aria-pressed={globalEditing}
          onClick={() => setGlobalEditing(!globalEditing)}
        >
          {t("permissions.editGlobal")}
        </Button>
      </TableToolbar>
      {filtering && (
        <Flex gap="2" wrap="wrap" align="center">
          <Text role="status" size="2">
            {t("permissions.matchCounts", {
              tools: countText(
                new Set(groups.flatMap((group) => group.names)).size,
                "matching tool",
              ),
              servers: countText(servers.length, "matching server"),
            })}
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("")
              setFilter("all")
            }}
          >
            {t("permissions.clearFilters")}
          </Button>
        </Flex>
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
          <Heading as="h3" size="3" className="section-heading">
            {key === "tools" ? t("permissions.tools") : t("permissions.servers")}
          </Heading>
          {key === "servers" && (
            <Text as="p" size="2" color="gray">
              {t("permissions.gateHelp")}
            </Text>
          )}
          {!permissionNames(key, policy, saved, inventory).length && (
            <Text as="p" size="2" className="empty-state">
              {t(key === "tools" ? "permissions.noKnownTools" : "permissions.noKnownServers")}
            </Text>
          )}
          {key === "tools" && (
            <Flex
              hidden={filtering}
              gap="3"
              my="3"
              wrap="wrap"
              align="center"
              justify="between"
              className="permission-toolbar"
            >
              <Text size="2" color="gray">
                {t("permissions.groupCounts", {
                  tools: countText(
                    permissionNames(key, policy, saved, inventory).length,
                    "tool name",
                  ),
                  groups: countText(groups.length, "source group"),
                })}
              </Text>
              <Flex gap="2" wrap="wrap">
                <Button
                  variant="soft"
                  onClick={() => changeExpansion(allGroups.map((group) => group.id))}
                >
                  {t("permissions.expandAll")}
                </Button>
                <Button variant="soft" onClick={() => changeExpansion([])}>
                  {t("permissions.collapseAll")}
                </Button>
              </Flex>
            </Flex>
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
                      <Code variant="ghost" weight="medium">
                        {name}
                      </Code>
                      {availability && (
                        <Flex direction="column" gap="1" mt="1">
                          <Badge color={availability.available ? "gray" : "orange"}>
                            {availability.available
                              ? t("permissions.capabilityConfigured")
                              : t("permissions.capabilityUnavailable")}
                          </Badge>
                          <Text as="p" size="2">
                            {availability.reason}
                          </Text>
                        </Flex>
                      )}
                      {servers.length > 1 && (
                        <Text as="p" size="2">
                          {t("permissions.serverRequirement", {
                            servers: servers.map((m) => m.name).join(", "),
                          })}
                        </Text>
                      )}
                      {key === "tools" && !inventory.tools.includes(name) && !servers.length && (
                        <Text as="p" size="2">
                          <Badge color="gray">{t("permissions.notInventory")}</Badge>
                        </Text>
                      )}
                      {key === "servers" && !inventory.mcp.some((m) => m.name === name) && (
                        <Text as="p" size="2">
                          <Badge color="gray">{t("permissions.notInventory")}</Badge>
                        </Text>
                      )}
                    </div>
                    <label
                      className="check"
                      htmlFor={`${id}-global`}
                      hidden={!globalEditing}
                      data-permission-control="global"
                    >
                      <Checkbox
                        id={`${id}-global`}
                        aria-label={t(
                          key === "tools" ? "permissions.globalTool" : "permissions.globalServer",
                          { name },
                        )}
                        checked={global}
                        onCheckedChange={(checked) =>
                          onChange({
                            ...policy,
                            [key]:
                              checked === true
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
                        <Checkbox
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
                          onCheckedChange={(checked) =>
                            onChange({
                              ...policy,
                              defaults: {
                                ...policy.defaults,
                                [key]:
                                  checked === true
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
                          <Text as="p" size="2">
                            {t("permissions.selectionRetained")}
                          </Text>
                        )}
                      </div>
                      <Text as="p" size="2">
                        {t("permissions.configuredSummary", {
                          selection: t(selected ? "permissions.allow" : "permissions.deny"),
                          source: result.sourceLabel,
                        })}
                      </Text>
                      {result.blocking && (
                        <div>
                          <Text as="p" size="2">
                            {t("permissions.blockingSource", {
                              source: result.blockingLabel ?? "",
                            })}
                          </Text>
                          {!global ? (
                            <Button variant="ghost" onClick={() => repairPermission(key, name)}>
                              {t("permissions.reviewGlobal")}
                            </Button>
                          ) : !selected ? (
                            <Button
                              variant="ghost"
                              onClick={() => repairPermission(key, name, false)}
                            >
                              {t("permissions.reviewShared")}
                            </Button>
                          ) : (
                            result.blockedServers.map((server) => (
                              <Button
                                key={server.name}
                                variant="ghost"
                                onClick={() =>
                                  repairPermission(
                                    "servers",
                                    server.name,
                                    !policy.servers.includes(server.name),
                                  )
                                }
                              >
                                {t("permissions.reviewServer", { name: server.name })}
                              </Button>
                            ))
                          )}
                        </div>
                      )}
                      {servers.map((server) => (
                        <Text key={server.name} as="p" size="2">
                          {t("permissions.serverGateState", {
                            name: server.name,
                            state: t(
                              policy.servers.includes(server.name) &&
                                policy.defaults.servers?.includes(server.name)
                                ? "permissions.gateAllowed"
                                : "permissions.serverPermissionBlocked",
                            ),
                          })}
                        </Text>
                      ))}
                    </div>
                    {removed && (
                      <Text as="p" size="2" color="orange" className="permission-impact">
                        {t("permissions.removalImpact")}
                      </Text>
                    )}
                    {restored && (
                      <Text as="p" size="2" color="orange" className="permission-impact">
                        {t("permissions.restoreImpact")}
                      </Text>
                    )}
                    {!global && (selected || refs.length > 0) && (
                      <Callout.Root color="orange" className="permission-impact">
                        <Callout.Text>
                          {t("permissions.cannotSaveRetained", {
                            defaults: selected ? t("permissions.retainedDefaults") : "",
                            chats: refs.length > 0 ? t("permissions.retainedChats") : "",
                          })}
                        </Callout.Text>
                      </Callout.Root>
                    )}
                    {(global !== saved[key].includes(name) ||
                      selected !== (saved.defaults[key]?.includes(name) ?? false)) && (
                      <Badge color="orange" className="permission-pending">
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
        <Text as="p" size="2" color="gray">
          {t("permissions.rulesHelp")}
        </Text>
        <Text as="p" size="2">
          {t("permissions.registrationHelp")}
        </Text>
        <Panel className="permission-summary">
          <DataList.Root size="2" className="data-list">
            <DataList.Item className="data-row">
              <DataList.Label>{t("permissions.savedDefaults")}</DataList.Label>
              <DataList.Value>{defaultPermissionSummary(saved)}.</DataList.Value>
            </DataList.Item>
            {dirty && (
              <DataList.Item className="data-row">
                <DataList.Label>{t("permissions.draftDefaults")}</DataList.Label>
                <DataList.Value>{defaultPermissionSummary(policy)}.</DataList.Value>
              </DataList.Item>
            )}
          </DataList.Root>
          <Prose size="2" color="gray" className="section-copy">
            {t("permissions.countsHelp")}
          </Prose>
        </Panel>
      </details>
    </Flex>
  )
}
