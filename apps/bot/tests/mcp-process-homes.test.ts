import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { McpProcessHomes } from "../src/agent/mcp-process-homes.js"

describe("MCP process home recovery", () => {
  it("removes abandoned homes once without touching results, other directories or symlink targets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-home-recovery-"))
    const homes = new McpProcessHomes(directory)
    const created: string[] = []
    try {
      for (const name of ["process-abandoned", "results", "other"]) {
        await mkdir(path.join(directory, name))
        await writeFile(path.join(directory, name, "data"), "private data")
      }
      await symlink(path.join(directory, "other"), path.join(directory, "process-link"))
      created.push(...(await Promise.all(Array.from({ length: 4 }, () => homes.create()))))
      expect(await readdir(directory)).not.toContain("process-abandoned")
      expect(await readFile(path.join(directory, "results", "data"), "utf8")).toBe("private data")
      expect(await readFile(path.join(directory, "other", "data"), "utf8")).toBe("private data")
      for (const home of created) expect(await readdir(home)).toEqual([])
      const next = new McpProcessHomes(directory)
      const active = await next.create()
      created.push(active)
      for (const home of created) expect(await readdir(home)).toEqual([])
    } finally {
      for (const home of created) await homes.remove(home)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
