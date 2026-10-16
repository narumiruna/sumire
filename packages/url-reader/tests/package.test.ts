import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("URL reader package", () => {
  it("exposes the library and CLI without Pi resources", async () => {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
    expect(manifest.name).toBe("@narumitw/sumire-url-reader")
    expect(manifest.bin).toEqual({ "sumire-url-reader": "dist/cli.js" })
    expect(manifest.pi).toBeUndefined()
    expect(manifest.files).not.toContain("skills")
    expect(manifest.exports["./resources"]).toBeUndefined()
    expect(manifest.exports["./cli"].import).toBe("./dist/cli.js")
  })

  it("imports all loaders without initializing impers", () => {
    const loaders = path.resolve(packageRoot, "dist/loaders/index.js")
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "await import(process.argv[1]); console.log('ready')", loaders],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          LIBCURL_PATH: "/nonexistent/libcurl.so",
          IMPER_DOWNLOAD_LIBCURL: "0",
        },
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ready")
  })
})
