import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { JsonValue } from "@earendil-works/pi-ai"
import { type CallToolResult, type ContentBlock, toLlmContent } from "@earendil-works/pi-mcp"

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

/** Protocol fields are fixed vocabulary, not user payload keys. Drop metadata before redaction. */
function redactContent(block: ContentBlock, redact: (text: string) => string): ContentBlock {
  const text = (value?: string) => (value === undefined ? undefined : redact(value))
  const binary = (value: string) => {
    if (redact(value) !== value)
      throw new Error("MCP binary content or MIME metadata contains configured credentials")
    return value
  }
  if (block.annotations) {
    const { audience, priority } = block.annotations
    if (
      (audience !== undefined &&
        (!Array.isArray(audience) ||
          !audience.every((role) => role === "user" || role === "assistant"))) ||
      (priority !== undefined &&
        (typeof priority !== "number" ||
          !Number.isFinite(priority) ||
          priority < 0 ||
          priority > 1))
    )
      throw new Error("Invalid MCP content annotations")
  }
  if (
    block.type === "resource_link" &&
    block.size !== undefined &&
    (typeof block.size !== "number" || !Number.isInteger(block.size) || block.size < 0)
  )
    throw new Error("Invalid MCP resource size")
  const annotations = block.annotations
    ? {
        annotations: {
          audience: block.annotations.audience,
          priority: block.annotations.priority,
          lastModified: text(block.annotations.lastModified),
        },
      }
    : {}
  switch (block.type) {
    case "text":
      return { ...annotations, type: "text", text: redact(block.text) }
    case "image":
    case "audio":
      return {
        ...annotations,
        type: block.type,
        data: binary(block.data),
        mimeType: binary(block.mimeType),
      }
    case "resource_link":
      return {
        ...annotations,
        type: "resource_link",
        uri: redact(block.uri),
        name: redact(block.name),
        title: text(block.title),
        description: text(block.description),
        mimeType: block.mimeType === undefined ? undefined : binary(block.mimeType),
        size: block.size,
      }
    case "resource": {
      const resource = block.resource
      const base = {
        uri: redact(resource.uri),
        mimeType: resource.mimeType === undefined ? undefined : binary(resource.mimeType),
      }
      return {
        ...annotations,
        type: "resource",
        resource:
          "text" in resource
            ? { ...base, text: redact(resource.text) }
            : { ...base, blob: binary(resource.blob) },
      }
    }
    default:
      throw new Error("Unsupported MCP content type")
  }
}

/** Preserve the raw MCP contract for scripts, while bounding model text, images and disk output. */
export async function shapeMcpResult(
  raw: CallToolResult,
  directory: string,
  redact: (text: string) => string,
) {
  if (raw.isError !== undefined && typeof raw.isError !== "boolean")
    throw new Error("Invalid MCP result error flag")
  const safe: CallToolResult = {
    content: raw.content.map((block) => redactContent(block, redact)),
    ...(raw.structuredContent === undefined
      ? {}
      : {
          structuredContent: redactMcpData(raw.structuredContent, redact) as Record<
            string,
            unknown
          >,
        }),
    ...(raw.isError === undefined ? {} : { isError: raw.isError }),
  }
  if (Buffer.byteLength(JSON.stringify(safe)) > MCP_MAX_MESSAGE_BYTES)
    throw new Error("MCP result exceeds the output byte limit")
  for (const block of safe.content ?? []) {
    const image =
      block.type === "image" || block.type === "audio"
        ? block
        : block.type === "resource"
          ? block.resource
          : undefined
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
