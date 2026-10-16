import { effectivePolicy } from "@narumitw/sumire-policy"
import { Badge, Button, Callout, Card, Checkbox, Heading, Text } from "@radix-ui/themes"
import { useEffect, useId, useRef } from "react"
import type { Inventory, Policy } from "./api.js"

export function defaultPermissionSummary(policy: Policy) {
  const effective = effectivePolicy(policy, 0)
  return `${effective.tools.length} default tool names within global permission · ${effective.servers.length} default MCP server gates within global permission`
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

export function ToolPermissions({
  policy,
  saved,
  inventory,
  onChange,
  onChat,
  defaultContext,
  dirty,
}: {
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
  useEffect(() => {
    if (defaultContext) heading.current?.focus()
  }, [defaultContext])
  return (
    <>
      <Text as="p">Choose global and default permissions, then apply policy changes.</Text>
      <details>
        <summary>Permission rules and inheritance</summary>
        <Text as="p">
          Global permission is the system-wide ceiling. Defaults apply only to inheriting chats.
          Explicit overrides stay in chat details. Global changes never clear stored selections. MCP
          requires both server and individual tool permission.
        </Text>
      </details>
      <Heading as="h2" ref={heading} tabIndex={-1} id="default-tool-permissions" size="3" mt="3">
        Global and default chat permissions
      </Heading>
      <Text as="p" size="2">
        Saved defaults: {defaultPermissionSummary(saved)}. These counts describe policy selections,
        not connection readiness or executable MCP tools.
      </Text>
      {dirty && (
        <Text as="p" size="2">
          Policy draft defaults: {defaultPermissionSummary(policy)}.
        </Text>
      )}
      {(["tools", "servers"] as const).map((key) => (
        <section
          key={key}
          aria-label={key === "tools" ? "Individual tool permissions" : "MCP server permissions"}
        >
          <Heading as="h3" size="3" mt="4">
            {key === "tools" ? "Individual tool names" : "MCP server gates"}
          </Heading>
          <Text as="p" size="2">
            {key === "tools"
              ? "Every MCP tool name needs explicit approval, in addition to its server gate. Discovery and exposure never approve execution."
              : "A server gate does not approve its tools. Each tool also needs global and inherited or explicit chat permission. Connection enabled state is separate."}
          </Text>
          {!permissionNames(key, policy, saved, inventory).length && (
            <Text as="p">
              No {key === "tools" ? "tool names" : "MCP servers"} known. Manual tool-name approval
              remains available below.
            </Text>
          )}
          <div className="permission-matrix-heading" aria-hidden="true">
            <strong>Tool / server</strong>
            <strong>Global</strong>
            <strong>Default</strong>
            <strong>Effective result</strong>
          </div>
          <div className="permission-list">
            {permissionNames(key, policy, saved, inventory).map((name, index) => {
              const id = `${prefix}-${key}-${index}`
              const global = policy[key].includes(name)
              const selected = policy.defaults[key]?.includes(name) ?? false
              const refs = Object.entries(policy.chats).filter(([, chat]) =>
                chat[key]?.includes(name),
              )
              const removed = saved[key].includes(name) && !global
              const restored = !saved[key].includes(name) && global && (selected || refs.length > 0)
              const servers =
                key === "tools" ? inventory.mcp.filter((m) => m.tools.includes(name)) : []
              return (
                <Card key={name} className="permission-row">
                  <div className="permission-name">
                    <Text weight="bold">{name}</Text>
                    {!!servers.length && (
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
                    Globally allowed
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
                      Default chat permission
                    </label>
                  </div>
                  <div>
                    <Text as="p" size="2" weight="medium">
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
                        {refs.length > 0 ? `${refs.length} explicit chat override(s). ` : ""}Clear
                        these selections explicitly or restore global permission. No selections were
                        deleted.
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
                    <Badge color="orange">Pending policy change</Badge>
                  )}
                </Card>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}
