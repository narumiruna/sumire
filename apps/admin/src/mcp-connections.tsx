import { AlertDialog, Badge, Button, Flex, Heading, TextArea } from "@radix-ui/themes"
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
      <Heading size="4">MCP connections — saved separately</Heading>
      <Prose>
        Connection configuration and enabled state do not grant execution permission. First
        discovery adds new tools to global and default permissions, but does not open server gates.
        Connection tests run only when requested.
      </Prose>
      <Button variant="soft" onClick={() => onTools()}>
        Manage tool and MCP server permissions
      </Button>
      <Panel className="mcp-step">
        <Heading size="3">1. Choose or create a server</Heading>
        {!inventory.mcp.length && (
          <Prose>
            No MCP connections configured. Add a server below, then test it and approve its tools
            separately.
          </Prose>
        )}
        <div className="mcp-choice-grid">
          <div className="mcp-saved-list">
            {inventory.mcp.map((m) => (
              <Panel
                key={m.name}
                className="mcp-connection-summary"
                aria-label={`${m.name} connection`}
              >
                <Heading size="3">{m.name}</Heading>
                <div className="mcp-summary-state">
                  <Badge>{m.enabled === false ? "Disabled" : "Enabled"}</Badge>
                  <Badge color="gray">Connection test: {m.connection}</Badge>
                  <span>Exposure: {m.exposure ?? "codemode"}</span>
                </div>
                <Prose size="2" className="mcp-summary-counts">
                  {countText(m.tools.length, "discovered tool")} ·{" "}
                  {countText(
                    m.tools.filter((name) => policy.tools.includes(name)).length,
                    "globally approved tool name",
                  )}{" "}
                  ·{" "}
                  {policy.servers.includes(m.name)
                    ? "Globally available"
                    : "Not globally available"}{" "}
                  · {dirty ? "Policy draft" : "Saved policy"}
                </Prose>
                <details>
                  <summary>Discovered tool names</summary>
                  <pre>{m.tools?.join("\n") || "No tools discovered."}</pre>
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
                    Edit fields for {m.name}
                  </Button>
                  <AlertDialog.Root>
                    <AlertDialog.Trigger>
                      <Button color="red" variant="ghost" disabled={busy || dirty || localPending}>
                        Delete {m.name}
                      </Button>
                    </AlertDialog.Trigger>
                    <AlertDialog.Content>
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
              Changing the name keeps the configuration patch. Staged secret replacements require
              confirmation before removal.
            </Prose>
          </div>
        </div>
      </Panel>
      <Panel className="mcp-step">
        <Heading size="3">2. Edit connection fields</Heading>
        <Prose size="2">
          Saved values stay hidden. Reload retains this draft; a failed request can still have saved
          changes. Defaults and chat selections can restrict these tools further.
        </Prose>
        <McpGuidedEditor
          text={mcpConfig}
          onChange={(text) => {
            setMcpConfig(text)
            setMcpDirty(true)
          }}
        />
        <details className="provider-advanced">
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
        <details className="mcp-secret-editor">
          <summary>Replace secrets</summary>
          <SecretFields
            key={`${mcpName}:${mcpEditorVersion}`}
            onPending={(v) => markPending("secret", v)}
            onChange={({ scope, name, value }) => {
              setMcpDirty(true)
              setMcpSecrets({ ...mcpSecrets, [scope]: { ...mcpSecrets[scope], [name]: value } })
            }}
          />
        </details>
        <Prose>
          Pending secret fields:{" "}
          {[...Object.keys(mcpSecrets.env), ...Object.keys(mcpSecrets.headers)].join(", ") ||
            "none"}
          .
        </Prose>
        <details>
          <summary>Secret preservation and transport rules</summary>
          <Prose>
            Omit env or headers to preserve that map. A map in JSON replaces the whole map: include
            every key to retain with null. Omitted keys are removed. An empty object clears the map.
            Masked replacements preserve existing keys when JSON omits that map. Do not put secrets
            in commands, arguments, descriptions, or URLs. Selecting an HTTP URL removes command,
            arguments, working directory, and environment fields. Selecting a stdio command removes
            URL and header fields. For a command-only update, an omitted transport type is cleared
            and inferred again.
          </Prose>
        </details>
      </Panel>
      <Panel className="mcp-step" aria-label="MCP change preview">
        <Heading size="3">3. Review and save</Heading>
        <Prose size="2">
          Field operations only; values are hidden. Transport changes remove fields that do not
          apply. The server validates this update before saving.
        </Prose>
        {mcpValidation ? (
          <Prose role="alert">{mcpValidation}</Prose>
        ) : (
          <ul>
            {mcpPreview.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
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
            Discard MCP draft
          </Button>
        )}
      </Panel>
    </>
  )
}
