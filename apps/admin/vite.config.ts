import { defineConfig } from "vitest/config"
export default defineConfig({
  build: {
    rolldownOptions: {
      // This application runs only in the browser; React server/client boundaries do not apply.
      checks: { moduleLevelDirective: false },
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "radix", test: /node_modules[\\/](@radix-ui|radix-ui)[\\/]/ },
          ],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:17465", "/auth": "http://127.0.0.1:17465" } },
  test: { include: ["src/**/*.test.ts"] },
})
