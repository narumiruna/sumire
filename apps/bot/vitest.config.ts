import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
    },
    include: ["tests/**/*.test.ts"],
  },
})
