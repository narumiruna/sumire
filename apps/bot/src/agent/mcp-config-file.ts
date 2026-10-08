import { constants } from "node:fs"
import { open } from "node:fs/promises"

export const MCP_MAX_CONFIG_BYTES = 1_000_000

/** Read only a bounded regular file, including growth after stat and short reads. */
export async function readMcpConfigFile(filename: string): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MCP_MAX_CONFIG_BYTES)
      throw new Error("Invalid MCP config file")
    const buffer = Buffer.alloc(MCP_MAX_CONFIG_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null)
      if (!result.bytesRead) break
      bytes += result.bytesRead
    }
    if (bytes > MCP_MAX_CONFIG_BYTES) throw new Error("MCP config exceeds the byte limit")
    return buffer.subarray(0, bytes).toString("utf8")
  } finally {
    await file.close()
  }
}
