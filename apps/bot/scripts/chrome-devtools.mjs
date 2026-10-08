import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright"

export async function chromeArgs() {
  const executable = chromium.executablePath()
  await access(executable, constants.X_OK)
  return [
    "-y",
    "chrome-devtools-mcp@latest",
    "--headless",
    "--isolated",
    "--executablePath",
    executable,
    "--no-page-id-routing",
    "--no-usage-statistics",
    "--no-performance-crux",
  ]
}

export async function launchChromeMcp() {
  const args = await chromeArgs()
  // Keep the child in the MCP transport's process group, with stdout reserved for JSON-RPC.
  const child = spawn("npx", args, { stdio: "inherit" })
  const forward = (signal) => child.kill(signal)
  const terminate = () => forward("SIGTERM")
  const interrupt = () => forward("SIGINT")
  process.on("SIGTERM", terminate)
  process.on("SIGINT", interrupt)
  const cleanup = () => {
    process.off("SIGTERM", terminate)
    process.off("SIGINT", interrupt)
  }
  child.once("error", () => {
    cleanup()
    console.error("Chrome MCP subprocess could not start")
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    cleanup()
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error("Unexpected launcher arguments")
    await launchChromeMcp()
  } catch {
    console.error("Chrome MCP launcher failed; verify the locked Playwright browser installation")
    process.exitCode = 1
  }
}
