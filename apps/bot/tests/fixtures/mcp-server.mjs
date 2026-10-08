import { spawn } from "node:child_process"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const tools = ["echo", "change_tools", "hold", "environment", "error", "large", "image", "binary"]
let names = process.env.MCP_TEST_TOOLS?.split(",") ?? [...tools]
const [sideEffects, pidFile, initializationDelay] = process.argv.slice(2)
if (pidFile) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  writeFileSync(pidFile, JSON.stringify({ server: process.pid, child: child.pid }))
}
let listRequests = 0
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result = {}
  if (request.method === "initialize") {
    if (initializationDelay)
      await new Promise((resolve) => setTimeout(resolve, Number(initializationDelay)))
    result = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "fake", version: "1" },
      instructions: "Use echo for testing",
    }
  }
  if (request.method === "tools/list") {
    listRequests++
    if (process.env.MCP_TEST_LIST_TRACE) appendFileSync(process.env.MCP_TEST_LIST_TRACE, "list\n")
    while (process.env.MCP_TEST_LIST_GATE && !existsSync(process.env.MCP_TEST_LIST_GATE))
      await new Promise((resolve) => setTimeout(resolve, 5))
    if (process.env.MCP_TEST_CONTINUOUS)
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
  }
  if (request.method === "tools/list")
    result = {
      tools: names.map((name) => ({
        name,
        description: `Test ${name}`,
        annotations: process.env.MCP_TEST_ANNOTATIONS
          ? JSON.parse(process.env.MCP_TEST_ANNOTATIONS)
          : undefined,
        inputSchema: process.env.MCP_TEST_SCHEMA
          ? JSON.parse(process.env.MCP_TEST_SCHEMA)
          : {
              type: "object",
              properties: { value: { type: "string", default: process.env.SECRET_KEY } },
            },
      })),
    }
  if (request.method === "tools/call") {
    const { name, arguments: args } = request.params
    if (!names.includes(name)) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown tool" } })
      return
    }
    if (name === "a_b" && sideEffects) appendFileSync(sideEffects, "replacement\n")
    if (name === "hold") {
      if (sideEffects) appendFileSync(sideEffects, "called\n")
      return
    }
    if (name === "change_tools") {
      names = args?.names ?? ["new_tool", ...tools.filter((name) => name !== "echo")]
      for (let i = 0; i < (args?.burst ? 100 : 1); i++)
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    }
    result = {
      content: [{ type: "text", text: JSON.stringify(args ?? {}) }],
      structuredContent: { args: args ?? {} },
    }
    if (args?.returnSecret)
      result = {
        content: [{ type: "text", text: process.env.SECRET_KEY ?? "absent" }],
        structuredContent: { secret: process.env.SECRET_KEY ?? "absent" },
      }
    if (name === "environment")
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              home: process.env.HOME,
              secret: process.env.BOT_TOKEN ?? "absent",
            }),
          },
        ],
      }
    if (name === "environment") result.structuredContent = { listRequests }
    if (name === "error")
      result = {
        content: [{ type: "text", text: "server tool error" }],
        structuredContent: { reason: "test" },
        isError: true,
      }
    if (name === "large") result = { content: [{ type: "text", text: "a".repeat(25000) }] }
    if (name === "image")
      result = { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }
    if (name === "binary")
      result = { content: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }] }
  }
  send({ jsonrpc: "2.0", id: request.id, result })
})
