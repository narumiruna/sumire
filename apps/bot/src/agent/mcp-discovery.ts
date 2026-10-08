import type { McpClient, McpRequestOptions, Tool } from "@earendil-works/pi-mcp"
import { z } from "zod"
import { MCP_MAX_MESSAGE_BYTES } from "./mcp-results.js"

const pageSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
        })
        .passthrough(),
    ),
    nextCursor: z.string().nullish(),
  })
  .passthrough()

/** The public request API permits bounds before fetching another page, unlike listTools(). */
export async function listBoundedMcpTools(
  client: Pick<McpClient, "request">,
  options: McpRequestOptions = {},
): Promise<Tool[]> {
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000)
  const tools: Tool[] = []
  const names = new Set<string>()
  const cursors = new Set<string>()
  let bytes = 0
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    signal.throwIfAborted()
    const raw = await client.request("tools/list", cursor === undefined ? undefined : { cursor }, {
      ...options,
      signal,
    })
    signal.throwIfAborted()
    if (
      raw &&
      typeof raw === "object" &&
      "tools" in raw &&
      Array.isArray(raw.tools) &&
      tools.length + raw.tools.length > 1024
    )
      throw new Error("MCP tool directory exceeds its tool limit")
    bytes += Buffer.byteLength(JSON.stringify(raw))
    if (bytes > MCP_MAX_MESSAGE_BYTES) throw new Error("MCP tool directory exceeds its byte limit")
    const page = pageSchema.parse(raw)
    for (const tool of page.tools) {
      if (names.has(tool.name)) throw new Error("MCP tool directory contains duplicate names")
      names.add(tool.name)
      tools.push(tool as Tool)
    }
    if (!page.nextCursor) return tools
    if (cursors.has(page.nextCursor))
      throw new Error("MCP tool directory contains a repeated cursor")
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new Error("MCP tool directory exceeds its page limit")
}
