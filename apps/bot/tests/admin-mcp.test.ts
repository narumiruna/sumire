import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { AdminStore } from "../src/admin/store.js"

it("imports MCP once, replaces secret fields explicitly, and never echoes their values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-mcp-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  const mcp = new McpAdmin(store)
  try {
    const source = path.join(directory, "mcp.json")
    await writeFile(
      source,
      JSON.stringify({
        mcpServers: {
          fixture: {
            url: "https://mcp.example.test/private",
            headers: { Authorization: "Bearer fixture-secret" },
          },
        },
      }),
    )
    await mcp.import(source)
    await writeFile(source, '{"mcpServers":{}}')
    await mcp.import(source)
    expect(mcp.raw().fixture?.headers?.Authorization).toBe("Bearer fixture-secret")
    expect(JSON.stringify(mcp.inventory())).not.toContain("fixture-secret")
    expect(JSON.stringify(mcp.inventory())).not.toContain("/private")
    mcp.save("fixture", { headers: { Authorization: null }, exposure: "direct" }, 1, "42")
    expect(mcp.raw().fixture?.headers?.Authorization).toBe("Bearer fixture-secret")
    expect(() => mcp.save("fixture", { headers: {} }, 1, "42")).toThrow("Settings changed")
    mcp.save("fixture", { headers: { Authorization: "Bearer replacement-fixture" } }, 2, "42")
    expect(mcp.raw().fixture?.headers?.Authorization).toBe("Bearer replacement-fixture")
    mcp.save("fixture", { headers: {} }, 3, "42")
    expect(mcp.raw().fixture?.headers).toEqual({})
    expect(JSON.stringify(store.listAudit(0))).not.toContain("fixture-secret")
    expect(JSON.stringify(store.listAudit(0))).not.toContain("replacement-fixture")
    expect(() => mcp.save("bad-name!", { command: "fixture" }, 4, "42")).toThrow("Invalid MCP name")
  } finally {
    await mcp.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
