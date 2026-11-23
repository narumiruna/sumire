import { fileURLToPath } from "node:url"
import { build, createLogger } from "vite"
import { expect, it } from "vitest"

it("builds the browser application without warnings and splits the React runtime", async () => {
  const warnings: string[] = []
  const result = await build({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    customLogger: { ...createLogger("silent"), warn: (message) => warnings.push(message) },
    build: { write: false },
  })
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Expected one production build output")

  const chunks = result.output.filter((output) => output.type === "chunk")
  const entry = chunks.find((chunk) => chunk.isEntry)
  const react = chunks.find((chunk) => chunk.name === "react")
  const spectrum = chunks.find((chunk) => chunk.name === "spectrum")
  expect(warnings).toEqual([])
  expect(react?.moduleIds.some((id) => id.includes("/react-dom/"))).toBe(true)
  expect(entry?.imports).toContain(react?.fileName)
  expect(entry?.imports).toContain(spectrum?.fileName)
  expect(spectrum?.imports).not.toContain(entry?.fileName)

  const assets = result.output.filter((output) => output.type === "asset")
  const icon = assets.find((asset) =>
    /^assets\/sumire-icon-[A-Za-z0-9_-]+\.svg$/.test(asset.fileName),
  )
  const html = assets.find((asset) => asset.fileName === "index.html")
  expect(icon).toBeDefined()
  expect(html?.source).toEqual(expect.stringContaining(`href="/${icon?.fileName}"`))
  expect(entry?.code).toContain(`/${icon?.fileName}`)
  for (const chunk of chunks) {
    expect(Buffer.byteLength(chunk.code), chunk.fileName).toBeLessThanOrEqual(500_000)
    expect(chunk.moduleIds, chunk.fileName).not.toContainEqual(
      expect.stringMatching(/[/\\]node_modules[/\\](?:@radix-ui|radix-ui)[/\\]/),
    )
  }
  for (const asset of assets.filter((asset) => asset.fileName.endsWith(".css"))) {
    expect(asset.source.toString(), asset.fileName).not.toMatch(/\.radix-themes\b|\.rt-[A-Z]/)
  }
})
