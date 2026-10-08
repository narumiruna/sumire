export const MCP_MAX_CREDENTIALS = 128
export const MCP_MAX_CREDENTIAL_BYTES = 4096
export const MCP_MAX_TOTAL_CREDENTIAL_BYTES = 32_768

export function validateMcpSecrets(secrets: ReadonlySet<string>): void {
  if (secrets.size > MCP_MAX_CREDENTIALS) throw new Error("MCP credential count exceeds its limit")
  let bytes = 0
  for (const secret of secrets) {
    const size = Buffer.byteLength(secret)
    if (size > MCP_MAX_CREDENTIAL_BYTES) throw new Error("MCP credential exceeds its byte limit")
    bytes += size
  }
  if (bytes > MCP_MAX_TOTAL_CREDENTIAL_BYTES)
    throw new Error("MCP credentials exceed their total byte limit")
}

/** One literal replacement pass; replacement markers are never fed into later matches. */
export function createMcpRedactor(secrets: ReadonlySet<string>): (text: string) => string {
  validateMcpSecrets(secrets)
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!values.length) return (text) => text
  const expression = new RegExp(
    values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  )
  return (text) => text.replace(expression, "[redacted]")
}
