import { z } from "zod"
import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import { readMcpConfigFile } from "./mcp-config-file.js"

const exposure = z.enum(["codemode", "direct", "hidden"])
const strings = z.record(z.string(), z.string())
const serverSchema = z
  .object({
    type: z.enum(["stdio", "http", "streamable-http"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: strings.default({}),
    url: z.url().optional(),
    headers: strings.default({}),
    description: z.string().max(4096).optional(),
    enabled: z.boolean().default(true),
    timeout: z.number().finite().positive().max(3600).default(60),
    exposure: exposure.default("codemode"),
    toolExposure: z.record(z.string(), exposure).default({}),
  })
  .strict()
  .refine((s) => Boolean(s.command) !== Boolean(s.url))
  .refine((s) => !s.type || (s.command ? s.type === "stdio" : s.type !== "stdio"))
  .refine((s) => !s.command || Object.keys(s.headers).length === 0)
  .refine((s) => !s.url || (!s.cwd && s.args.length === 0 && Object.keys(s.env).length === 0))
  .refine((s) => {
    if (!s.url) return true
    const u = new URL(s.url)
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
  })

export type McpServer = z.infer<typeof serverSchema> & { name: string; timeoutMs: number }
export type McpConfig = { servers: McpServer[]; redact: (text: string) => string }

/** Configuration is administrator-owned; never discover servers from the writable workdir. */
export async function loadMcpConfig(
  settings: Pick<Settings, "botMcpEnabled" | "botMcpConfigPath">,
  logger: Pick<Logger, "warn">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<McpConfig> {
  if (!settings.botMcpEnabled) return { servers: [], redact: (text) => text }
  let input: unknown
  try {
    const text = await readMcpConfigFile(settings.botMcpConfigPath)
    input = JSON.parse(text)
  } catch {
    throw new Error("MCP configuration could not be read as bounded JSON")
  }
  const top = z
    .object({ mcpServers: z.record(z.string(), z.unknown()) })
    .strict()
    .safeParse(input)
  if (!top.success) throw new Error("MCP configuration must contain an mcpServers object")
  const secrets = new Set<string>()
  const expand = (value: string, entrySecrets: Set<string>) => {
    if (value.trimStart().startsWith("!")) throw new Error("Credential commands are not supported")
    const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = Object.hasOwn(environment, name) ? environment[name] : undefined
      if (typeof replacement !== "string" || !replacement)
        throw new Error("Missing MCP environment variable")
      entrySecrets.add(replacement)
      return replacement
    })
    if (expanded.includes("${")) throw new Error("Invalid MCP environment placeholder")
    return expanded
  }
  const candidates: Array<{ server: McpServer; secrets: Set<string> }> = []
  for (const [name, raw] of Object.entries(top.data.mcpServers)) {
    // Do not include unvalidated names, values, schema errors or credentials in diagnostics.
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid or colliding server name")
      const server = serverSchema.parse(raw)
      if (!server.enabled) continue
      const entrySecrets = new Set<string>()
      server.env = Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => [k, expand(v, entrySecrets)]),
      )
      server.headers = Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [k, expand(v, entrySecrets)]),
      )
      for (const [key, value] of [
        ...Object.entries(server.env),
        ...Object.entries(server.headers),
      ]) {
        if (/auth|cookie|token|secret|password|key/i.test(key)) {
          entrySecrets.add(value)
          if (/auth/i.test(key) && value.includes(" "))
            entrySecrets.add(value.slice(value.indexOf(" ") + 1))
          if (/cookie/i.test(key))
            for (const cookie of value.split(";")) {
              const equals = cookie.indexOf("=")
              if (equals >= 0) entrySecrets.add(cookie.slice(equals + 1).trim())
            }
        }
      }
      // Round up once: retain positive sub-millisecond values without shortening a deadline.
      candidates.push({
        server: { ...server, name, timeoutMs: Math.max(1, Math.ceil(server.timeout * 1000)) },
        secrets: entrySecrets,
      })
    } catch {
      logger.warn("An MCP server was skipped: invalid configuration or missing environment")
    }
  }
  const counts = new Map<string, number>()
  for (const {
    server: { name },
  } of candidates) {
    const normalized = name.replaceAll("-", "_")
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  const uniqueServers = candidates
    .filter(({ server: { name } }) => {
      if (counts.get(name.replaceAll("-", "_")) === 1) return true
      logger.warn("An MCP server was skipped: invalid configuration or missing environment")
      return false
    })
    .map(({ server, secrets: entrySecrets }) => {
      for (const secret of entrySecrets) secrets.add(secret)
      return server
    })
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
  return {
    servers: uniqueServers,
    redact: (text) => values.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), text),
  }
}

export function toolExposure(server: McpServer, name: string) {
  const exact = Object.hasOwn(server.toolExposure, name) ? server.toolExposure[name] : undefined
  if (exact) return exact
  for (const [pattern, value] of Object.entries(server.toolExposure)) {
    const expression = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")
    if (new RegExp(`^${expression}$`).test(name)) return value
  }
  return server.exposure
}
