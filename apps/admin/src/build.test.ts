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
  expect(warnings).toEqual([])
  expect(react?.moduleIds.some((id) => id.includes("/react-dom/"))).toBe(true)
  expect(entry?.imports).toContain(react?.fileName)
  for (const chunk of chunks)
    expect(Buffer.byteLength(chunk.code), chunk.fileName).toBeLessThanOrEqual(500_000)
})
