import { type FileHandle, open } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MCP_MAX_CONFIG_BYTES, readMcpConfigFile } from "../src/agent/mcp-config-file.js"

vi.mock("node:fs/promises", () => ({ open: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

function file(source: Buffer, size = source.length, chunk = source.length || 1, regular = true) {
  let consumed = 0
  const handle = {
    stat: vi.fn(async () => ({ size, isFile: () => regular })),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = Math.min(length, chunk, source.length - consumed)
      source.copy(buffer, offset, consumed, consumed + bytesRead)
      consumed += bytesRead
      return { buffer, bytesRead }
    }),
    close: vi.fn(async () => {}),
  }
  vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle)
  return { handle, consumed: () => consumed }
}

describe("bounded MCP configuration file reads", () => {
  it("handles short reads and split UTF-8 without corruption", async () => {
    const input = "a🙂é漢"
    const { handle } = file(Buffer.from(input), undefined, 3)
    expect(await readMcpConfigFile("/config/mcp.json")).toBe(input)
    expect(handle.read.mock.calls.length).toBeGreaterThan(2)
    expect(handle.close).toHaveBeenCalledOnce()
  })
  it("accepts exactly the byte limit and reads only one extra EOF probe", async () => {
    const { handle, consumed } = file(Buffer.alloc(MCP_MAX_CONFIG_BYTES, 32), undefined, 4096)
    expect(Buffer.byteLength(await readMcpConfigFile("/config/mcp.json"))).toBe(
      MCP_MAX_CONFIG_BYTES,
    )
    expect(consumed()).toBe(MCP_MAX_CONFIG_BYTES)
    for (const [buffer, offset, length] of handle.read.mock.calls) {
      expect(buffer.length).toBe(MCP_MAX_CONFIG_BYTES + 1)
      expect(offset + length).toBeLessThanOrEqual(MCP_MAX_CONFIG_BYTES + 1)
    }
    expect(handle.close).toHaveBeenCalledOnce()
  })
  it("rejects known oversized files before allocating/reading their contents", async () => {
    const { handle } = file(Buffer.alloc(0), 1_000_000_000)
    await expect(readMcpConfigFile("/config/mcp.json")).rejects.toThrow()
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })
  it("bounds a file that grows after stat to limit plus one byte", async () => {
    const { handle, consumed } = file(Buffer.alloc(MCP_MAX_CONFIG_BYTES + 100), 0, 4096)
    await expect(readMcpConfigFile("/config/mcp.json")).rejects.toThrow("byte limit")
    expect(consumed()).toBe(MCP_MAX_CONFIG_BYTES + 1)
    expect(handle.close).toHaveBeenCalledOnce()
  })
  it("rejects non-regular files without reading", async () => {
    const { handle } = file(Buffer.alloc(0), 0, 1, false)
    await expect(readMcpConfigFile("/config/mcp.json")).rejects.toThrow()
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })
  it("closes handles on stat or read failures", async () => {
    for (const operation of ["stat", "read"] as const) {
      const { handle } = file(Buffer.from("input"))
      handle[operation].mockRejectedValueOnce(new Error("I/O failed"))
      await expect(readMcpConfigFile("/config/mcp.json")).rejects.toThrow("I/O failed")
      expect(handle.close).toHaveBeenCalledOnce()
    }
  })
})
