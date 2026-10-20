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

function readExpansion(actor: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(expansionStorageKey(actor)) ?? "[]")
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function PermissionGroup({
  group,
  expanded,
  onToggle,
  children,
}: {
  group?: ToolPermissionGroup
  expanded: boolean
  onToggle(): void
  children: ReactNode
}) {
  const id = useId()
  const content = (
    <>
      <div className="permission-matrix-heading" aria-hidden="true">
        <strong>{group ? "Tool name" : "Server name"}</strong>
        <strong>Globally allowed</strong>
        <strong>Default chat permission</strong>
        <strong>Effective for inheriting chats</strong>
      </div>
      <ul className="permission-list">{children}</ul>
    </>
  )
  if (!group) return content
  return (
    <section className="permission-group" aria-label={group.label}>
      <Heading as="h4" size="2">
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
  const groups = toolPermissionGroups(permissionNames("tools", policy, saved, inventory), inventory)
  const [expanded, setExpanded] = useState(() => readExpansion(actor))
  function changeExpansion(next: string[]) {
    setExpanded(next)
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
    <Flex direction="column" gap="4" className="settings-stack tool-permissions">
      <Flex direction="column" gap="2" className="section-heading">
        <Heading as="h2" ref={heading} tabIndex={-1} id="default-tool-permissions" size="4">
          Global and default chat permissions
        </Heading>
        <Prose size="2" color="gray" className="section-copy">
          Choose global and default permissions.
        </Prose>
      </Flex>
      <details className="permission-rules">
        <summary>Permission rules and inheritance</summary>
        <Text as="p" size="2" color="gray">
          Global permission is the system-wide ceiling. Defaults apply only to inheriting chats.
          Explicit overrides stay in chat details. Global changes never clear stored selections. MCP
          requires both server and individual tool permission.
        </Text>
      </details>
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
          These counts describe policy selections, not connection readiness or executable MCP tools.
        </Prose>
      </Panel>
      {(["tools", "servers"] as const).map((key) => (
        <Panel
          key={key}
          className="permission-section"
          aria-label={key === "tools" ? "Individual tool permissions" : "MCP server permissions"}
        >
          <Heading as="h3" size="3" className="section-heading">
            {key === "tools" ? "Individual tool names" : "MCP server gates"}
          </Heading>
          <Text as="p" size="2" color="gray" className="section-copy">
            {key === "tools"
              ? "New tools are automatically added to global and default permissions when first registered or discovered. Manual removals and explicit chat overrides are preserved. MCP tools still require their server gate."
              : "A server gate does not approve its tools. Each tool also needs global and inherited or explicit chat permission. Connection enabled state is separate."}
          </Text>
          {!permissionNames(key, policy, saved, inventory).length && (
            <Text as="p" size="2" className="empty-state">
              No {key === "tools" ? "tool names" : "MCP servers"} known. Manual tool-name approval
              remains available below.
            </Text>
          )}
          {key === "tools" && (
            <Flex
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
                  onClick={() => changeExpansion(groups.map((group) => group.id))}
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
                  names: permissionNames(key, policy, saved, inventory),
                },
              ]
          ).map((group, groupIndex) => (
            <PermissionGroup
              key={group.id}
              group={key === "tools" ? group : undefined}
              expanded={expanded.includes(group.id)}
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
                    <label className="check" htmlFor={`${id}-global`}>
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
                        <span className="permission-mobile-label">Default chat permission</span>
                      </label>
                    </div>
                    <div>
                      <Text as="p" size="2" weight="medium" className="permission-mobile-label">
                        Effective for inheriting chats
                      </Text>
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
                          . Connection and chat approval remain separate.
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
    </Flex>
  )
}
