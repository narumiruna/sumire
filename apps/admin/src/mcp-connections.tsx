import {
  CheckIcon,
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
  Flex,
  Heading,
  Text,
  TextArea,
} from "@radix-ui/themes"
import { useState } from "react"
import { type Inventory, type Policy, request, type Snapshot } from "./api.js"
import { McpGuidedEditor, mcpChangePreview, mcpSavePatch } from "./mcp-editor.js"
import { Field, SecretFields } from "./policy-editors.js"
import { countText } from "./status-text.js"
import { Panel, Prose } from "./surfaces.js"

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
  markPending(key: string, value: boolean): void
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
  const [mcpName, setMcpName] = useState("")
  const [mcpSecrets, setMcpSecrets] = useState<{
    env: Record<string, string>
    headers: Record<string, string>
  }>({ env: {}, headers: {} })
  const [mcpConfig, setMcpConfig] = useState(
    '{\n  "command": "",\n  "args": [],\n  "enabled": true,\n  "exposure": "codemode"\n}',
  )
  const [mcpEditorVersion, setMcpEditorVersion] = useState(0)
  let mcpPreview: string[] = []
  let mcpValidation = ""
  try {
    const previous = inventory.mcp.find((m) => m.name === mcpName)
    mcpPreview = mcpChangePreview(mcpSavePatch(mcpConfig, previous, mcpSecrets), previous)
  } catch (error) {
    mcpValidation = error instanceof Error ? error.message : "Invalid configuration"
  }
  return (
    <>
      <Flex className="page-header" gap="4" justify="between" align="start" wrap="wrap">
        <Box className="page-header__copy">
          <Heading size="4">MCP connections — saved separately</Heading>
          <Prose size="2" className="section-copy">
            Configure connections here. Review execution permissions separately.
          </Prose>
        </Box>
        <Flex className="page-header__actions">
          <Button variant="soft" onClick={() => onTools()}>
            Manage tool and MCP server permissions
          </Button>
        </Flex>
      </Flex>
      <Box className="page-content settings-stack">
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
        <Box className="settings-sidebar-layout mcp-workspace">
          <Panel className="mcp-step mcp-chooser">
            <Heading size="3" className="section-heading">
              1. Choose or create a server
            </Heading>
            {!inventory.mcp.length && (
              <Box className="empty-state">
                <Prose>
                  No MCP connections configured. Add a server below, then test it and approve its
                  tools separately.
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
                      <Heading size="3">{m.name}</Heading>
                      {mcpName === m.name && (
                        <Badge color="blue" variant="outline">
                          Editing
                        </Badge>
                      )}
                    </Flex>
                    <DataList.Root size="1" className="mcp-summary-facts data-list">
                      <DataList.Item className="data-row">
                        <DataList.Label minWidth="80px">Connection</DataList.Label>
                        <DataList.Value>
                          <Flex gap="2" wrap="wrap" className="mcp-summary-state">
                            <Badge color={m.enabled === false ? "gray" : "green"}>
                              {m.enabled === false ? "Disabled" : "Enabled"}
                            </Badge>
                            <Badge color="gray">Connection test: {m.connection}</Badge>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item className="data-row">
                        <DataList.Label minWidth="80px">Exposure</DataList.Label>
                        <DataList.Value>
                          <Code>{m.exposure ?? "codemode"}</Code>
                        </DataList.Value>
                      </DataList.Item>
                      <DataList.Item className="data-row">
                        <DataList.Label minWidth="80px">Discovery</DataList.Label>
                        <DataList.Value>
                          {countText(m.tools.length, "discovered tool")}
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
                              · {dirty ? "Policy draft" : "Saved policy"}
                            </Text>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                    </DataList.Root>
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
                    <Flex className="mcp-summary-actions" gap="2" wrap="wrap">
                      <Button
                        variant="soft"
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
                      <Button
                        variant="soft"
                        disabled={busy || dirty || localPending}
                        onClick={() => {
                          if (
                            mcpDirty &&
                            !window.confirm("Discard the current MCP draft and edit this server?")
                          )
                            return
                          setMcpName(m.name)
                          setMcpConfig("{}")
                          setMcpSecrets({ env: {}, headers: {} })
                          setMcpDirty(true)
                          document.getElementById("mcp-guided")?.focus()
                        }}
                      >
                        <Pencil2Icon aria-hidden="true" />
                        Edit fields for {m.name}
                      </Button>
                      <AlertDialog.Root>
                        <AlertDialog.Trigger>
                          <Button
                            color="red"
                            variant="ghost"
                            disabled={busy || dirty || localPending}
                          >
                            <TrashIcon aria-hidden="true" />
                            Delete {m.name}
                          </Button>
                        </AlertDialog.Trigger>
                        <AlertDialog.Content>
                          <AlertDialog.Title>Delete MCP server {m.name}?</AlertDialog.Title>
                          <AlertDialog.Description>
                            This deletes its configuration and stored secrets. Remove it from
                            global, default, and chat selections first. Application cancels active
                            work and retains transcripts.
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
                    <Prose size="2">
                      Secret fields:{" "}
                      {[...Object.keys(m.env), ...Object.keys(m.headers)].join(", ") || "none"}
                    </Prose>
                  </Panel>
                ))}
              </div>
              <div className="mcp-server-name">
                <Field
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
                    setMcpSecrets({ env: {}, headers: {} })
                  }}
                />
                <Prose size="2">
                  {inventory.mcp.some((m) => m.name === mcpName)
                    ? "Editing a saved server."
                    : "A new name creates a server when saved."}{" "}
                  Changing the name keeps the configuration patch. Staged secret replacements
                  require confirmation before removal.
                </Prose>
              </div>
            </div>
          </Panel>
          <Box className="settings-stack mcp-editor-column">
            <Panel className="mcp-step">
              <Heading size="3" className="section-heading">
                2. Edit connection fields
              </Heading>
              <Prose size="2" className="section-copy">
                Saved values stay hidden. Reload retains this draft; a failed request can still have
                saved changes. Defaults and chat selections can restrict these tools further.
              </Prose>
              <McpGuidedEditor
                text={mcpConfig}
                onChange={(text) => {
                  setMcpConfig(text)
                  setMcpDirty(true)
                }}
              />
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
              <details className="mcp-secret-editor mcp-disclosure">
                <summary>Replace secrets</summary>
                <SecretFields
                  key={`${mcpName}:${mcpEditorVersion}`}
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
              <Prose size="2" color="gray">
                <LockClosedIcon aria-hidden="true" /> Pending secret fields:{" "}
                {[...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(", ") ||
                  "none"}
                .
              </Prose>
              <details className="mcp-disclosure">
                <summary>Secret preservation and transport rules</summary>
                <Prose>
                  Omit env or headers to preserve that map. A map in JSON replaces the whole map:
                  include every key to retain with null. Omitted keys are removed. An empty object
                  clears the map. Masked replacements preserve existing keys when JSON omits that
                  map. Do not put secrets in commands, arguments, descriptions, or URLs. Selecting
                  an HTTP URL removes command, arguments, working directory, and environment fields.
                  Selecting a stdio command removes URL and header fields. For a command-only
                  update, an omitted transport type is cleared and inferred again.
                </Prose>
              </details>
            </Panel>
            <Panel className="mcp-step" aria-label="MCP change preview">
              <Heading size="3" className="section-heading">
                3. Review and save
              </Heading>
              <Prose size="2" className="section-copy">
                Field operations only; values are hidden. Transport changes remove fields that do
                not apply. The server validates this update before saving.
              </Prose>
              {mcpValidation ? (
                <Callout.Root color="red" role="alert" size="1">
                  <Callout.Icon>
                    <InfoCircledIcon />
                  </Callout.Icon>
                  <Callout.Text>{mcpValidation}</Callout.Text>
                </Callout.Root>
              ) : (
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
                      setMcpConfig("{}")
                      setMcpSecrets({ env: {}, headers: {} })
                      setMcpDirty(false)
                      await load()
                    })
                  }
                >
                  <CheckIcon aria-hidden="true" />
                  Save MCP configuration and apply
                </Button>
                {(mcpDirty || secretPending) && (
                  <Button
                    variant="soft"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Discard pending MCP configuration and secrets?")) {
                        setMcpName("")
                        setMcpConfig("{}")
                        setMcpSecrets({ env: {}, headers: {} })
                        setMcpDirty(false)
                        setMcpEditorVersion((version) => version + 1)
                        markPending("secret", false)
                      }
                    }}
                  >
                    <ResetIcon aria-hidden="true" />
                    Discard MCP draft
                  </Button>
                )}
              </Flex>
            </Panel>
          </Box>
        </Box>
      </Box>
    </>
  )
}
