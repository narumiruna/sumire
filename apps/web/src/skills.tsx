import { Button } from "@react-spectrum/s2/Button"
import { CustomDialog, DialogTrigger, Heading } from "@react-spectrum/s2/CustomDialog"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { useContext, useEffect, useId, useState } from "react"
import type { Inventory, Policy } from "./api.js"
import { Check } from "./check.js"
import { t } from "./i18n.js"
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
  const maintenanceDescription = useId()
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
    <div id="default-skills" tabIndex={-1} className="skills-workspace settings-stack">
      <div
        className={style({
          display: "flex",
          alignItems: "start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        })}
      >
        <Prose>{t("skill.intro")}</Prose>
        <DialogTrigger isOpen={maintenanceOpen && active} onOpenChange={setMaintenanceOpen}>
          <Button id="skill-maintenance" variant="secondary" size="XL">
            {t("skill.installation")}
          </Button>
          <CustomDialog isDismissible aria-describedby={maintenanceDescription}>
            {({ close }) => (
              <>
                <Heading slot="title" styles={style({ font: "title-2xl", margin: 0 })}>
                  {t("skill.installation")}
                </Heading>
                <Prose id={maintenanceDescription}>{t("skill.installationDescription")}</Prose>
                <Prose>{t("skill.installationHelp")}</Prose>
                <div className={style({ display: "flex", justifyContent: "end", marginTop: 16 })}>
                  <Button variant="secondary" size="XL" autoFocus onPress={close}>
                    {t("selection.close")}
                  </Button>
                </div>
              </>
            )}
          </CustomDialog>
        </DialogTrigger>
      </div>
      <TableToolbar>
        <TextField
          id="skill-search"
          label={t("skill.search")}
          size="XL"
          value={query}
          onChange={setQuery}
          autoComplete="off"
          styles={style({ width: "full" })}
        />
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
              <h3 className={style({ font: "heading-xs", color: "title", marginBottom: 8 })}>
                <code>{name}</code>
              </h3>
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
              checked={global}
              onChange={(checked) =>
                onChange({
                  ...policy,
                  skills: checked
                    ? [...(policy.skills ?? []), name]
                    : (policy.skills ?? []).filter((value) => value !== name),
                })
              }
              visibleLabel={t("skill.enabledGlobally")}
            />
            <Check
              label={t("skill.defaultNamed", { name })}
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
              visibleLabel={t("skill.useDefault")}
            />
            <div
              className={style({
                display: "flex",
                flexDirection: "column",
                alignItems: "start",
                gap: 8,
                gridColumn: { "@media (max-width: 650px)": "[1 / -1]" },
              })}
            >
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
            </div>
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
                  <Button
                    key={id}
                    variant="secondary"
                    fillStyle="outline"
                    size="XL"
                    onPress={() => onChat(id)}
                  >
                    {t("selection.chatNamed", { id })}
                  </Button>
                ))}
              </Disclosure>
            )}
          </section>
        )
      })}
    </div>
  )
}
