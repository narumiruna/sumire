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
import type { Inventory, Policy } from "./api.js"
import { countText } from "./status-text.js"
import { Panel, Prose } from "./surfaces.js"

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
  const content = (
    <>
      <div className="permission-matrix-heading" aria-hidden="true">
        <strong>{group ? "Tool name" : "Server name"}</strong>
        <strong hidden={!globalEditing}>Globally allowed</strong>
        <strong>Default chat permission</strong>
        <strong>Status</strong>
      </div>
      <ul className="permission-list">{children}</ul>
    </>
  )
  if (!group) return content
  return (
    <section className="permission-group" aria-label={group.label}>
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
}: {
  actor: string
  policy: Policy
  saved: Policy
  inventory: Inventory
  onChange(policy: Policy): void
  onChat(id: string): void
  defaultContext: boolean
  dirty: boolean
}) {
  const prefix = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [query, setQuery] = useState("")
  const [globalEditing, setGlobalEditing] = useState(false)
  const term = query.trim().toLowerCase()
  const allGroups = toolPermissionGroups(
    permissionNames("tools", policy, saved, inventory),
    inventory,
  )
  const groups = allGroups
    .map((group) => ({
      ...group,
      names: group.names.filter((name) => `${name} ${group.label}`.toLowerCase().includes(term)),
    }))
    .filter((group) => group.names.length > 0)
  const servers = permissionNames("servers", policy, saved, inventory).filter((name) =>
    name.toLowerCase().includes(term),
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
    if (defaultContext) heading.current?.focus()
  }, [defaultContext])
  return (
    <Flex
      direction="column"
      gap="4"
      className="settings-stack tool-permissions"
      data-global-editing={globalEditing}
    >
      <Flex direction="column" gap="2" className="section-heading">
        <Heading as="h2" ref={heading} tabIndex={-1} id="default-tool-permissions" size="4">
          Default permissions
        </Heading>
        <Prose size="2" color="gray" className="section-copy">
          Choose tools for chats that use shared defaults. Global limits still apply.
        </Prose>
      </Flex>
      <Flex gap="3" align="end" wrap="wrap" className="tool-search">
        <label className="form-field" htmlFor={`${prefix}-search`}>
          Search tools and servers
          <TextField.Root
            id={`${prefix}-search`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Button
          variant="soft"
          aria-pressed={globalEditing}
          onClick={() => setGlobalEditing(!globalEditing)}
        >
          Edit global limits
        </Button>
      </Flex>
      {globalEditing && (
        <Prose size="2">
          Global limits affect every chat. Stored selections are not removed automatically.
        </Prose>
      )}
      {term && !groups.length && !servers.length && (
        <Prose role="status">No matching tools or servers.</Prose>
      )}
      {(["tools", "servers"] as const).map((key) => (
        <Panel
          key={key}
          className="permission-section"
          hidden={Boolean(term) && (key === "tools" ? !groups.length : !servers.length)}
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
              hidden={Boolean(term)}
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
              expanded={Boolean(term) || expanded.includes(group.id)}
              globalEditing={globalEditing}
              searching={Boolean(term)}
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
                  <li key={name} className="permission-row">
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
                          Not in current tool inventory; permissions remain editable.
                        </Text>
                      )}
                      {key === "servers" && !inventory.mcp.some((m) => m.name === name) && (
                        <Text as="p" size="2">
                          Connection not in inventory
                        </Text>
                      )}
                    </div>
                    <label className="check" htmlFor={`${id}-global`} hidden={!globalEditing}>
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
                      <label className="check" htmlFor={`${id}-default`}>
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
                      <Text as="p" size="2" id={`${id}-status`}>
                        {!global
                          ? "Unavailable globally"
                          : selected
                            ? servers.length
                              ? "Tool permission selected; check MCP server gates below"
                              : "Allowed for inheriting chats"
                            : "Not allowed for inheriting chats"}
                        {!global && selected
                          ? " · stored default selection retained; clear it explicitly to resolve the save conflict"
                          : ""}
                      </Text>
                      {servers.map((server) => (
                        <Text key={server.name} as="p" size="2">
                          {server.name}:{" "}
                          {policy.servers.includes(server.name) &&
                          policy.defaults.servers?.includes(server.name)
                            ? "Server gate selected for inheriting chats"
                            : "Blocked by global or default server permission"}
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
                          {refs.length > 0
                            ? `${countText(refs.length, "explicit chat override")}. `
                            : ""}
                          Clear these selections explicitly or restore global permission. No
                          selections were deleted.
                          {refs.map(([id]) => (
                            <Button key={id} variant="ghost" onClick={() => onChat(id)}>
                              Review chat {id}
                            </Button>
                          ))}
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
          Global permission alone does not install a tool. Global permission is the system-wide
          ceiling. Defaults apply only to inheriting chats. Explicit overrides stay in chat details.
          Global changes never clear stored selections. MCP requires both server and individual tool
          permission.
        </Text>
        <Text as="p" size="2">
          New tools are added to global and default permissions when first registered or discovered,
          except approval-only tools such as generate_image. Manual removals and explicit chat
          overrides are preserved. MCP tools still require their server gate.
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
