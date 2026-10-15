import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadSettings } from "../src/config/settings.js"

const compose = readFileSync(new URL("../../../compose.yaml", import.meta.url), "utf8")
const commandLine = compose.split("\n").find((line) => line.trim().startsWith('- "const adminId='))
if (!commandLine) throw new Error("Missing Compose admin healthcheck command")
const command: string = JSON.parse(commandLine.trim().slice(2))

function probe(environment: NodeJS.ProcessEnv) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `globalThis.fetch = async (url, options) => {
        console.log(JSON.stringify({ url, host: options.headers.host }));
        return { ok: true };
      }; ${command}`,
    ],
    { env: environment, encoding: "utf8", timeout: 10_000 },
  ).trim()
}

describe("Compose admin healthcheck", () => {
  it.each([
    {},
    { BOT_ADMIN_ID: "", ADMIN_ORIGIN: "" },
    { BOT_ADMIN_ID: "   " },
    { ADMIN_ORIGIN: "   " },
    { BOT_ADMIN_ID: " \t ", ADMIN_ORIGIN: " \t " },
  ])("skips the probe when settings disable the Web UI: %j", (environment) => {
    expect(loadSettings(environment).admin).toBeUndefined()
    expect(probe(environment)).toBe("")
  })

  it.each([
    { BOT_ADMIN_ID: "42" },
    { BOT_ADMIN_ID: " 42 ", ADMIN_ORIGIN: "   " },
    { BOT_ADMIN_ID: "42", ADMIN_ORIGIN: " https://admin.example.test " },
  ])("probes the same host as the enabled Web UI: %j", (environment) => {
    const config = loadSettings(environment).admin
    if (!config) throw new Error("Expected admin configuration")
    expect(JSON.parse(probe(environment))).toEqual({
      url: "http://127.0.0.1:17465/healthz",
      host: new URL(config.origin).host,
    })
  })
})
