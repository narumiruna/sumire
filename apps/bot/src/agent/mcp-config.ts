import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"

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

export type McpServer = z.infer<typeof serverSchema> & { name: string }
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
    const text = await readFile(settings.botMcpConfigPath, "utf8")
    if (Buffer.byteLength(text) > 1_000_000) throw new Error("oversized")
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
  const expand = (value: string) => {
    if (value.trimStart().startsWith("!")) throw new Error("Credential commands are not supported")
    const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = Object.hasOwn(environment, name) ? environment[name] : undefined
      if (typeof replacement !== "string" || !replacement)
        throw new Error("Missing MCP environment variable")
      secrets.add(replacement)
      return replacement
    })
    if (expanded.includes("${")) throw new Error("Invalid MCP environment placeholder")
    return expanded
  }
  const servers: McpServer[] = []
  const counts = new Map<string, number>()
  for (const name of Object.keys(top.data.mcpServers)) {
    const normalized = name.replaceAll("-", "_")
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  for (const [name, raw] of Object.entries(top.data.mcpServers)) {
    // Do not include unvalidated names, values, schema errors or credentials in diagnostics.
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || counts.get(name.replaceAll("-", "_")) !== 1)
        throw new Error("Invalid or colliding server name")
      const server = serverSchema.parse(raw)
      if (!server.enabled) continue
      server.env = Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expand(v)]))
      server.headers = Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [k, expand(v)]),
      )
      for (const [key, value] of [
        ...Object.entries(server.env),
        ...Object.entries(server.headers),
      ]) {
        if (/auth|cookie|token|secret|password|key/i.test(key)) {
          secrets.add(value)
          if (/auth/i.test(key) && value.includes(" "))
            secrets.add(value.slice(value.indexOf(" ") + 1))
          if (/cookie/i.test(key))
            for (const cookie of value.split(";")) {
              const equals = cookie.indexOf("=")
              if (equals >= 0) secrets.add(cookie.slice(equals + 1).trim())
            }
        }
      }
      servers.push({ ...server, name })
    } catch {
      logger.warn("An MCP server was skipped: invalid configuration or missing environment")
    }
  }
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
  return {
    servers,
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
