import { Badge, Button, Flex, Heading } from "@radix-ui/themes"
import { useState } from "react"
import type { Inventory, Policy } from "./api.js"
import { focusEditor } from "./navigation.js"
import { Check, Field } from "./policy-editors.js"
import { Panel, Prose } from "./surfaces.js"

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
      <Field id="skill-search" label="Search skills" value={query} onChange={setQuery} />
      <Prose size="2">
        {visible.length} matching of {names.length} known skills. Changes use Apply policy changes.
      </Prose>
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
          <Panel key={name} aria-label={`Skill ${name}`}>
            <Flex direction="column" align="start" gap="3">
              <Heading size="3">{name}</Heading>
              <Prose size="2">
                {skill
                  ? skill.description || "No description available."
                  : "This skill is not in the loaded inventory. Retained selections can be removed below."}
              </Prose>
              <Flex gap="2" wrap="wrap">
                {!skill && <Badge color="orange">Not loaded</Badge>}
                {pending && <Badge color="orange">Pending policy change</Badge>}
                <Badge color={global && selected ? "green" : "gray"}>
                  {global && selected
                    ? "Selected for inheriting chats"
                    : "Not selected for inheriting chats"}
                </Badge>
              </Flex>
              <Check
                label={`Globally enable skill ${name}`}
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
              {!global && (selected || refs.length > 0) && (
                <Prose size="2" color="orange">
                  Clear retained default and chat selections, or restore global availability before
                  saving.
                </Prose>
              )}
              {refs.length > 0 && (
                <Flex gap="2" align="center" wrap="wrap">
                  <Prose size="2">Explicit chat selections:</Prose>
                  {refs.map(([id]) => (
                    <Button key={id} variant="ghost" onClick={() => onChat(id)}>
                      Chat {id}
                    </Button>
                  ))}
                </Flex>
              )}
            </Flex>
          </Panel>
        )
      })}
    </Flex>
  )
}
