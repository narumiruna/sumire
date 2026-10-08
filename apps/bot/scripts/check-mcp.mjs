import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createPublicUrlLoader, createUrlTool } from "@narumitw/sumire-url-tool"
import { McpCapability } from "../dist/agent/mcp-capability.js"
import { loadMcpConfig } from "../dist/agent/mcp-config.js"
import { createLogger, withLogSpan } from "../dist/logging.js"
import { traceUrlLoad } from "../dist/url-telemetry.js"

const firecrawlOnly = process.argv.includes("--firecrawl-only")
const chromeOnly = process.argv.includes("--chrome-only")
assert.ok(!(firecrawlOnly && chromeOnly), "Choose only one server filter")
if (!chromeOnly)
  assert.ok(process.env.FIRECRAWL_API_KEY, "FIRECRAWL_API_KEY is required for the live smoke")
const telemetry = process.argv.includes("--telemetry")
if (telemetry)
  assert.ok(process.env.LOGFIRE_TOKEN, "LOGFIRE_TOKEN is required for telemetry verification")
const logger = createLogger(false, telemetry ? process.env.LOGFIRE_TOKEN : undefined)
const directory = await mkdtemp("/tmp/sumire-mcp-smoke-")
let capability
try {
  await withLogSpan(
    logger,
    "browser.verify",
    { "verification.kind": "browser-runtime-smoke" },
    async (span) => {
      const input = JSON.parse(await readFile("/app/mcp.json", "utf8"))
      // Only filter servers: browser arguments must come from the production config/launcher.
      if (firecrawlOnly) input.mcpServers["chrome-devtools"].enabled = false
      if (chromeOnly) input.mcpServers.firecrawl.enabled = false
      const file = path.join(directory, "mcp.json")
      await writeFile(file, JSON.stringify(input), { mode: 0o600 })
      const config = await loadMcpConfig({ botMcpConfigPath: file }, logger)
      assert.equal(config.servers.length, firecrawlOnly || chromeOnly ? 1 : 2)
      capability = new McpCapability(
        config,
        directory,
        path.join(directory, "sessions"),
        logger,
        () => {},
      )
      await capability.ready()
      for (
        let attempt = 0;
        !firecrawlOnly &&
        !capability.tools.some((t) => t.name.startsWith("mcp__chrome_devtools__")) &&
        attempt < 5;
        attempt++
      )
        await capability.ready()
      const call = async (name, args) => {
        const tool = capability.tools.find((t) => t.name === name)
        assert.ok(tool, `Missing tool ${name}`)
        const result = await tool.execute(
          "live-smoke",
          args,
          AbortSignal.timeout(60000),
          undefined,
          undefined,
        )
        logger.info(`Browser verification tool finished tool=${name} success=${!result.isError}`)
        assert.equal(result.isError, false, `${name} returned an error (details withheld)`)
        return result
      }
      if (!firecrawlOnly) {
        await call("mcp__chrome_devtools__list_pages", {})
        await call("mcp__chrome_devtools__new_page", { url: "https://example.com" })
        const snapshot = await call("mcp__chrome_devtools__take_snapshot", {})
        assert.ok(
          JSON.stringify(snapshot.content).includes("Example Domain"),
          "Example page verification failed (content withheld)",
        )
        const screenshot = await call("mcp__chrome_devtools__take_screenshot", {
          format: "jpeg",
          quality: 50,
        })
        assert.ok(screenshot.content.some((block) => block.type === "image"))
        console.log(
          `Chrome smoke passed: production launcher; non-root uid=${process.getuid()}; public-page snapshot and screenshot`,
        )
      }
      if (!firecrawlOnly) {
        const urlTool = createUrlTool(createPublicUrlLoader({ firecrawlFallback: false }), {
          selectableLoaders: ["playwright"],
          traceLoad: (url, loader, callId, load) => traceUrlLoad(logger, url, loader, callId, load),
        })
        const loaded = await urlTool.execute(
          "browser-runtime-smoke-url",
          { url: "https://example.com", loader: "playwright" },
          AbortSignal.timeout(60000),
        )
        assert.equal(loaded.details.loaderId, "playwright")
        assert.ok(
          loaded.details.text.includes("Example Domain"),
          "URL content verification failed (content withheld)",
        )
        console.log("URL tool smoke passed: explicit Playwright; no fallback")
        if (telemetry) {
          await call("mcp__chrome_devtools__new_page", {
            url: "https://en.wikipedia.org/w/index.php?title=Special:Search&search=IANA&fulltext=1",
          })
          const search = await call("mcp__chrome_devtools__take_snapshot", {})
          assert.ok(
            JSON.stringify(search.content).includes("/wiki/Internet_Assigned_Numbers_Authority"),
            "Public search did not return the expected IANA result (content withheld)",
          )
          console.log(
            "Chromium search smoke passed: public Wikipedia IANA search; content withheld",
          )
        }
      }
      if (!chromeOnly) {
        await call("mcp__firecrawl__firecrawl_search", {
          query: "example.com Example Domain",
          limit: 1,
        })
        console.log(
          "Firecrawl smoke passed: Streamable HTTP; one search with limit=1; credentials and content withheld",
        )
      }
      span.setAttribute("verification.outcome", "success")
    },
  )
} finally {
  try {
    await capability?.close()
  } finally {
    try {
      await rm(directory, { recursive: true, force: true })
    } finally {
      await logger.shutdown()
    }
  }
}
