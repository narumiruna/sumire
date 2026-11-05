import {
  CheckIcon,
  DotsHorizontalIcon,
  InfoCircledIcon,
  LockClosedIcon,
  Pencil2Icon,
  ResetIcon,
  TrashIcon,
} from "@radix-ui/react-icons"
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  DataList,
  DropdownMenu,
  Flex,
  Heading,
  Text,
  TextArea,
} from "@radix-ui/themes"
import { useContext, useEffect, useRef, useState } from "react"
import { type Inventory, type Policy, request, type Snapshot } from "./api.js"
import { getLocale, t } from "./i18n.js"
import { McpGuidedEditor, mcpChangePreview, mcpSavePatch } from "./mcp-editor.js"
import { McpReferenceEditor } from "./mcp-reference-editor.js"
import { focusEditor, type PendingEditor } from "./navigation.js"
import { Field, SecretFields } from "./policy-editors.js"
import { SectionActive } from "./sections.js"
import { countText } from "./status-text.js"
import { Disclosure, Panel, Prose, StatusLabel, TableToolbar } from "./surfaces.js"

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
    <Box className="page-content settings-stack">
      <TableToolbar hidden={editorOpen}>
        <Button id="mcp-add" disabled={busy} onClick={() => startEditor()}>
          {t("mcp.addConnection")}
        </Button>
        {editing && !editorOpen && (
          <Button
            id="mcp-resume"
            variant="soft"
            onClick={() => {
              setEditorOpen(true)
              requestEditorFocus("#mcp-name")
            }}
          >
            {t("mcp.resumeDraft")}
          </Button>
        )}
        <Button variant="soft" onClick={onTools}>
          {t("mcp.managePermissions")}
        </Button>
      </TableToolbar>
      <Box className="mcp-workspace mcp-list-only">
        <Panel className="mcp-step mcp-chooser" hidden={editorOpen}>
          <Heading as="h2" size="3" className="section-heading">
            {t("mcp.savedConnections")}
          </Heading>
          {!inventory.mcp.length && (
            <Box className="empty-state">
              <Prose>{t("mcp.emptyConnections")}</Prose>
            </Box>
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
                      <Flex justify="between" align="start" gap="2" wrap="wrap">
                        <Heading as="h3" size="3">
                          {m.name}
                        </Heading>
                        {mcpName === m.name && (
                          <Badge color="blue" variant="outline">
                            {t("settings.editing")}
                          </Badge>
                        )}
                      </Flex>
                      <Flex gap="2" wrap="wrap" className="mcp-summary-state">
                        <StatusLabel>
                          {m.enabled === false ? t("settings.disabled") : t("settings.enabled")}
                        </StatusLabel>
                        <StatusLabel>{t("mcp.testStatus", { status: view.label })}</StatusLabel>
                        <Text size="2">{view.count}</Text>
                      </Flex>
                      <Flex className="mcp-summary-actions" gap="2" wrap="wrap">
                        <Button
                          variant="solid"
                          aria-label={t("mcp.testName", { name: m.name })}
                          disabled={
                            busy ||
                            m.enabled === false ||
                            view.observation?.state === "checking" ||
                            dirty ||
                            localPending ||
                            snapshot.status !== "applied" ||
                            snapshot.revision !== snapshot.applied
                          }
                          onClick={() =>
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
                          variant="soft"
                          aria-label={t("mcp.editFieldsName", { name: m.name })}
                          disabled={busy}
                          onClick={() => startEditor(m.name)}
                        >
                          <Pencil2Icon aria-hidden="true" />
                          {t("settings.edit")}
                        </Button>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            <Button
                              id={`connection-actions-${encodeURIComponent(m.name)}`}
                              variant="ghost"
                              aria-label={t("mcp.actionsName", { name: m.name })}
                              disabled={busy}
                            >
                              <DotsHorizontalIcon aria-hidden />
                            </Button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content align="end">
                            <DropdownMenu.Item
                              color="red"
                              aria-label={t("settings.deleteName", { name: m.name })}
                              disabled={busy || dirty || localPending}
                              onSelect={() => setDeleting(m.name)}
                            >
                              <TrashIcon aria-hidden /> {t("settings.delete")}
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                        <AlertDialog.Root
                          open={active && deleting === m.name}
                          onOpenChange={(open) => {
                            if (!open) setDeleting(undefined)
                          }}
                        >
                          <AlertDialog.Content
                            onCloseAutoFocus={(event) => {
                              event.preventDefault()
                              document
                                .getElementById(`connection-actions-${encodeURIComponent(m.name)}`)
                                ?.focus()
                            }}
                          >
                            <AlertDialog.Title>
                              {t("mcp.deleteServerConfirm", { name: m.name })}
                            </AlertDialog.Title>
                            <AlertDialog.Description>{t("mcp.deleteHelp")}</AlertDialog.Description>
                            <Flex gap="3" justify="end" mt="4">
                              <AlertDialog.Cancel>
                                <Button variant="soft">{t("settings.cancel")}</Button>
                              </AlertDialog.Cancel>
                              <AlertDialog.Action>
                                <Button
                                  color="red"
                                  onClick={() =>
                                    void run(async () => {
                                      await request(
                                        `mcp/${encodeURIComponent(m.name)}`,
                                        csrf,
                                        { revision: snapshot.revision },
                                        "DELETE",
                                      )
                                      if (mcpName === m.name) {
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
                                  {t("mcp.deleteApply")}
                                </Button>
                              </AlertDialog.Action>
                            </Flex>
                          </AlertDialog.Content>
                        </AlertDialog.Root>
                      </Flex>
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
                      <DataList.Root size="1" className="mcp-summary-facts data-list">
                        <DataList.Item className="data-row">
                          <DataList.Label minWidth="80px">{t("mcp.exposure")}</DataList.Label>
                          <DataList.Value>
                            <Code>{m.exposure ?? "codemode"}</Code>
                          </DataList.Value>
                        </DataList.Item>
                        <DataList.Item className="data-row">
                          <DataList.Label minWidth="80px">{t("mcp.execution")}</DataList.Label>
                          <DataList.Value>
                            <Flex direction="column" align="start" gap="2">
                              <Badge color={policy.servers.includes(m.name) ? "green" : "gray"}>
                                {policy.servers.includes(m.name)
                                  ? t("mcp.globallyAvailable")
                                  : t("mcp.notGloballyAvailable")}
                              </Badge>
                              <Text size="1" color="gray">
                                {view.succeeded
                                  ? countText(
                                      m.tools.filter((name) => policy.tools.includes(name)).length,
                                      "globally approved published tool name",
                                    )
                                  : t("mcp.approvedUnknown")}{" "}
                                · {dirty ? t("mcp.policyDraft") : t("mcp.savedPolicy")}
                              </Text>
                              <Text size="2">
                                {t("mcp.gateSummary", {
                                  state:
                                    policy.defaults.servers === null
                                      ? t("mcp.inheritsGlobal")
                                      : policy.defaults.servers.includes(m.name)
                                        ? t("mcp.selected")
                                        : t("mcp.notSelected"),
                                })}
                              </Text>
                            </Flex>
                          </DataList.Value>
                        </DataList.Item>
                      </DataList.Root>
                      <details className="mcp-disclosure">
                        <summary>{t("mcp.publishedNames")}</summary>
                        <Flex direction="column" align="start" gap="2" mt="3">
                          {view.succeeded && m.tools.length ? (
                            m.tools.map((name) => <Code key={name}>{name}</Code>)
                          ) : (
                            <Text size="2" color="gray">
                              {view.succeeded ? t("mcp.noPublishedNames") : t("mcp.runDiscovery")}
                            </Text>
                          )}
                        </Flex>
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
          <Flex justify="between" align="center" gap="3" wrap="wrap">
            <Heading as="h2" size="4">
              {inventory.mcp.some((server) => server.name === mcpName)
                ? t("mcp.editConnection")
                : t("mcp.addConnection")}
            </Heading>
            <Button
              variant="soft"
              onClick={() => {
                setEditorOpen(false)
                requestEditorFocus("#mcp-resume")
              }}
            >
              {t("mcp.closeEditor")}
            </Button>
          </Flex>
          <div className="mcp-server-name">
            <Field
              id="mcp-name"
              label={t("mcp.serverName")}
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
                <LockClosedIcon aria-hidden="true" />{" "}
                {t("mcp.pendingSecrets", {
                  fields: [...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(
                    ", ",
                  ),
                })}
              </Prose>
            )}
            {mcpValidation && (
              <Callout.Root color="red" role="alert" size="1">
                <Callout.Icon>
                  <InfoCircledIcon />
                </Callout.Icon>
                <Callout.Text>{mcpValidation}</Callout.Text>
              </Callout.Root>
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
            <Flex className="mcp-review-footer" gap="3" wrap="wrap" mt="4">
              <Button
                disabled={busy || dirty || localPending || !mcpName || Boolean(mcpValidation)}
                onClick={() =>
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
                <CheckIcon aria-hidden="true" />
                {t("mcp.saveConnection")}
              </Button>
              {(mcpDirty || secretPending) && (
                <Button
                  variant="soft"
                  disabled={busy}
                  onClick={() => {
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
                  <ResetIcon aria-hidden="true" />
                  {t("mcp.discardDraft")}
                </Button>
              )}
            </Flex>
            <Prose size="2" color="gray">
              {t("mcp.savePermissionHelp")}
            </Prose>
            <details className="mcp-disclosure">
              <summary>{t("mcp.reviewChanges")}</summary>
              <section aria-label={t("mcp.changePreview")}>
                <Prose size="2">{t("mcp.namesOnly")}</Prose>
                <Box asChild className="mcp-review-operations">
                  <ul>
                    {mcpPreview.map((line) => (
                      <li key={line}>
                        <Text size="2">
                          <Code variant="ghost">{line}</Code>
                        </Text>
                      </li>
                    ))}
                  </ul>
                </Box>
              </section>
            </details>
            <details className="provider-advanced mcp-disclosure">
              <summary>{t("mcp.advancedJson")}</summary>
              <label htmlFor="mcp-config">
                {t("mcp.configJson")}
                <TextArea
                  id="mcp-config"
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
      </Box>
      <details className="mcp-disclosure">
        <summary>{t("mcp.discoveryRules")}</summary>
        <Callout.Root size="2" color="blue">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text>{t("mcp.discoveryRulesHelp")}</Callout.Text>
        </Callout.Root>
      </details>
    </Box>
  )
}
