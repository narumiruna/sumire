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
import { SectionSelect as Select } from "./sections.js"
import { countText } from "./status-text.js"
import { Panel, Prose, StatusLabel, TableToolbar } from "./surfaces.js"

export function defaultPermissionSummary(policy: Policy) {
  const effective = effectivePolicy(policy, 0)
  return `${countText(effective.tools.length, "default tool name")} within global permission · ${countText(effective.servers.length, "default MCP server gate")} within global permission`
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
  const gates = key === "tools" ? inventory.mcp.filter((server) => server.tools.includes(name)) : []
  const blockedServers = gates.filter((server) => !effective.servers.includes(server.name))
  return {
    selected: selection.includes(name),
    source,
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
      label: "Built-in tools",
      names: names.filter((name) => inventory.builtInTools?.includes(name)),
    },
    ...inventory.mcp.map((server) => ({
      id: `mcp:${server.name}`,
      label: `MCP: ${server.name}`,
      names: names.filter((name) => server.tools.includes(name)),
    })),
    { id: "unknown", label: "Unknown source", names: names.filter((name) => !known.has(name)) },
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
      <strong>{group ? "Tool name" : "Server name"}</strong>
      <strong hidden={!globalEditing}>Globally allowed</strong>
      <strong>Default chat permission</strong>
      <strong>Effective permission</strong>
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
      <section ref={scope} className="permission-scope" aria-label="Permission editing scope">
        <Heading as="h2" ref={heading} tabIndex={-1} id="default-tool-permissions" size="3">
          {globalEditing ? "Editing global limits and shared defaults" : "Editing shared defaults"}
        </Heading>
        <Flex gap="2" wrap="wrap" aria-label="Permission scope">
          <Button
            variant="soft"
            aria-pressed={globalEditing}
            onClick={() => setGlobalEditing(true)}
          >
            Global policy
          </Button>
          <Button
            variant="soft"
            aria-pressed={!globalEditing}
            onClick={() => setGlobalEditing(false)}
          >
            Shared defaults
          </Button>
          <Button
            variant="soft"
            aria-label={
              selectedChat ? `Selected chat ${selectedChat}` : "Selected chat · none selected"
            }
            disabled={!selectedChat}
            onClick={() => onChat(selectedChat)}
          >
            {selectedChat ? `Chat ${selectedChat}` : "Chat"}
          </Button>
        </Flex>
        <Text as="p" size="1">
          {globalEditing
            ? "Global policy limits every chat."
            : "Chats without a tool override use these defaults."}
        </Text>
        {(changes.global > 0 || changes.defaults > 0) && (
          <Text as="p" size="2">
            {countText(changes.global, "changed global tool/server name")} ·{" "}
            {countText(changes.defaults, "changed shared-default tool/server name")} · Includes
            filtered names
          </Text>
        )}
      </section>
      <Callout.Root color="amber" aria-label="Shell and file credential access">
        <Callout.Text>
          Shell and file tools are not sandboxed. They can access process-readable credentials.
          Skill selection does not grant tool permission.
        </Callout.Text>
      </Callout.Root>
      {conflicts.length > 0 && (
        <section className="permission-conflicts" aria-label="Retained permission conflicts">
          <Heading as="h3" size="3">
            Cannot save: {countText(conflicts.length, "tool/server name")} outside Global policy
          </Heading>
          <Text as="p" size="2">
            Conflicts include filtered names and collapsed groups. Clear retained selections or
            restore global permission.
          </Text>
          <ul>
            {conflicts.map((conflict) => (
              <li key={`${conflict.key}:${conflict.name}`}>
                <Code>{conflict.name}</Code> · {conflict.defaults ? "Shared defaults; " : ""}
                {conflict.chats.length > 0
                  ? `${countText(conflict.chats.length, "explicit chat override")}: ${conflict.chats.join(", ")}`
                  : ""}
                <Button
                  variant="ghost"
                  onClick={() => repairPermission(conflict.key, conflict.name)}
                >
                  Review global permission for {conflict.name}
                </Button>
                {conflict.defaults && (
                  <Button
                    variant="ghost"
                    onClick={() => repairPermission(conflict.key, conflict.name, false)}
                  >
                    Review shared selection for {conflict.name}
                  </Button>
                )}
                {conflict.chats.map((id) => (
                  <Button key={id} variant="ghost" onClick={() => onChat(id)}>
                    Review chat {id}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      <TableToolbar className="tool-search">
        <label className="form-field" htmlFor={`${prefix}-search`}>
          Search tools and servers
          <TextField.Root
            id={`${prefix}-search`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${prefix}-filter`}>
          Tool status
          <Select.Root
            value={filter}
            onValueChange={(value) => setFilter(value as PermissionFilter)}
          >
            <Select.Trigger id={`${prefix}-filter`} aria-label="Tool status" />
            <Select.Content>
              <Select.Item value="all">All</Select.Item>
              <Select.Item value="selected">Selected by default</Select.Item>
              <Select.Item value="blocked">Blocked by policy</Select.Item>
              <Select.Item value="changed">Pending changes</Select.Item>
              <Select.Item value="missing">Not in inventory</Select.Item>
              <Select.Item value="unavailable">Capability unavailable</Select.Item>
            </Select.Content>
          </Select.Root>
        </label>
        <Button
          variant="soft"
          aria-pressed={globalEditing}
          onClick={() => setGlobalEditing(!globalEditing)}
        >
          Edit global limits
        </Button>
      </TableToolbar>
      {filtering && (
        <Flex gap="2" wrap="wrap" align="center">
          <Text role="status" size="2">
            {countText(new Set(groups.flatMap((group) => group.names)).size, "matching tool")} ·{" "}
            {countText(servers.length, "matching server")}
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("")
              setFilter("all")
            }}
          >
            Clear tool filters
          </Button>
        </Flex>
      )}
      {filtering && !groups.length && !servers.length && (
        <Prose role="status">No matching tools or servers.</Prose>
      )}
      {(["tools", "servers"] as const).map((key) => (
        <Panel
          key={key}
          className="permission-section"
          hidden={filtering && (key === "tools" ? !groups.length : !servers.length)}
          aria-label={key === "tools" ? "Individual tool permissions" : "MCP server permissions"}
        >
          <Heading as="h3" size="3" className="section-heading">
            {key === "tools" ? "Tools" : "MCP servers"}
          </Heading>
          {key === "servers" && (
            <Text as="p" size="2" color="gray">
              A server gate does not approve its tools. Each tool also needs permission. Connection
              enabled state is separate.
            </Text>
          )}
          {!permissionNames(key, policy, saved, inventory).length && (
            <Text as="p" size="2" className="empty-state">
              No {key === "tools" ? "tool names" : "MCP servers"} known. Manual tool-name approval
              remains available below.
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
                {countText(permissionNames(key, policy, saved, inventory).length, "tool name")} ·{" "}
                {countText(groups.length, "source group")}
              </Text>
              <Flex gap="2" wrap="wrap">
                <Button
                  variant="soft"
                  onClick={() => changeExpansion(allGroups.map((group) => group.id))}
                >
                  Expand all
                </Button>
                <Button variant="soft" onClick={() => changeExpansion([])}>
                  Collapse all
                </Button>
              </Flex>
            </Flex>
          )}
          {(key === "tools"
            ? groups
            : [
                {
                  id: "servers",
                  label: "MCP server gates",
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
                              ? "Capability configured"
                              : "Capability unavailable"}
                          </Badge>
                          <Text as="p" size="2">
                            {availability.reason}
                          </Text>
                        </Flex>
                      )}
                      {servers.length > 1 && (
                        <Text as="p" size="2">
                          MCP server: {servers.map((m) => m.name).join(", ")} · server gate also
                          required
                        </Text>
                      )}
                      {key === "tools" && !inventory.tools.includes(name) && !servers.length && (
                        <Text as="p" size="2">
                          <Badge color="gray">Not in inventory</Badge>
                        </Text>
                      )}
                      {key === "servers" && !inventory.mcp.some((m) => m.name === name) && (
                        <Text as="p" size="2">
                          <Badge color="gray">Not in inventory</Badge>
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
                        aria-label={`Globally allow ${key === "tools" ? "tool" : "server"} ${name}`}
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
                      <span className="permission-mobile-label">Globally allowed</span>
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
                          aria-label={`Default chat permission for ${key === "tools" ? "tool" : "server"} ${name}`}
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
                        <span className="permission-mobile-label">Use by default</span>
                      </label>
                    </div>
                    <div>
                      <div id={`${id}-status`}>
                        <StatusLabel tone={!global && selected ? "warning" : "neutral"}>
                          {result.status}
                        </StatusLabel>
                        {!global && selected && (
                          <Text as="p" size="2">
                            Default selection retained.
                          </Text>
                        )}
                      </div>
                      <Text as="p" size="2">
                        Configured: {selected ? "Allow" : "Deny"} · {result.source}
                      </Text>
                      {result.blocking && (
                        <div>
                          <Text as="p" size="2">
                            Blocking source: {result.blocking}
                          </Text>
                          {!global ? (
                            <Button variant="ghost" onClick={() => repairPermission(key, name)}>
                              Review global permission
                            </Button>
                          ) : !selected ? (
                            <Button
                              variant="ghost"
                              onClick={() => repairPermission(key, name, false)}
                            >
                              Review shared selection
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
                                Review server gate {server.name}
                              </Button>
                            ))
                          )}
                        </div>
                      )}
                      {servers.map((server) => (
                        <Text key={server.name} as="p" size="2">
                          {server.name}:{" "}
                          {policy.servers.includes(server.name) &&
                          policy.defaults.servers?.includes(server.name)
                            ? "Gate allowed"
                            : "Blocked by server permission"}
                          .
                        </Text>
                      ))}
                    </div>
                    {removed && (
                      <Text as="p" size="2" color="orange" className="permission-impact">
                        Global removal blocks this capability for every chat after a valid policy
                        save.
                      </Text>
                    )}
                    {restored && (
                      <Text as="p" size="2" color="orange" className="permission-impact">
                        Global approval makes retained default or explicit chat selections effective
                        again, subject to other required gates.
                      </Text>
                    )}
                    {!global && (selected || refs.length > 0) && (
                      <Callout.Root color="orange" className="permission-impact">
                        <Callout.Text>
                          Cannot save while this name remains selected:{" "}
                          {selected ? "shared defaults; " : ""}
                          {refs.length > 0 ? "Explicit chat selections; " : ""}
                          Clear these selections explicitly or restore global permission. No
                          selections were deleted.
                        </Callout.Text>
                      </Callout.Root>
                    )}
                    {(global !== saved[key].includes(name) ||
                      selected !== (saved.defaults[key]?.includes(name) ?? false)) && (
                      <Badge color="orange" className="permission-pending">
                        Pending policy change
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
        <summary>Permission rules and inheritance</summary>
        <Text as="p" size="2" color="gray">
          Shared defaults select tools for chats without an override, within global limits. Not in
          inventory means the name is absent from the loaded inventory; permissions remain editable.
          Capability unavailable means a local requirement is missing, not a permission denial.
          Global permission alone does not install a tool. Global permission is the system-wide
          ceiling. Defaults apply only to inheriting chats. Explicit overrides stay in chat details.
          Global changes never clear stored selections. MCP requires both server and individual tool
          permission.
        </Text>
        <Text as="p" size="2">
          Ordinary built-in tools can be enabled when first registered. MCP discovery records
          published names without granting permissions. Approval-only tools such as generate_image
          need explicit approval. Manual removals and explicit chat overrides are preserved. MCP
          execution also requires its server gate.
        </Text>
        <Panel className="permission-summary">
          <DataList.Root size="2" className="data-list">
            <DataList.Item className="data-row">
              <DataList.Label>Saved defaults</DataList.Label>
              <DataList.Value>{defaultPermissionSummary(saved)}.</DataList.Value>
            </DataList.Item>
            {dirty && (
              <DataList.Item className="data-row">
                <DataList.Label>Policy draft defaults</DataList.Label>
                <DataList.Value>{defaultPermissionSummary(policy)}.</DataList.Value>
              </DataList.Item>
            )}
          </DataList.Root>
          <Prose size="2" color="gray" className="section-copy">
            These counts describe policy selections, not installed tools or verified provider
            access.
          </Prose>
        </Panel>
      </details>
    </Flex>
  )
}
