import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../../..", import.meta.url))

describe("Node.js runtime baseline", () => {
  it("requires Node.js 26 in the root and every workspace", async () => {
    const manifests = ["package.json"]
    for (const parent of ["apps", "packages"]) {
      const entries = await readdir(path.join(root, parent), { withFileTypes: true })
      manifests.push(
        ...entries
          .filter(
            (entry) =>
              entry.isDirectory() &&
              existsSync(path.join(root, parent, entry.name, "package.json")),
          )
          .map((entry) => `${parent}/${entry.name}/package.json`),
      )
    }
    for (const manifest of manifests) {
      const json = JSON.parse(await readFile(path.join(root, manifest), "utf8"))
      expect(json.engines.node, manifest).toBe(">=26")
    }
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(26)
  })

  it("uses Node.js 26 in CI and release workflows", async () => {
    for (const file of ["ci.yml", "publish.yml"]) {
      const workflow = await readFile(path.join(root, ".github/workflows", file), "utf8")
      expect(workflow).toMatch(/node-version: 26\b/)
    }
  })

  it("uses Node.js 26 for every Node-based Docker stage", async () => {
    const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8")
    const images = [...dockerfile.matchAll(/^FROM (node:\S+)/gm)].map((match) => match[1])
    expect(images).toHaveLength(4)
    expect(images.every((image) => image === "node:26-bookworm-slim")).toBe(true)
  })
})
