import { defineConfig } from "vitest/config"
export default defineConfig({
  // The bot serves this build under /v2/, beside the v1 console at the origin root.
  base: "/v2/",
  build: {
    // Fonts must stay files: the bot's CSP and asset route serve them from /v2/assets/.
    assetsInlineLimit: 0,
    rolldownOptions: {
      // This application runs only in the browser; React server/client boundaries do not apply.
      checks: { moduleLevelDirective: false },
      output: {
        codeSplitting: {
          groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:17465", "/auth": "http://127.0.0.1:17465" } },
  test: { include: ["src/**/*.test.ts"] },
})
