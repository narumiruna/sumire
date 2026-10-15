import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { AdminStore } from "../src/admin/store.js"

it("imports MCP once, replaces secret fields explicitly, and never echoes their values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-mcp-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  const mcp = new McpAdmin(store, directory)
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

it.each([false, true])(
  "imports valid entries independently (all invalid: %s)",
  async (allInvalid) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-import-"))
    const store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
    const mcp = new McpAdmin(store, directory)
    try {
      const source = path.join(directory, "mcp.json")
      const input = JSON.stringify({
        mcpServers: {
          ...(allInvalid ? {} : { valid: { command: process.execPath } }),
          malformed: { command: 17, headers: { Authorization: "Bearer rejected-secret" } },
          semantic: { command: "node", url: "https://mcp.example.test" },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MCP expands this fixture at runtime.
          missing: { command: "node", env: { TOKEN: "${SUMIRE_MISSING_IMPORT_FIXTURE_9D83}" } },
          "bad-name!": { command: "node" },
          "same-name": { command: "node" },
          same_name: { command: "node" },
        },
      })
      await writeFile(source, input)
      await mcp.import(source)
      expect(Object.keys(mcp.raw())).toEqual(allInvalid ? [] : ["valid"])
      expect(await readFile(source, "utf8")).toBe(input)
      const row = store.db.prepare("SELECT report FROM imports WHERE name='mcp'").get() as {
        report: string
      }
      expect(JSON.parse(row.report)).toEqual({
        servers: allInvalid ? 0 : 1,
        skippedServers: 6,
        reviewRequired: true,
      })
      expect(row.report).not.toContain("rejected-secret")
      expect(JSON.stringify(store.listAudit(0))).not.toContain("rejected-secret")
      await writeFile(source, "{broken")
      await expect(mcp.import(source)).resolves.toBeUndefined()
    } finally {
      await mcp.close()
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it.each([undefined, "subdir"])(
  "probes relative stdio commands from the bot workdir (cwd: %s)",
  async (cwd) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-probe-"))
    const workdir = path.join(directory, "work")
    const target = path.join(workdir, cwd ?? "")
    await mkdir(target, { recursive: true })
    await copyFile(path.resolve("tests/fixtures/mcp-server.mjs"), path.join(target, "server.mjs"))
    const store = new AdminStore(path.join(directory, "state/admin.sqlite"), new Set([42]), 42)
    const mcp = new McpAdmin(store, workdir)
    try {
      mcp.save(
        "fixture",
        { command: process.execPath, args: ["server.mjs"], ...(cwd ? { cwd } : {}) },
        1,
        "42",
      )
      expect((await mcp.discover("fixture")).tools).toContain("mcp__fixture__echo")
      expect(mcp.probes.size).toBe(0)
    } finally {
      await mcp.close()
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
