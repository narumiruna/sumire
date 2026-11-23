import { ActionButton } from "@react-spectrum/s2/ActionButton"
import { AlertDialog, DialogContainer } from "@react-spectrum/s2/AlertDialog"
import { Badge } from "@react-spectrum/s2/Badge"
import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import Checkmark from "@react-spectrum/s2/icons/Checkmark"
import Delete from "@react-spectrum/s2/icons/Delete"
import Edit from "@react-spectrum/s2/icons/Edit"
import InfoCircle from "@react-spectrum/s2/icons/InfoCircle"
import Lock from "@react-spectrum/s2/icons/Lock"
import More from "@react-spectrum/s2/icons/More"
import Undo from "@react-spectrum/s2/icons/Undo"
import { Menu, MenuItem, MenuTrigger } from "@react-spectrum/s2/Menu"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import {
  type ComponentRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { type Inventory, type Policy, request, type Snapshot } from "./api.js"
import { getLocale, t } from "./i18n.js"
import { McpGuidedEditor, mcpChangePreview, mcpSavePatch } from "./mcp-editor.js"
import { McpReferenceEditor } from "./mcp-reference-editor.js"
import { focusEditor, type PendingEditor } from "./navigation.js"
import { SecretFields } from "./policy-editors.js"
import { SectionActive } from "./sections.js"
import { countText } from "./status-text.js"
import { Disclosure, Panel, Prose, StatusLabel, TableToolbar } from "./surfaces.js"

const layoutTokens = style({
  "--mcp-divider": { type: "borderColor", value: "gray-300" },
  "--mcp-muted": { type: "color", value: "neutral-subdued" },
})
const heading = style({ font: "heading-xs", color: "title" })
const headingRow = style({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "start",
  flexWrap: "wrap",
  gap: 8,
})
const factContent = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "start",
  gap: 8,
})
const body = style({ font: "body-lg", color: "body" })
const muted = style({ font: "body", color: "neutral-subdued" })
const code = style({ font: "code", color: "code" })
const codeField = style({
  font: "code",
  color: "body",
  backgroundColor: "layer-2",
  borderColor: "gray-500",
  borderWidth: 1,
  borderStyle: "solid",
  borderRadius: "default",
  padding: 8,
  width: "full",
  boxSizing: "border-box",
  resize: "vertical",
})

function connectionActionsId(name: string) {
  return `connection-actions-${encodeURIComponent(name)}`
}

type Props = {
  inventory: Inventory
  policy: Policy
  snapshot: Snapshot
  csrf: string
  busy: boolean
  dirty: boolean
  localPending: boolean
  mcpDirty: boolean
  secretPending: boolean
  setMcpDirty(value: boolean): void
  markPending(key: PendingEditor, value: boolean): void
  onTools(): void
  run(action: () => Promise<void>): Promise<void>
  load(): Promise<void>
}

export function mcpObservationView(server: Inventory["mcp"][number], revision: number) {
  const observed = server.observation
  const observation =
    observed && observed.state !== "untested" && observed.revision !== revision
      ? { state: "untested" as const }
      : observed
  const label = observation
    ? {
        untested: t("mcp.notTested"),
        checking: t("mcp.checking"),
        succeeded: t("mcp.succeeded"),
        failed: t("mcp.failed"),
      }[observation.state]
    : t("settings.unknownTitle")
  return {
    observation,
    label,
    succeeded: observation?.state === "succeeded",
    count:
      observation?.state === "succeeded"
        ? countText(server.tools.length, "published tool name")
        : t("mcp.publishedUnknown"),
  }
}

export function McpConnections({
  inventory,
  policy,
  snapshot,
  csrf,
  busy,
  dirty,
  localPending,
  mcpDirty,
  secretPending,
  setMcpDirty,
  markPending,
  onTools,
  run,
  load,
}: Props) {
  const active = useContext(SectionActive)
  const [deleting, setDeleting] = useState<string>()
  const deleteDescription = useId()
  const restoreDeleteFocus = useCallback(
    (dialog: ComponentRef<typeof AlertDialog> | null) => {
      if (dialog || deleting === undefined) return
      // The menu item is gone when the dialog closes. Return focus to its trigger.
      requestAnimationFrame(() => {
        const trigger = document.getElementById(connectionActionsId(deleting))
        if (
          document.activeElement === document.body &&
          trigger instanceof HTMLButtonElement &&
          !trigger.disabled &&
          !trigger.closest("[hidden], [inert]") &&
          trigger.checkVisibility()
        ) {
          trigger.focus()
        }
      })
    },
    [deleting],
  )
  const [checking, setChecking] = useState<{ name: string; startedAt: number }>()
  const [unknown, setUnknown] = useState<Map<string, Inventory>>(() => new Map())
  useEffect(() => {
    if (!active) setDeleting(undefined)
  }, [active])
  const [mcpName, setMcpName] = useState("")
  const [editing, setEditing] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const focusAdd = useRef(false)
  const editorFrame = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!active) focusAdd.current = false
    return () => {
      focusAdd.current = false
      if (editorFrame.current !== undefined) cancelAnimationFrame(editorFrame.current)
      editorFrame.current = undefined
    }
  }, [active])
  useEffect(() => {
    if (!active || busy || editorOpen || !focusAdd.current) return
    focusAdd.current = false
    const add = document.getElementById("mcp-add")
    if (add instanceof HTMLButtonElement && !add.disabled && add.checkVisibility()) add.focus()
  }, [active, busy, editorOpen])
  const requestEditorFocus = (selector: string) => {
    if (editorFrame.current !== undefined) cancelAnimationFrame(editorFrame.current)
    if (!active) return
    editorFrame.current = requestAnimationFrame(() => {
      editorFrame.current = undefined
      focusEditor(selector)
    })
  }
  const [mcpSecrets, setMcpSecrets] = useState<{
    env: Record<string, string>
    headers: Record<string, string>
  }>({ env: {}, headers: {} })
  const [mcpConfig, setMcpConfig] = useState(
    '{\n  "command": "",\n  "args": [],\n  "enabled": true,\n  "exposure": "codemode"\n}',
  )
  const [mcpEditorVersion, setMcpEditorVersion] = useState(0)
  const startEditor = (name = "") => {
    if ((mcpDirty || secretPending) && !window.confirm(t("mcp.discardSwitch"))) return
    setMcpName(name)
    setMcpConfig(
      name ? "{}" : '{ "command": "", "args": [], "enabled": true, "exposure": "codemode" }',
    )
    setMcpSecrets({ env: {}, headers: {} })
    markPending("secret", false)
    setMcpEditorVersion((version) => version + 1)
    setMcpDirty(false)
    setEditing(true)
    setEditorOpen(true)
    requestEditorFocus("#mcp-name")
  }
  let mcpPreview: string[] = []
  let mcpValidation = ""
  try {
    const previous = inventory.mcp.find((m) => m.name === mcpName)
    mcpPreview = mcpChangePreview(mcpSavePatch(mcpConfig, previous, mcpSecrets), previous)
  } catch (error) {
    mcpValidation = error instanceof Error ? error.message : t("mcp.invalidConfig")
  }
  return (
    <div className={`page-content settings-stack ${layoutTokens}`}>
      <TableToolbar hidden={editorOpen}>
        <Button id="mcp-add" variant="accent" isDisabled={busy} onPress={() => startEditor()}>
          {t("mcp.addConnection")}
        </Button>
        {editing && !editorOpen && (
          <Button
            id="mcp-resume"
            variant="secondary"
            onPress={() => {
              setEditorOpen(true)
              requestEditorFocus("#mcp-name")
            }}
          >
            {t("mcp.resumeDraft")}
          </Button>
        )}
        <Button variant="secondary" onPress={onTools}>
          {t("mcp.managePermissions")}
        </Button>
      </TableToolbar>
      <div className="mcp-workspace mcp-list-only">
        <Panel className="mcp-step mcp-chooser" hidden={editorOpen}>
          <h2 className={`section-heading ${heading}`}>{t("mcp.savedConnections")}</h2>
          {!inventory.mcp.length && (
            <div className="empty-state">
              <Prose>{t("mcp.emptyConnections")}</Prose>
            </div>
          )}
          <div className="mcp-choice-grid">
            <div className="mcp-saved-list">
              {inventory.mcp.map((m) => {
                const view = mcpObservationView(
                  checking?.name === m.name
                    ? {
                        ...m,
                        observation: {
                          state: "checking",
                          revision: snapshot.revision,
                          startedAt: checking.startedAt,
                        },
                      }
                    : unknown.get(m.name) === inventory
                      ? { ...m, observation: undefined }
                      : m,
                  snapshot.revision,
                )
                return (
                  <Panel
                    key={m.name}
                    className="mcp-connection-summary"
                    aria-label={t("mcp.connectionName", { name: m.name })}
                  >
                    <div className="mcp-connection-row">
                      <div className={headingRow}>
                        <h3 className={heading}>{m.name}</h3>
                        {mcpName === m.name && (
                          <Badge variant="informative" fillStyle="outline">
                            {t("settings.editing")}
                          </Badge>
                        )}
                      </div>
                      <div className="mcp-summary-state">
                        <StatusLabel>
                          {m.enabled === false ? t("settings.disabled") : t("settings.enabled")}
                        </StatusLabel>
                        <StatusLabel>{t("mcp.testStatus", { status: view.label })}</StatusLabel>
                        <span className={body}>{view.count}</span>
                      </div>
                      <div className="mcp-summary-actions">
                        <Button
                          variant="accent"
                          aria-label={t("mcp.testName", { name: m.name })}
                          isDisabled={
                            busy ||
                            m.enabled === false ||
                            view.observation?.state === "checking" ||
                            dirty ||
                            localPending ||
                            snapshot.status !== "applied" ||
                            snapshot.revision !== snapshot.applied
                          }
                          onPress={() =>
                            void run(async () => {
                              setChecking({ name: m.name, startedAt: Date.now() })
                              try {
                                await request(`mcp/${encodeURIComponent(m.name)}/discover`, csrf)
                                await load()
                              } catch (error) {
                                setUnknown((previous) => new Map(previous).set(m.name, inventory))
                                throw error
                              } finally {
                                setChecking(undefined)
                              }
                            })
                          }
                        >
                          {t("mcp.testDiscover")}
                        </Button>
                        <Button
                          variant="secondary"
                          aria-label={t("mcp.editFieldsName", { name: m.name })}
                          isDisabled={busy}
                          onPress={() => startEditor(m.name)}
                        >
                          <Edit aria-hidden="true" />
                          {t("settings.edit")}
                        </Button>
                        <MenuTrigger align="end">
                          <ActionButton
                            id={connectionActionsId(m.name)}
                            isQuiet
                            aria-label={t("mcp.actionsName", { name: m.name })}
                            isDisabled={busy}
                          >
                            <More aria-hidden="true" />
                          </ActionButton>
                          <Menu>
                            <MenuItem
                              textValue={t("settings.deleteName", { name: m.name })}
                              isDisabled={busy || dirty || localPending}
                              onAction={() => setDeleting(m.name)}
                            >
                              <Delete slot="icon" aria-hidden="true" />
                              {t("settings.deleteName", { name: m.name })}
                            </MenuItem>
                          </Menu>
                        </MenuTrigger>
                      </div>
                    </div>
                    <Disclosure title={t("mcp.details")}>
                      {view.observation && view.observation.state !== "untested" && (
                        <Prose size="2">
                          <time
                            dateTime={new Date(
                              view.observation.state === "checking"
                                ? view.observation.startedAt
                                : view.observation.completedAt,
                            ).toISOString()}
                          >
                            {t(
                              view.observation.state === "checking"
                                ? "mcp.observationStarted"
                                : "mcp.observationCompleted",
                              {
                                date: new Date(
                                  view.observation.state === "checking"
                                    ? view.observation.startedAt
                                    : view.observation.completedAt,
                                ).toLocaleString(getLocale()),
                                revision: view.observation.revision,
                              },
                            )}
                          </time>
                          {view.observation.state === "failed" && ` · ${view.observation.reason}`}
                        </Prose>
                      )}
                      <dl className="mcp-summary-facts data-list">
                        <div className="data-row">
                          <dt>{t("mcp.exposure")}</dt>
                          <dd>
                            <code className={code}>{m.exposure ?? "codemode"}</code>
                          </dd>
                        </div>
                        <div className="data-row">
                          <dt>{t("mcp.execution")}</dt>
                          <dd className={factContent}>
                            <StatusLabel
                              tone={policy.servers.includes(m.name) ? "success" : "neutral"}
                            >
                              {policy.servers.includes(m.name)
                                ? t("mcp.globallyAvailable")
                                : t("mcp.notGloballyAvailable")}
                            </StatusLabel>
                            <span className={muted}>
                              {view.succeeded
                                ? countText(
                                    m.tools.filter((name) => policy.tools.includes(name)).length,
                                    "globally approved published tool name",
                                  )
                                : t("mcp.approvedUnknown")}{" "}
                              · {dirty ? t("mcp.policyDraft") : t("mcp.savedPolicy")}
                            </span>
                            <span className={body}>
                              {t("mcp.gateSummary", {
                                state:
                                  policy.defaults.servers === null
                                    ? t("mcp.inheritsGlobal")
                                    : policy.defaults.servers.includes(m.name)
                                      ? t("mcp.selected")
                                      : t("mcp.notSelected"),
                              })}
                            </span>
                          </dd>
                        </div>
                      </dl>
                      <details className="mcp-disclosure">
                        <summary>{t("mcp.publishedNames")}</summary>
                        <div className={`mcp-published-names ${factContent}`}>
                          {view.succeeded && m.tools.length ? (
                            m.tools.map((name) => (
                              <code className={code} key={name}>
                                {name}
                              </code>
                            ))
                          ) : (
                            <span className={muted}>
                              {view.succeeded ? t("mcp.noPublishedNames") : t("mcp.runDiscovery")}
                            </span>
                          )}
                        </div>
                      </details>
                      <Prose size="2">{t("mcp.resultHelp")}</Prose>
                      <Prose size="2">
                        {t("mcp.secretFields", {
                          fields:
                            [...Object.keys(m.env), ...Object.keys(m.headers)].join(", ") ||
                            t("settings.none"),
                        })}
                      </Prose>
                    </Disclosure>
                  </Panel>
                )
              })}
            </div>
          </div>
        </Panel>
        <details
          hidden={!editing}
          open={editorOpen}
          onToggle={(event) => setEditorOpen(event.currentTarget.open)}
          className="settings-stack mcp-editor-column"
        >
          <summary className="mcp-editor-summary">{t("mcp.editor")}</summary>
          <div className={`mcp-editor-heading ${headingRow}`}>
            <h2 className={style({ font: "heading-sm", color: "title" })}>
              {inventory.mcp.some((server) => server.name === mcpName)
                ? t("mcp.editConnection")
                : t("mcp.addConnection")}
            </h2>
            <Button
              variant="secondary"
              onPress={() => {
                setEditorOpen(false)
                requestEditorFocus("#mcp-resume")
              }}
            >
              {t("mcp.closeEditor")}
            </Button>
          </div>
          <div className="mcp-server-name">
            <TextField
              id="mcp-name"
              label={t("mcp.serverName")}
              UNSAFE_className="form-field"
              styles={style({ width: "full" })}
              autoComplete="off"
              value={mcpName}
              onChange={(name) => {
                if (
                  (Object.keys(mcpSecrets.env).length ||
                    Object.keys(mcpSecrets.headers).length ||
                    secretPending) &&
                  !window.confirm(t("mcp.renameConfirm"))
                )
                  return
                markPending("secret", false)
                setMcpDirty(true)
                setMcpName(name)
                setMcpEditorVersion((version) => version + 1)
                setMcpSecrets({ env: {}, headers: {} })
              }}
            />
          </div>

          <Panel className="mcp-step">
            <McpGuidedEditor
              existing={inventory.mcp.some((server) => server.name === mcpName)}
              savedTransport={
                inventory.mcp.find((server) => server.name === mcpName)?.fields?.includes("url")
                  ? "http"
                  : inventory.mcp
                        .find((server) => server.name === mcpName)
                        ?.fields?.includes("command")
                    ? "stdio"
                    : undefined
              }
              text={mcpConfig}
              onChange={(text) => {
                setMcpConfig(text)
                setMcpDirty(true)
              }}
            />
            <details className="mcp-disclosure">
              <summary>{t("mcp.referencesRecommended")}</summary>
              <McpReferenceEditor
                key={mcpEditorVersion}
                run={run}
                onPending={(value) => markPending("mcpReference", value)}
                onAdd={({ scope, name, value }) => {
                  setMcpDirty(true)
                  setMcpSecrets((previous) => ({
                    ...previous,
                    [scope]: { ...previous[scope], [name]: value },
                  }))
                }}
              />
            </details>
            <details className="mcp-secret-editor mcp-disclosure">
              <summary>{t("mcp.secretsOptional")}</summary>
              <SecretFields
                key={mcpEditorVersion}
                onPending={(v) => markPending("secret", v)}
                onChange={({ scope, name, value }) => {
                  setMcpDirty(true)
                  setMcpSecrets({
                    ...mcpSecrets,
                    [scope]: { ...mcpSecrets[scope], [name]: value },
                  })
                }}
              />
            </details>
            {(Object.keys(mcpSecrets.env).length > 0 ||
              Object.keys(mcpSecrets.headers).length > 0) && (
              <Prose size="2" color="gray">
                <Lock aria-hidden="true" />{" "}
                {t("mcp.pendingSecrets", {
                  fields: [...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(
                    ", ",
                  ),
                })}
              </Prose>
            )}
            {mcpValidation && (
              <InlineAlert variant="negative">
                <Content>{mcpValidation}</Content>
              </InlineAlert>
            )}
            {(dirty || localPending || !mcpName) && (
              <Prose size="2">
                {t("mcp.saveUnavailable", {
                  reason: dirty
                    ? t("mcp.savePolicyFirst")
                    : localPending
                      ? t("mcp.finishInputFirst")
                      : t("mcp.nameRequired"),
                })}
              </Prose>
            )}
            <div className="mcp-review-footer">
              <Button
                variant="accent"
                isDisabled={busy || dirty || localPending || !mcpName || Boolean(mcpValidation)}
                onPress={() =>
                  void run(async () => {
                    await request(
                      `mcp/${encodeURIComponent(mcpName)}`,
                      csrf,
                      {
                        revision: snapshot.revision,
                        config: (() => {
                          return mcpSavePatch(
                            mcpConfig,
                            inventory.mcp.find((m) => m.name === mcpName),
                            mcpSecrets,
                          )
                        })(),
                      },
                      "PUT",
                    )
                    await load()
                    setMcpConfig("{}")
                    setMcpSecrets({ env: {}, headers: {} })
                    setMcpDirty(false)
                    setEditing(false)
                    setEditorOpen(false)
                    setMcpEditorVersion((version) => version + 1)
                    focusAdd.current = true
                  })
                }
              >
                <Checkmark aria-hidden="true" />
                {t("mcp.saveConnection")}
              </Button>
              {(mcpDirty || secretPending) && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    if (window.confirm(t("mcp.discardConfirm"))) {
                      setEditing(false)
                      setEditorOpen(false)
                      setMcpName("")
                      setMcpConfig("{}")
                      setMcpSecrets({ env: {}, headers: {} })
                      setMcpDirty(false)
                      setMcpEditorVersion((version) => version + 1)
                      markPending("secret", false)
                      if (editorFrame.current !== undefined)
                        cancelAnimationFrame(editorFrame.current)
                      editorFrame.current = undefined
                      focusAdd.current = active
                    }
                  }}
                >
                  <Undo aria-hidden="true" />
                  {t("mcp.discardDraft")}
                </Button>
              )}
            </div>
            <Prose size="2" color="gray">
              {t("mcp.savePermissionHelp")}
            </Prose>
            <details className="mcp-disclosure">
              <summary>{t("mcp.reviewChanges")}</summary>
              <section aria-label={t("mcp.changePreview")}>
                <Prose size="2">{t("mcp.namesOnly")}</Prose>
                <ul className="mcp-review-operations">
                  {mcpPreview.map((line) => (
                    <li key={line}>
                      <code className={code}>{line}</code>
                    </li>
                  ))}
                </ul>
              </section>
            </details>
            <details className="provider-advanced mcp-disclosure">
              <summary>{t("mcp.advancedJson")}</summary>
              <label htmlFor="mcp-config">
                {t("mcp.configJson")}
                <textarea
                  id="mcp-config"
                  className={codeField}
                  value={mcpConfig}
                  onChange={(e) => {
                    setMcpDirty(true)
                    setMcpConfig(e.target.value)
                  }}
                  rows={12}
                />
              </label>
            </details>

            <details className="mcp-disclosure">
              <summary>{t("mcp.transportRules")}</summary>
              <Prose>{t("mcp.transportRulesHelp")}</Prose>
            </details>

            <details className="mcp-disclosure">
              <summary>{t("mcp.rename")}</summary>
              <Prose size="2">{t("mcp.renameHelp")}</Prose>
            </details>
          </Panel>
        </details>
      </div>
      <details className="mcp-disclosure">
        <summary>{t("mcp.discoveryRules")}</summary>
        <p
          className={style({
            display: "flex",
            alignItems: "start",
            gap: 8,
            padding: 12,
            borderRadius: "default",
            backgroundColor: "informative-subtle",
            font: "body-lg",
            color: "body",
          })}
        >
          <InfoCircle aria-hidden="true" />
          {t("mcp.discoveryRulesHelp")}
        </p>
      </details>
      <DialogContainer onDismiss={() => setDeleting(undefined)}>
        {active &&
          deleting !== undefined &&
          inventory.mcp.some((server) => server.name === deleting) && (
            <AlertDialog
              ref={restoreDeleteFocus}
              variant="destructive"
              title={t("mcp.deleteServerConfirm", { name: deleting })}
              aria-describedby={deleteDescription}
              cancelLabel={t("settings.cancel")}
              primaryActionLabel={t("mcp.deleteApply")}
              autoFocusButton="cancel"
              onPrimaryAction={() =>
                void run(async () => {
                  await request(
                    `mcp/${encodeURIComponent(deleting)}`,
                    csrf,
                    { revision: snapshot.revision },
                    "DELETE",
                  )
                  if (mcpName === deleting) {
                    setEditing(false)
                    setEditorOpen(false)
                    setMcpEditorVersion((version) => version + 1)
                    setMcpName("")
                    setMcpConfig("{}")
                    setMcpSecrets({ env: {}, headers: {} })
                    setMcpDirty(false)
                  }
                  await load()
                })
              }
            >
              <p id={deleteDescription}>{t("mcp.deleteHelp")}</p>
            </AlertDialog>
          )}
      </DialogContainer>
    </div>
  )
}
