import { type FileHandle, mkdir, open, rm } from "node:fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shapeMcpResult } from "../src/agent/mcp-results.js"

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(),
  open: vi.fn(),
  rm: vi.fn(),
}))
const raw = { content: [{ type: "text" as const, text: "long".repeat(6000) }] }
const redact = (text: string) => text
const handle = () => ({
  writeFile: vi.fn(async (_text: string, _options: { signal?: AbortSignal }) => {}),
  close: vi.fn(async () => {}),
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(rm).mockResolvedValue(undefined)
})

describe("MCP result shaping cancellation", () => {
  it("rejects an already-aborted signal before filesystem work", async () => {
    await expect(
      shapeMcpResult(raw, "/private/results", redact, AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled")
    expect(mkdir).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
  it("checks cancellation after the non-abortable mkdir", async () => {
    const abort = new AbortController()
    vi.mocked(mkdir).mockImplementationOnce(async () => {
      abort.abort(new Error("cancelled"))
      return undefined
    })
    await expect(shapeMcpResult(raw, "/private/results", redact, abort.signal)).rejects.toThrow(
      "cancelled",
    )
    expect(open).not.toHaveBeenCalled()
  })
  it("passes the signal to writes and removes partially written files on cancellation", async () => {
    const abort = new AbortController()
    const file = handle()
    vi.mocked(open).mockResolvedValue(file as unknown as FileHandle)
    file.writeFile.mockImplementationOnce(async (_text, options) => {
      expect(options.signal).toBe(abort.signal)
      abort.abort(new Error("cancelled"))
      throw abort.signal.reason
    })
    await expect(shapeMcpResult(raw, "/private/results", redact, abort.signal)).rejects.toThrow(
      "cancelled",
    )
    expect(file.close).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledWith(vi.mocked(open).mock.calls[0]?.[0], { force: true })
  })
  it("does not return success if cancellation arrives while closing the written file", async () => {
    const abort = new AbortController()
    const file = handle()
    vi.mocked(open).mockResolvedValue(file as unknown as FileHandle)
    file.close.mockImplementationOnce(async () => {
      abort.abort(new Error("cancelled"))
    })
    await expect(shapeMcpResult(raw, "/private/results", redact, abort.signal)).rejects.toThrow(
      "cancelled",
    )
    expect(rm).toHaveBeenCalledOnce()
  })
  it("removes earlier output files when a later output fails", async () => {
    const first = handle()
    const second = handle()
    second.writeFile.mockRejectedValueOnce(new Error("disk failure"))
    vi.mocked(open)
      .mockResolvedValueOnce(first as unknown as FileHandle)
      .mockResolvedValueOnce(second as unknown as FileHandle)
    await expect(
      shapeMcpResult({ content: [...raw.content, ...raw.content] }, "/private/results", redact),
    ).rejects.toThrow("disk failure")
    expect(rm).toHaveBeenCalledTimes(2)
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })
  it("rechecks cancellation after synchronous normalization even without disk output", async () => {
    const abort = new AbortController()
    await expect(
      shapeMcpResult(
        { content: [{ type: "text", text: "short" }] },
        "/private/results",
        (text) => {
          abort.abort(new Error("cancelled"))
          return text
        },
        abort.signal,
      ),
    ).rejects.toThrow("cancelled")
    expect(open).not.toHaveBeenCalled()
  })
})
