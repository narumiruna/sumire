import { Button, Code, Flex, Heading } from "@radix-ui/themes"
import { useState } from "react"
import type { Inventory, Policy } from "./api.js"
import { focusEditor } from "./navigation.js"
import { Check, Field } from "./policy-editors.js"
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
  const names = skillNames(policy, saved, inventory)
  const metadata = new Map((inventory.skills ?? []).map((skill) => [skill.name, skill]))
  const visible = names.filter((name) =>
    `${name} ${metadata.get(name)?.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <Flex direction="column" gap="4" className="skills-workspace">
      <Prose>Skills add model instructions, not tool permissions or file restrictions.</Prose>
      <details>
        <summary id="skill-maintenance">Install and update skills</summary>
        <Prose size="2">
          Loaded skills are enabled globally and by default when first registered. Manual removals
          and explicit chat selections stay unchanged after restart. Install or update skill files
          on the host, then restart the bot to refresh this inventory. This page does not edit skill
          files.
        </Prose>
      </details>
      <TableToolbar>
        <Field id="skill-search" label="Search skills" value={query} onChange={setQuery} />
        <Prose size="2">
          {visible.length} of {names.length} skills
        </Prose>
      </TableToolbar>
      <div className="skill-columns" aria-hidden="true">
        <strong>Skill</strong>
        <strong>Global enablement</strong>
        <strong>Default selection</strong>
        <strong>Effective state</strong>
      </div>
      {!visible.length && (
        <Prose className="empty-state">
          {names.length ? "No matching skills." : "No skills loaded or selected."}
        </Prose>
      )}
      {!names.length && (
        <Button variant="soft" onClick={() => focusEditor("#skill-maintenance")}>
          Show skill setup instructions
        </Button>
      )}
      {visible.map((name) => {
        const skill = metadata.get(name)
        const global = (policy.skills ?? []).includes(name)
        const selected = policy.defaults.skills?.includes(name) ?? false
        const refs = Object.entries(policy.chats).filter(([, chat]) => chat.skills?.includes(name))
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
                {skill?.description ||
                  (skill ? "No description available." : "Not in the loaded inventory.")}
              </Prose>
              {skill?.description && (
                <Disclosure title="Full description">
                  <Prose size="2">{skill.description}</Prose>
                </Disclosure>
              )}
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
              <StatusLabel tone={global && selected ? "success" : "neutral"}>
                {global && selected
                  ? "Selected by default"
                  : !global && selected
                    ? "Blocked globally"
                    : "Not selected"}
              </StatusLabel>
              {!skill && <StatusLabel tone="warning">Not loaded</StatusLabel>}
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
