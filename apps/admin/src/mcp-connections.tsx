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
import { McpGuidedEditor, mcpChangePreview, mcpSavePatch } from "./mcp-editor.js"
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
    if (
      (mcpDirty || secretPending) &&
      !window.confirm("Discard the current MCP draft and edit this server?")
    )
      return
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
    mcpValidation = error instanceof Error ? error.message : "Invalid configuration"
  }
  return (
    <Box className="page-content settings-stack">
      <TableToolbar hidden={editorOpen}>
        <Button id="mcp-add" disabled={busy} onClick={() => startEditor()}>
          Add connection
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
            Resume connection draft
          </Button>
        )}
        <Button variant="soft" onClick={onTools}>
          Manage tool and MCP server permissions
        </Button>
      </TableToolbar>
      <Box className="mcp-workspace mcp-list-only">
        <Panel className="mcp-step mcp-chooser" hidden={editorOpen}>
          <Heading as="h2" size="3" className="section-heading">
            Saved connections
          </Heading>
          {!inventory.mcp.length && (
            <Box className="empty-state">
              <Prose>
                No connections configured. Select Add connection, then test it and approve its tools
                separately.
              </Prose>
            </Box>
          )}
          <div className="mcp-choice-grid">
            <div className="mcp-saved-list">
              {inventory.mcp.map((m) => (
                <Panel
                  key={m.name}
                  className="mcp-connection-summary"
                  aria-label={`${m.name} connection`}
                >
                  <Flex justify="between" align="start" gap="2" wrap="wrap">
                    <Heading as="h3" size="3">
                      {m.name}
                    </Heading>
                    {mcpName === m.name && (
                      <Badge color="blue" variant="outline">
                        Editing
                      </Badge>
                    )}
                  </Flex>
                  <Flex gap="2" wrap="wrap" className="mcp-summary-state">
                    <StatusLabel>{m.enabled === false ? "Disabled" : "Enabled"}</StatusLabel>
                    <StatusLabel>Connection test: {m.connection}</StatusLabel>
                    <Text size="2">{countText(m.tools.length, "discovered tool")}</Text>
                  </Flex>
                  <Flex className="mcp-summary-actions" gap="2" wrap="wrap">
                    <Button
                      variant="solid"
                      disabled={busy || dirty || localPending}
                      onClick={() =>
                        void run(async () => {
                          await request(`mcp/${encodeURIComponent(m.name)}/discover`, csrf)
                          await load()
                        })
                      }
                    >
                      Test and discover {m.name}
                    </Button>
                    <Button variant="soft" disabled={busy} onClick={() => startEditor(m.name)}>
                      <Pencil2Icon aria-hidden="true" />
                      Edit fields for {m.name}
                    </Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        <Button
                          id={`connection-actions-${encodeURIComponent(m.name)}`}
                          variant="ghost"
                          aria-label={`Actions for ${m.name}`}
                          disabled={busy}
                        >
                          <DotsHorizontalIcon aria-hidden />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item
                          color="red"
                          disabled={busy || dirty || localPending}
                          onSelect={() => setDeleting(m.name)}
                        >
                          <TrashIcon aria-hidden /> Delete {m.name}
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
                        <AlertDialog.Title>Delete MCP server {m.name}?</AlertDialog.Title>
                        <AlertDialog.Description>
                          This deletes its configuration and stored secrets. Remove it from global,
                          default, and chat selections first. Application cancels active work and
                          retains transcripts.
                        </AlertDialog.Description>
                        <Flex gap="3" justify="end" mt="4">
                          <AlertDialog.Cancel>
                            <Button variant="soft">Cancel</Button>
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
                              Delete server and apply
                            </Button>
                          </AlertDialog.Action>
                        </Flex>
                      </AlertDialog.Content>
                    </AlertDialog.Root>
                  </Flex>
                  <Disclosure title="Connection and permission details">
                    <DataList.Root size="1" className="mcp-summary-facts data-list">
                      <DataList.Item className="data-row">
                        <DataList.Label minWidth="80px">Exposure</DataList.Label>
                        <DataList.Value>
                          <Code>{m.exposure ?? "codemode"}</Code>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item className="data-row">
                        <DataList.Label minWidth="80px">Execution</DataList.Label>
                        <DataList.Value>
                          <Flex direction="column" align="start" gap="2">
                            <Badge color={policy.servers.includes(m.name) ? "green" : "gray"}>
                              {policy.servers.includes(m.name)
                                ? "Globally available"
                                : "Not globally available"}
                            </Badge>
                            <Text size="1" color="gray">
                              {countText(
                                m.tools.filter((name) => policy.tools.includes(name)).length,
                                "globally approved tool name",
                              )}{" "}
                              in the {dirty ? "policy draft" : "saved policy"}
                            </Text>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                    </DataList.Root>
                  </Disclosure>
                  <details className="mcp-disclosure">
                    <summary>Discovered tool names</summary>
                    <Flex direction="column" align="start" gap="2" mt="3">
                      {m.tools.length ? (
                        m.tools.map((name) => <Code key={name}>{name}</Code>)
                      ) : (
                        <Text size="2" color="gray">
                          No tools discovered.
                        </Text>
                      )}
                    </Flex>
                  </details>
                  <Prose size="2">
                    Secret fields:{" "}
                    {[...Object.keys(m.env), ...Object.keys(m.headers)].join(", ") || "none"}
                  </Prose>
                </Panel>
              ))}
            </div>
          </div>
        </Panel>
        <details
          hidden={!editing}
          open={editorOpen}
          onToggle={(event) => setEditorOpen(event.currentTarget.open)}
          className="settings-stack mcp-editor-column"
        >
          <summary className="mcp-editor-summary">Connection editor</summary>
          <Flex justify="between" align="center" gap="3" wrap="wrap">
            <Heading as="h2" size="4">
              {inventory.mcp.some((server) => server.name === mcpName)
                ? "Edit connection"
                : "Add connection"}
            </Heading>
            <Button
              variant="soft"
              onClick={() => {
                setEditorOpen(false)
                requestEditorFocus("#mcp-resume")
              }}
            >
              Close connection editor
            </Button>
          </Flex>
          <div className="mcp-server-name">
            <Field
              id="mcp-name"
              label="MCP server name"
              value={mcpName}
              onChange={(name) => {
                if (
                  (Object.keys(mcpSecrets.env).length ||
                    Object.keys(mcpSecrets.headers).length ||
                    secretPending) &&
                  !window.confirm(
                    "Changing the server name discards staged secret replacements. Continue?",
                  )
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
            <details className="mcp-secret-editor mcp-disclosure">
              <summary>Secrets (optional)</summary>
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
                <LockClosedIcon aria-hidden="true" /> Pending secret fields:{" "}
                {[...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(", ")}.
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
                MCP save unavailable:{" "}
                {dirty
                  ? "save or discard policy edits first."
                  : localPending
                    ? "finish or clear unstaged input first."
                    : "enter a server name."}
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
                Save connection
              </Button>
              {(mcpDirty || secretPending) && (
                <Button
                  variant="soft"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Discard pending MCP configuration and secrets?")) {
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
                  Discard MCP draft
                </Button>
              )}
            </Flex>
            <Prose size="2" color="gray">
              Saving a connection does not approve its tools.
            </Prose>
            <details className="mcp-disclosure">
              <summary>Review field changes</summary>
              <section aria-label="MCP change preview">
                <Prose size="2">Only field names are shown. Saved values are never returned.</Prose>
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
              <summary>Advanced server configuration JSON</summary>
              <label htmlFor="mcp-config">
                Server configuration JSON
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
              <summary>Secret preservation and transport rules</summary>
              <Prose>
                Omit env or headers to preserve that map. A map in JSON replaces the whole map:
                include every key to retain with null. Omitted keys are removed. An empty object
                clears the map. Masked replacements preserve existing keys when JSON omits that map.
                Do not put secrets in commands, arguments, descriptions, or URLs. Selecting an HTTP
                URL removes command, arguments, working directory, and environment fields. Selecting
                a stdio command removes URL and header fields. For a command-only update, an omitted
                transport type is cleared and inferred again.
              </Prose>
            </details>

            <details className="mcp-disclosure">
              <summary>Changing a connection name</summary>
              <Prose size="2">
                A new name creates a connection. The configuration patch is kept. Changing the name
                requires confirmation before secret replacements are removed.
              </Prose>
            </details>
          </Panel>
        </details>
      </Box>
      <details className="mcp-disclosure">
        <summary>Connection permissions and discovery</summary>
        <Callout.Root size="2" color="blue">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text>
            Connection configuration and enabled state do not grant execution permission. First
            discovery adds new tools to global and default permissions, but does not open server
            gates. Connection tests run only when requested.
          </Callout.Text>
        </Callout.Root>
      </details>
    </Box>
  )
}
