import { createServer, get } from "node:http"

import * as logfire from "@pydantic/logfire-node"
import { expect, it } from "vitest"

import { createLogger, type LogfireClient } from "../src/logging.js"

it("keeps manual Logfire spans without exporting secrets in automatic HTTP spans", async () => {
  const spans: Array<{
    name: string
    attributes: Record<string, unknown>
    events: unknown
    status: unknown
  }> = []
  const server = createServer((_request, response) => {
    response.writeHead(200)
    response.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test server port")
  try {
    const client: LogfireClient = {
      ...logfire,
      configure(options) {
        logfire.configure({
          ...options,
          sendToLogfire: false,
          metrics: false,
          additionalSpanProcessors: [
            {
              onStart() {},
              onEnd(span) {
                spans.push({
                  name: span.name,
                  attributes: { ...span.attributes },
                  events: span.events,
                  status: span.status,
                })
              },
              async shutdown() {},
              async forceFlush() {},
            },
          ],
        })
      },
    }
    const logger = createLogger(false, "fake-write-token", client)
    const endpoint = `http://127.0.0.1:${address.port}`
    await logger.span?.("telegram.request", { "telegram.message_id": 42 }, async () => {
      const telegramUrl = `${endpoint}/bot123456:fake-token/getMe`
      const telegramResponse = await fetch(telegramUrl, {
        headers: { Authorization: "Bearer fake-authorization" },
      })
      expect(telegramResponse.ok).toBe(true)
      await new Promise<void>((resolve, reject) => {
        get(`${endpoint}/page?api_key=fake-query-secret`, (response) => {
          response.resume()
          response.on("end", resolve)
          response.on("error", reject)
        }).on("error", reject)
      })
    })
    const failure = new Error(`${endpoint}/private?signature=fake-error-secret`)
    await expect(
      logger.span?.("url.load", {}, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(spans.some((span) => span.name === "telegram.request")).toBe(true)
    expect(spans.find((span) => span.name === "telegram.request")?.attributes).toMatchObject({
      "telegram.message_id": 42,
    })
    const serialized = JSON.stringify(spans)
    expect(serialized).not.toContain("fake-token")
    expect(serialized).not.toContain("fake-authorization")
    expect(serialized).not.toContain("fake-query-secret")
    expect(serialized).not.toContain("fake-error-secret")
    expect(spans.find((span) => span.name === "url.load")?.attributes).toMatchObject({
      "operation.outcome": "error",
    })
    expect(spans.some((span) => "url.full" in span.attributes)).toBe(false)
  } finally {
    await logfire.shutdown()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
