import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { MCP_MAX_SERVERS } from "../src/agent/mcp-config.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

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
    expect(mcp.inventory()[0]?.fields).toEqual(expect.arrayContaining(["url", "headers"]))
    const beforeInvalid = mcp.raw()
    expect(() => mcp.save("fixture", { headers: { UNKNOWN: null } }, 1, "42")).toThrow(
      "unknown secret",
    )
    expect(mcp.raw()).toEqual(beforeInvalid)
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

it("keeps patch preservation and transport cleanup consistent with the field preview", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-patch-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  const mcp = new McpAdmin(store, directory)
  try {
    mcp.save(
      "fixture",
      {
        type: "stdio",
        command: "node",
        args: ["--version"],
        cwd: directory,
        env: { A: "opaque-a", B: "opaque-b" },
        enabled: false,
      },
      1,
      "42",
    )
    mcp.save("fixture", { description: "updated" }, 2, "42")
    expect(mcp.raw().fixture?.env).toEqual({ A: "opaque-a", B: "opaque-b" })
    mcp.save("fixture", { env: { A: null } }, 3, "42")
    expect(mcp.raw().fixture?.env).toEqual({ A: "opaque-a" })
    const before = mcp.raw()
    expect(() => mcp.save("fixture", { unknown: true }, 4, "42")).toThrow()
    expect(() =>
      mcp.save("fixture", { command: "node", url: "https://example.test" }, 4, "42"),
    ).toThrow("one MCP transport")
    expect(mcp.raw()).toEqual(before)
    mcp.save(
      "fixture",
      { url: "https://example.test", headers: { Authorization: "opaque-header" } },
      4,
      "42",
    )
    expect(mcp.raw().fixture).toEqual({
      url: "https://example.test",
      description: "updated",
      headers: { Authorization: "opaque-header" },
      enabled: false,
    })
    expect(mcp.inventory()[0]?.fields).toEqual(expect.arrayContaining(["url", "headers"]))
    expect(mcp.inventory()[0]?.fields).not.toContain("command")
    mcp.save("fixture", { command: "node" }, 5, "42")
    expect(mcp.raw().fixture).toEqual({ command: "node", description: "updated", enabled: false })
    expect(JSON.stringify(mcp.inventory())).not.toContain("opaque-")
  } finally {
    await mcp.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it("deletes unreferenced MCP entries with revision, probe, and reference checks and reclaims capacity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-delete-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, new Set([42]), 42)
  let mcp = new McpAdmin(store, directory)
  try {
    for (let i = 0; i < MCP_MAX_SERVERS; i++)
      mcp.save(
        `fixture${i}`,
        { command: "node", enabled: false, env: { TOKEN: "delete-secret" } },
        i + 1,
        "42",
      )
    expect(() => mcp.save("replacement", { command: "node" }, 17, "42")).toThrow("limit")
    mcp.discovered.set("fixture0", { status: "connected", tools: ["fixture-tool"] })
    const before = store.snapshot()
    expect(() => mcp.remove("fixture0", 1, "42")).toThrow("Settings changed")
    expect(() => mcp.remove("missing", 17, "42")).toThrow("not found")
    expect(store.snapshot()).toEqual(before)
    for (const scope of ["global", "default", "chat"]) {
      const policy = store.snapshot().policy
      // Write directly to isolate reference checks, including legacy inconsistent references.
      if (scope === "global") policy.servers = ["fixture0"]
      if (scope === "default") policy.defaults.servers = ["fixture0"]
      if (scope === "chat")
        policy.chats["42"] = { ...policy.defaults, enabled: true, servers: ["fixture0"] }
      store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(policy))
      expect(() => mcp.remove("fixture0", 17, "42")).toThrow("selections first")
      store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(before.policy))
    }
    const probe = {} as never
    mcp.probes.add(probe)
    expect(() => mcp.remove("fixture0", 17, "42")).toThrow("connection test")
    mcp.probes.delete(probe)
    mcp.remove("fixture0", 17, "42")
    expect(store.snapshot()).toMatchObject({
      revision: 18,
      epoch: before.epoch + 1,
      status: "pending",
    })
    expect(mcp.raw().fixture0).toBeUndefined()
    expect(mcp.discovered.has("fixture0")).toBe(false)
    expect(store.listAudit(0)).toContainEqual(
      expect.objectContaining({ operation: "mcp.delete", target: "mcp:fixture0", revision: 18 }),
    )
    expect(JSON.stringify(store.listAudit(0))).not.toContain("delete-secret")
    mcp.save("replacement", { command: "node" }, 18, "42")
    expect(Object.keys(mcp.raw())).toHaveLength(MCP_MAX_SERVERS)
    store.close()
    store = new AdminStore(file, new Set([42]), 42)
    mcp = new McpAdmin(store, directory)
    expect(mcp.raw().fixture0).toBeUndefined()
    expect(mcp.raw().replacement).toBeDefined()
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
      expect(store.snapshot().policy.tools).toContain("mcp__fixture__echo")
      expect(store.snapshot().policy.defaults.tools).toContain("mcp__fixture__echo")
      expect(store.snapshot().policy.servers).toEqual([])
      const revision = store.snapshot().revision
      await mcp.discover("fixture")
      expect(store.snapshot().revision).toBe(revision)
      expect(mcp.probes.size).toBe(0)
    } finally {
      await mcp.close()
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
