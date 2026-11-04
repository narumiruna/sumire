import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const [mode, trace] = process.argv.slice(2)
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (trace) appendFileSync(trace, `${request.method}\n`)
  if (request.method === "initialize" && mode === "timeout") return
  if (request.method === "tools/list" && mode === "listing-error") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "private-secret" } })
    return
  }
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "observation", version: "1" },
        }
      : mode === "malformed"
        ? { tools: [{ name: "read", inputSchema: null }] }
        : { tools: mode === "empty" ? [] : [{ name: "read", inputSchema: { type: "object" } }] }
  send({ jsonrpc: "2.0", id: request.id, result })
})
