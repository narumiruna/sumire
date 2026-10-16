import path from "node:path"
import { z } from "zod"
import { McpCapability } from "../agent/mcp-capability.js"
import { MCP_MAX_SERVERS, parseMcpConfig } from "../agent/mcp-config.js"
import { readMcpConfigFile } from "../agent/mcp-config-file.js"
import { AdminError, type AdminStore } from "./store.js"

const entrySchema = z
  .object({
    type: z.enum(["stdio", "http", "streamable-http"]).optional(),
    command: z.string().max(2048).optional(),
    args: z.array(z.string().max(4096)).max(128).optional(),
    cwd: z.string().max(2048).optional(),
    env: z.record(z.string().max(128), z.string().max(8192).nullable()).optional(),
    url: z.url().max(2048).optional(),
    headers: z.record(z.string().max(128), z.string().max(8192).nullable()).optional(),
    description: z.string().max(4096).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().positive().max(3600).optional(),
    exposure: z.enum(["codemode", "direct", "hidden"]).optional(),
    toolExposure: z
      .record(z.string().max(128), z.enum(["codemode", "direct", "hidden"]))
      .optional(),
  })
  .strict()
type Entry = z.infer<typeof entrySchema>

export class McpAdmin {
  readonly discovered = new Map<string, { status: string; tools: string[] }>()
  readonly probes = new Set<McpCapability>()
  constructor(
    readonly store: AdminStore,
    private readonly workdir: string,
  ) {
    store.db.exec("CREATE TABLE IF NOT EXISTS mcp (name TEXT PRIMARY KEY, config TEXT NOT NULL)")
  }
  async import(file: string) {
    if (this.store.db.prepare("SELECT name FROM mcp LIMIT 1").get()) return
    const row = this.store.db.prepare("SELECT name FROM imports WHERE name='mcp'").get()
    if (row) return
    const text = await readMcpConfigFile(file)
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("MCP import exceeded byte limit")
    const parsed = z
      .object({ mcpServers: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(JSON.parse(text))
    const entries = Object.entries(parsed.mcpServers)
    if (entries.length > MCP_MAX_SERVERS)
      throw new Error(`MCP configuration supports at most ${MCP_MAX_SERVERS} server entries`)
    const candidates: [string, Entry][] = []
    for (const [name, input] of entries) {
      const entry = entrySchema.safeParse(input)
      if (!entry.success) continue
      let invalid = false
      const validated = parseMcpConfig(
        { mcpServers: { [name]: entry.data } },
        {
          warn: () => {
            invalid = true
          },
        },
      )
      if (!invalid && (entry.data.enabled === false || validated.servers.length === 1))
        candidates.push([name, entry.data])
    }
    const names = new Map<string, number>()
    for (const [name, entry] of candidates) {
      if (entry.enabled === false) continue
      const normalized = name.replaceAll("-", "_")
      names.set(normalized, (names.get(normalized) ?? 0) + 1)
    }
    const accepted = candidates.filter(
      ([name, entry]) => entry.enabled === false || names.get(name.replaceAll("-", "_")) === 1,
    )
    this.store.db.exec("BEGIN IMMEDIATE")
    try {
      for (const [name, entry] of accepted)
        this.store.db.prepare("INSERT INTO mcp VALUES (?,?)").run(name, JSON.stringify(entry))
      this.store.db.prepare("INSERT INTO imports VALUES ('mcp',?)").run(
        JSON.stringify({
          servers: accepted.length,
          skippedServers: entries.length - accepted.length,
          reviewRequired: true,
        }),
      )
      this.store.audit(
        "system",
        "mcp.import",
        this.store.snapshot().revision,
        "imported; review required",
      )
      this.store.db.exec("COMMIT")
    } catch (error) {
      this.store.db.exec("ROLLBACK")
      throw error
    }
  }
  raw() {
    const rows = this.store.db.prepare("SELECT * FROM mcp ORDER BY name").all() as {
      name: string
      config: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.name, entrySchema.parse(JSON.parse(r.config))]))
  }
  config() {
    return parseMcpConfig({ mcpServers: this.raw() }, { warn: () => {} })
  }
  inventory() {
    return Object.entries(this.raw()).map(([name, entry]) => ({
      name,
      fields: Object.keys(entry),
      enabled: entry.enabled,
      exposure: entry.exposure,
      toolExposure: entry.toolExposure,
      connection: this.discovered.get(name)?.status ?? "not tested",
      tools: this.discovered.get(name)?.tools ?? [],
      // URLs/commands/args can contain secrets from legacy configuration. Do not echo them.
      url: entry.url ? "configured" : undefined,
      command: entry.command ? "configured" : undefined,
      args: entry.args?.map(() => "configured"),
      cwd: entry.cwd ? "configured" : undefined,
      env: Object.fromEntries(Object.keys(entry.env ?? {}).map((k) => [k, null])),
      headers: Object.fromEntries(Object.keys(entry.headers ?? {}).map((k) => [k, null])),
    }))
  }
  async discover(name: string) {
    if (this.probes.size) throw new AdminError(409, "An MCP connection test is already running")
    const config = this.config()
    const server = config.servers.find((s) => s.name === name)
    if (!server) throw new AdminError(400, "MCP server is disabled or invalid")
    const capability = new McpCapability(
      { ...config, servers: [server] },
      this.workdir,
      path.join(path.dirname(this.store.file), "admin-mcp"),
      { warn: () => {} },
      () => {},
    )
    this.probes.add(capability)
    try {
      await capability.ready(AbortSignal.timeout(15_000))
      const tools = capability.tools.map((tool) => tool.name)
      const state = {
        status: tools.length ? "connected" : "no visible tools or unavailable",
        tools,
      }
      this.discovered.set(name, state)
      return state
    } finally {
      await capability.close()
      this.probes.delete(capability)
    }
  }
  async close() {
    await Promise.all([...this.probes].map((probe) => probe.close()))
  }
  remove(name: string, revision: number, actor: string) {
    if (this.probes.size) throw new AdminError(409, "Wait for the MCP connection test to finish")
    const state = this.store.snapshot()
    if (state.revision !== revision) throw new AdminError(409, "Settings changed; reload")
    if (!Object.hasOwn(this.raw(), name)) throw new AdminError(404, "MCP server not found")
    if (
      state.policy.servers.includes(name) ||
      [state.policy.defaults, ...Object.values(state.policy.chats)].some((s) =>
        s.servers?.includes(name),
      )
    )
      throw new AdminError(409, "Remove the server from global, default, and chat selections first")
    this.store.db.exec("BEGIN IMMEDIATE")
    try {
      const changed = this.store.db
        .prepare(
          "UPDATE settings SET revision=revision+1,epoch=epoch+1,status='pending' WHERE id=1 AND revision=?",
        )
        .run(revision)
      if (!changed.changes) throw new AdminError(409, "Settings changed; reload")
      this.store.db.prepare("DELETE FROM mcp WHERE name=?").run(name)
      this.store.audit(actor, "mcp.delete", revision + 1, "deleted", `mcp:${name}`)
      this.store.db.exec("COMMIT")
      this.discovered.delete(name)
    } catch (error) {
      this.store.db.exec("ROLLBACK")
      throw error
    }
  }
  save(name: string, input: unknown, revision: number, actor: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new AdminError(400, "Invalid MCP name")
    if (this.probes.size) throw new AdminError(409, "Wait for the MCP connection test to finish")
    const previous = this.raw()[name]
    const patch = entrySchema.parse(input)
    if (patch.command !== undefined && patch.url !== undefined)
      throw new AdminError(400, "Choose one MCP transport")
    const entry: Entry = { ...previous, ...patch }
    if (patch.command !== undefined) {
      delete entry.url
      if (patch.type === undefined) delete entry.type
    }
    if (patch.url !== undefined && patch.type === undefined) delete entry.type
    for (const key of ["env", "headers"] as const) {
      if (patch[key])
        entry[key] = Object.fromEntries(
          Object.entries(patch[key]).map(([k, v]) => [
            k,
            v === null
              ? (() => {
                  const saved = previous?.[key]?.[k]
                  if (typeof saved !== "string")
                    throw new AdminError(400, "Cannot preserve an unknown secret field")
                  return saved
                })()
              : v,
          ]),
        )
    }
    if (entry.url) {
      delete entry.command
      delete entry.cwd
      delete entry.args
      delete entry.env
    } else {
      delete entry.headers
    }
    const names = [...new Set([...Object.keys(this.raw()), name])]
    if (
      names.length > MCP_MAX_SERVERS ||
      names.some(
        (other) => other !== name && other.replaceAll("-", "_") === name.replaceAll("-", "_"),
      )
    )
      throw new AdminError(400, "MCP server limit or name collision")
    const config = { [name]: entry }
    let invalid = false
    const validated = parseMcpConfig(
      { mcpServers: config },
      {
        warn: () => {
          invalid = true
        },
      },
    )
    if (invalid || (entry.enabled !== false && !validated.servers.some((s) => s.name === name)))
      throw new AdminError(400, "Invalid MCP configuration or missing environment value")
    this.store.db.exec("BEGIN IMMEDIATE")
    try {
      const result = this.store.db
        .prepare(
          "UPDATE settings SET revision=revision+1,epoch=epoch+1,status='pending' WHERE id=1 AND revision=?",
        )
        .run(revision)
      if (!result.changes) throw new AdminError(409, "Settings changed; reload")
      this.store.db
        .prepare(
          "INSERT INTO mcp VALUES (?,?) ON CONFLICT(name) DO UPDATE SET config=excluded.config",
        )
        .run(name, JSON.stringify(entry))
      this.store.audit(actor, "mcp.update", revision + 1, "saved", `mcp:${name}`)
      this.discovered.delete(name)
      this.store.db.exec("COMMIT")
    } catch (error) {
      this.store.db.exec("ROLLBACK")
      throw error
    }
  }
}
