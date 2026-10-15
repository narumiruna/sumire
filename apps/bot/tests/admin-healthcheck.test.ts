import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { loadSettings } from "../src/config/settings.js"

const compose = readFileSync(new URL("../../../compose.yaml", import.meta.url), "utf8")
const commandLine = compose.split("\n").find((line) => line.trim().startsWith('- "const adminId='))
if (!commandLine) throw new Error("Missing Compose admin healthcheck command")
const command: string = JSON.parse(commandLine.trim().slice(2))
const execute = promisify(execFile)
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

async function probe(environment: NodeJS.ProcessEnv, target?: string) {
  // Replace only the connection port. Keep the real client and configured Host unchanged.
  const script = target ? command.replace("http://127.0.0.1:17465/healthz", target) : command
  return execute(process.execPath, ["--input-type=module", "-e", script], {
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  })
}

async function endpoint(expectedHost: string, status = 200) {
  const received: Array<{ host: string | undefined; path: string | undefined }> = []
  const server = createServer((req, res) => {
    received.push({ host: req.headers.host, path: req.url })
    res.writeHead(req.headers.host === expectedHost ? status : 400)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`
  return { target, received }
}

describe("Compose admin healthcheck", () => {
  it.each([
    {},
    { BOT_ADMIN_ID: "", ADMIN_ORIGIN: "" },
    { BOT_ADMIN_ID: "   " },
    { ADMIN_ORIGIN: "   " },
    { BOT_ADMIN_ID: " \t ", ADMIN_ORIGIN: " \t " },
  ])(
    "fails the probe when required administrator configuration is missing: %j",
    async (environment) => {
      expect(() => loadSettings(environment)).toThrow()
      const { target, received } = await endpoint("localhost:17465")
      await expect(probe(environment, target)).rejects.toMatchObject({ code: 1 })
      expect(received).toEqual([])
    },
  )

  it.each([
    { BOT_ADMIN_ID: "42" },
    { BOT_ADMIN_ID: " 42 ", ADMIN_ORIGIN: "   " },
    { BOT_ADMIN_ID: "42", ADMIN_ORIGIN: " https://admin.example.test " },
  ])("sends the Web UI Host header on the wire: %j", async (environment) => {
    const config = loadSettings(environment).admin
    if (!config) throw new Error("Expected admin configuration")
    const host = new URL(config.origin).host
    const { target, received } = await endpoint(host)
    await expect(probe(environment, target)).resolves.toMatchObject({ stdout: "", stderr: "" })
    expect(received).toEqual([{ host, path: "/healthz" }])
  })

  it("fails when the health endpoint rejects the request", async () => {
    const { target } = await endpoint("localhost:17465", 503)
    await expect(probe({ BOT_ADMIN_ID: "42" }, target)).rejects.toMatchObject({ code: 1 })
  })
})
