import { Button, Code, Dialog, Flex, Heading } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Inventory, Policy } from "./api.js"
import { Check, Field } from "./policy-editors.js"
import { SectionActive } from "./sections.js"
import { Disclosure, Prose, StatusLabel, TableToolbar } from "./surfaces.js"

export function skillNames(policy: Policy, saved: Policy, inventory: Inventory): string[] {
  return [
    ...new Set([
      ...(inventory.skills ?? []).map((skill) => skill.name),
      ...(policy.skills ?? []),
      ...(saved.skills ?? []),
      ...(policy.defaults.skills ?? []),
      ...(saved.defaults.skills ?? []),
      ...Object.values(policy.chats).flatMap((chat) => chat.skills ?? []),
      ...Object.values(saved.chats).flatMap((chat) => chat.skills ?? []),
    ]),
  ].sort((a, b) => a.localeCompare(b))
}

export function skillPurpose(description: string): string {
  const text = description.replace(/\s+/g, " ").trim()
  const sentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? text
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence
}

export function Skills({
  policy,
  saved,
  inventory,
  onChange,
  onChat,
}: {
  policy: Policy
  saved: Policy
  inventory: Inventory
  onChange(policy: Policy): void
  onChat(id: string): void
}) {
  const [query, setQuery] = useState("")
  const active = useContext(SectionActive)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  useEffect(() => {
    if (!active) setMaintenanceOpen(false)
  }, [active])
  const names = skillNames(policy, saved, inventory)
  const inventoryKnown = inventory.skills !== undefined
  const metadata = new Map((inventory.skills ?? []).map((skill) => [skill.name, skill]))
  const visible = names.filter((name) =>
    `${name} ${metadata.get(name)?.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <Flex id="default-skills" tabIndex={-1} direction="column" gap="4" className="skills-workspace">
      <Flex gap="3" align="start" justify="between" wrap="wrap">
        <Prose>Skills add model instructions, not tool permissions or file restrictions.</Prose>
        <Dialog.Root open={maintenanceOpen && active} onOpenChange={setMaintenanceOpen}>
          <Dialog.Trigger>
            <Button id="skill-maintenance" variant="soft">
              Installation instructions
            </Button>
          </Dialog.Trigger>
          <Dialog.Content
            maxWidth="560px"
            onCloseAutoFocus={(event) => {
              if (!active) event.preventDefault()
            }}
          >
            <Dialog.Title>Installation instructions</Dialog.Title>
            <Dialog.Description>
              Skill files require trusted host maintenance. This page manages policy selections
              only.
            </Dialog.Description>
            <Prose>
              Install, update, or remove skill files on the host, then restart the bot to refresh
              this inventory. Loaded skills are enabled globally and by default when first
              registered. Manual removals and explicit chat selections stay unchanged after restart.
            </Prose>
            <Flex justify="end" mt="4">
              <Dialog.Close>
                <Button variant="soft">Close</Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      </Flex>
      <TableToolbar>
        <Field id="skill-search" label="Search skills" value={query} onChange={setQuery} />
        <Prose size="2">
          {visible.length} of {names.length} skills
        </Prose>
      </TableToolbar>
      {inventory.skills === undefined && (
        <Prose role="status">
          Skill inventory unavailable. Retained policy selections are shown; loaded state is
          unknown.
        </Prose>
      )}
      <div className="skill-columns" aria-hidden="true">
        <strong>Skill</strong>
        <strong>Global enablement</strong>
        <strong>Default selection</strong>
        <strong>Default result</strong>
      </div>
      {!visible.length && (
        <Prose className="empty-state">
          {names.length
            ? "No matching skills."
            : inventoryKnown
              ? "No skills loaded or selected."
              : "No retained skill selections."}
        </Prose>
      )}
      {visible.map((name) => {
        const skill = metadata.get(name)
        const global = (policy.skills ?? []).includes(name)
        const selected = policy.defaults.skills?.includes(name) ?? false
        const refs = Object.entries(policy.chats).filter(([, chat]) => chat.skills?.includes(name))
        const inherited = Object.values(policy.chats).filter((chat) => chat.skills === null).length
        const pending =
          global !== (saved.skills ?? []).includes(name) ||
          selected !== (saved.defaults.skills?.includes(name) ?? false)
        return (
          <section key={name} aria-label={`Skill ${name}`} className="skill-row">
            <div className="skill-identity">
              <Heading as="h3" size="3">
                <Code variant="ghost">{name}</Code>
              </Heading>
              <Prose size="2" className="summary-description">
                {skill?.description
                  ? skillPurpose(skill.description)
                  : skill
                    ? "No description available."
                    : inventoryKnown
                      ? "Not in the loaded inventory."
                      : "Loaded state unknown."}
              </Prose>
              <Disclosure title="Full description">
                <Prose size="2">{skill?.description || "No description available."}</Prose>
                <Prose size="2">
                  {inherited} configured chat overrides inherit the default skill selection.{" "}
                  {Object.keys(policy.chats).length - inherited} use explicit lists, including empty
                  lists. Explicit chat selections remain unchanged when the default changes. Skill
                  selection does not grant tool access.
                </Prose>
              </Disclosure>
            </div>
            <Check
              label={`Globally enable skill ${name}`}
              visibleLabel="Enabled globally"
              checked={global}
              onChange={(checked) =>
                onChange({
                  ...policy,
                  skills: checked
                    ? [...(policy.skills ?? []), name]
                    : (policy.skills ?? []).filter((value) => value !== name),
                })
              }
            />
            <Check
              label={`Default chat selection for skill ${name}`}
              visibleLabel="Use by default"
              checked={selected}
              disabled={!global && !selected}
              onChange={(checked) =>
                onChange({
                  ...policy,
                  defaults: {
                    ...policy.defaults,
                    skills: checked
                      ? [...(policy.defaults.skills ?? []), name]
                      : (policy.defaults.skills ?? []).filter((value) => value !== name),
                  },
                })
              }
            />
            <Flex direction="column" align="start" gap="2">
              <StatusLabel tone={global && selected && skill ? "success" : "neutral"}>
                {global && selected
                  ? skill
                    ? "Selected by default"
                    : inventoryKnown
                      ? "Unavailable: not loaded"
                      : "Unknown: inventory unavailable"
                  : !global && selected
                    ? "Blocked globally"
                    : "Not selected"}
              </StatusLabel>
              {!skill && (
                <StatusLabel tone="warning">
                  {inventoryKnown ? "Not loaded" : "Inventory unavailable"}
                </StatusLabel>
              )}
              {pending && <StatusLabel tone="warning">Pending change</StatusLabel>}
            </Flex>
            {!global && (selected || refs.length > 0) && (
              <Prose size="2" color="orange" className="skill-impact">
                Clear retained default and chat selections, or restore global availability before
                saving.
              </Prose>
            )}
            {refs.length > 0 && (
              <Disclosure
                title={`Explicit chat selections (${refs.length})`}
                className="skill-impact"
                open={!global}
              >
                {refs.map(([id]) => (
                  <Button key={id} variant="ghost" onClick={() => onChat(id)}>
                    Chat {id}
                  </Button>
                ))}
              </Disclosure>
            )}
          </section>
        )
      })}
    </Flex>
  )
}
