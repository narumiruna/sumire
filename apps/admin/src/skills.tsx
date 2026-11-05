import { Button, Code, Dialog, Flex, Heading } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Inventory, Policy } from "./api.js"
import { t } from "./i18n.js"
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
        <Prose>{t("skill.intro")}</Prose>
        <Dialog.Root open={maintenanceOpen && active} onOpenChange={setMaintenanceOpen}>
          <Dialog.Trigger>
            <Button id="skill-maintenance" variant="soft">
              {t("skill.installation")}
            </Button>
          </Dialog.Trigger>
          <Dialog.Content
            maxWidth="560px"
            onCloseAutoFocus={(event) => {
              if (!active) event.preventDefault()
            }}
          >
            <Dialog.Title>{t("skill.installation")}</Dialog.Title>
            <Dialog.Description>{t("skill.installationDescription")}</Dialog.Description>
            <Prose>{t("skill.installationHelp")}</Prose>
            <Flex justify="end" mt="4">
              <Dialog.Close>
                <Button variant="soft">{t("selection.close")}</Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      </Flex>
      <TableToolbar>
        <Field id="skill-search" label={t("skill.search")} value={query} onChange={setQuery} />
        <Prose size="2">{t("skill.count", { visible: visible.length, total: names.length })}</Prose>
      </TableToolbar>
      {inventory.skills === undefined && <Prose role="status">{t("skill.inventoryUnknown")}</Prose>}
      <div className="skill-columns" aria-hidden="true">
        <strong>{t("skill.column")}</strong>
        <strong>{t("skill.globalEnablement")}</strong>
        <strong>{t("skill.defaultSelection")}</strong>
        <strong>{t("skill.defaultResult")}</strong>
      </div>
      {!visible.length && (
        <Prose className="empty-state">
          {names.length
            ? t("skill.noMatches")
            : inventoryKnown
              ? t("skill.noLoaded")
              : t("skill.noRetained")}
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
          <section key={name} aria-label={t("skill.named", { name })} className="skill-row">
            <div className="skill-identity">
              <Heading as="h3" size="3">
                <Code variant="ghost">{name}</Code>
              </Heading>
              <Prose size="2" className="summary-description">
                {skill?.description
                  ? skillPurpose(skill.description)
                  : skill
                    ? t("skill.noDescription")
                    : inventoryKnown
                      ? t("skill.notInInventory")
                      : t("skill.loadedUnknown")}
              </Prose>
              <Disclosure title={t("skill.fullDescription")}>
                <Prose size="2">{skill?.description || t("skill.noDescription")}</Prose>
                <Prose size="2">
                  {t("skill.inheritanceHelp", {
                    inherited,
                    explicit: Object.keys(policy.chats).length - inherited,
                  })}
                </Prose>
              </Disclosure>
            </div>
            <Check
              label={t("skill.enableNamed", { name })}
              visibleLabel={t("skill.enabledGlobally")}
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
              label={t("skill.defaultNamed", { name })}
              visibleLabel={t("skill.useDefault")}
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
                    ? t("skill.selectedDefault")
                    : inventoryKnown
                      ? t("skill.unavailableNotLoaded")
                      : t("skill.unknownInventory")
                  : !global && selected
                    ? t("skill.blockedGlobally")
                    : t("skill.notSelected")}
              </StatusLabel>
              {!skill && (
                <StatusLabel tone="warning">
                  {inventoryKnown ? t("skill.notLoaded") : t("skill.inventoryUnavailable")}
                </StatusLabel>
              )}
              {pending && <StatusLabel tone="warning">{t("selection.pendingChange")}</StatusLabel>}
            </Flex>
            {!global && (selected || refs.length > 0) && (
              <Prose size="2" color="orange" className="skill-impact">
                {t("skill.retainedHelp")}
              </Prose>
            )}
            {refs.length > 0 && (
              <Disclosure
                title={t("skill.explicitChats", { count: refs.length })}
                className="skill-impact"
                open={!global}
              >
                {refs.map(([id]) => (
                  <Button key={id} variant="ghost" onClick={() => onChat(id)}>
                    {t("selection.chatNamed", { id })}
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
