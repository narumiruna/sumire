import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { JsonValue } from "@earendil-works/pi-ai"
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp"

export const MCP_MAX_MESSAGE_BYTES = 8_000_000
export const MCP_MAX_IMAGE_BYTES = 2_000_000
const MAX_TEXT_BYTES = 20_000

/** Redact string values before JSON encoding, including newlines and quotes. */
export function redactMcpData(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactMcpData(item, redact))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redact(k), redactMcpData(v, redact)]),
    )
  return value
}

/** Preserve the raw MCP contract for scripts, while bounding model text, images and disk output. */
export async function shapeMcpResult(
  raw: CallToolResult,
  directory: string,
  redact: (text: string) => string,
) {
  const { _meta: _discarded, ...safe } = redactMcpData(raw, redact) as CallToolResult
  if (Buffer.byteLength(JSON.stringify(safe)) > MCP_MAX_MESSAGE_BYTES)
    throw new Error("MCP result exceeds the output byte limit")
  for (const block of safe.content ?? []) {
    const image =
      block.type === "image" ? block : block.type === "resource" ? block.resource : undefined
    if (image && "data" in image && typeof image.data === "string") {
      if (Buffer.byteLength(image.data, "base64") > MCP_MAX_IMAGE_BYTES)
        throw new Error("MCP image exceeds the image byte limit")
    }
    if (image && "blob" in image && typeof image.blob === "string") {
      if (Buffer.byteLength(image.blob, "base64") > MCP_MAX_IMAGE_BYTES)
        throw new Error("MCP embedded binary exceeds the binary byte limit")
    }
  }
  const content = toLlmContent(safe)
  for (const block of content) {
    if (block.type !== "text" || Buffer.byteLength(block.text) <= MAX_TEXT_BYTES) continue
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, `${randomUUID()}.txt`)
    await writeFile(file, block.text, { mode: 0o600, flag: "wx" })
    block.text = `${Buffer.from(block.text).subarray(0, MAX_TEXT_BYTES).toString("utf8")}\n[truncated; full MCP text: ${file}]`
  }
  return {
    content,
    details: undefined,
    structuredContent: safe as unknown as JsonValue,
    isError: safe.isError === true,
  }
}
