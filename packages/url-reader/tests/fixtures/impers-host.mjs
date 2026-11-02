// Deterministic protocol peers. These programs never open network connections.
import { createInterface } from "node:readline"

const mode = process.argv[2]
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const metadata = {
  status: 200,
  statusText: "OK",
  url: "http://8.8.8.8/",
  headers: [],
  elapsed: 0,
  primaryIp: null,
  primaryPort: 0,
  localIp: null,
  localPort: 0,
  redirectCount: 0,
  redirectUrl: null,
  httpVersion: 1,
}
if (mode === "exit") process.exit(7)
if (mode === "startup") {
  process.stdin.resume()
} else {
  if (mode === "delayed") setTimeout(() => send({ type: "ready" }), 150)
  else send({ type: "ready" })
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = JSON.parse(line)
      if (message.type === "cancel") {
        if (mode !== "stubborn")
          send({ type: "failure", id: message.id, code: "transport_failure" })
        return
      }
      const id = message.id
      if (mode === "stubborn" || mode === "wait") return
      if (mode === "crash") process.exit(9)
      else if (mode === "json") process.stdout.write("{not-json}\n")
      else if (mode === "oversized") process.stdout.write("x".repeat(65537))
      else if (mode === "unknown") send({ type: "complete", id: id + 1, metadata })
      else if (mode === "base64") send({ type: "chunk", id, data: "!!!!" })
      else if (mode === "metadata")
        send({ type: "complete", id, metadata: { ...metadata, status: 999 } })
      else if (mode === "body")
        send({ type: "chunk", id, data: Buffer.alloc(100).toString("base64") })
      else if (mode === "body-end")
        process.stdout.write(
          JSON.stringify({ type: "chunk", id, data: Buffer.alloc(100).toString("base64") }) +
            "\n" +
            JSON.stringify({ type: "complete", id, metadata }) +
            "\n",
        )
      else if (mode === "tls") send({ type: "failure", id, code: "tls_certificate" })
      else send({ type: "complete", id, metadata })
    })
    .on("close", () => {
      if (mode === "stubborn") setInterval(() => {}, 1000)
    })
}
