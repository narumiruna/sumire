import { defineConfig } from "vitest/config"
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:17465", "/auth": "http://127.0.0.1:17465" } },
  test: { include: ["src/**/*.test.ts"] },
})
