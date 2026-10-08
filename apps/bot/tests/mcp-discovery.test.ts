import type { McpClient } from "@earendil-works/pi-mcp"
import { describe, expect, it, vi } from "vitest"
import { listBoundedMcpTools } from "../src/agent/mcp-discovery.js"
import { MCP_MAX_MESSAGE_BYTES } from "../src/agent/mcp-results.js"

const tool = (name: string) => ({ name, inputSchema: { type: "object" } })
function fixture(pages: unknown[]) {
  const request = vi.fn(async () => pages.shift())
  return { request, client: { request } as unknown as Pick<McpClient, "request"> }
}

describe("bounded MCP pagination", () => {
  it("requests cursors and preserves raw tool definitions across valid pages", async () => {
    const { client, request } = fixture([
      { tools: [tool("a-b")], nextCursor: "second" },
      { tools: [tool("a_b")], nextCursor: null },
    ])
    expect((await listBoundedMcpTools(client)).map((t) => t.name)).toEqual(["a-b", "a_b"])
    expect(request.mock.calls[1]).toMatchObject([
      "tools/list",
      { cursor: "second" },
      { signal: expect.any(AbortSignal) },
    ])
  })
  it("stops at the cumulative tool limit before requesting another page", async () => {
    const pages = [0, 1, 2].map((page) => ({
      tools: Array.from({ length: 600 }, (_, i) => tool(`${page}_${i}`)),
      nextCursor: String(page + 1),
    }))
    const { client, request } = fixture(pages)
    await expect(listBoundedMcpTools(client)).rejects.toThrow("tool limit")
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("stops at the cumulative byte limit even though each page fits the transport limit", async () => {
    const pages = [0, 1, 2].map((page) => ({
      tools: [{ ...tool(String(page)), description: "a".repeat(MCP_MAX_MESSAGE_BYTES / 2) }],
      nextCursor: String(page + 1),
    }))
    const { client, request } = fixture(pages)
    await expect(listBoundedMcpTools(client)).rejects.toThrow("byte limit")
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each([
    [{ tools: [tool("same")], nextCursor: "next" }, { tools: [tool("same")] }],
    [
      { tools: [], nextCursor: "same" },
      { tools: [], nextCursor: "same" },
    ],
    [{ tools: [{ name: "bad", inputSchema: null }] }],
    [{ tools: [], nextCursor: 1 }],
  ])("rejects duplicate names/cursors and malformed pages", async (...pages) => {
    await expect(listBoundedMcpTools(fixture(pages).client)).rejects.toThrow()
  })
  it("applies one absolute signal to all pages and stops dispatch after cancellation", async () => {
    const controller = new AbortController()
    const request = vi.fn(async () => {
      controller.abort()
      return { tools: [], nextCursor: "next" }
    })
    await expect(
      listBoundedMcpTools({ request } as unknown as Pick<McpClient, "request">, {
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
