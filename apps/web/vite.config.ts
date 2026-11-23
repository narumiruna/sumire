import macros from "unplugin-parcel-macros"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [macros.vite()],
  // The dependency scan sees the import before the macro replaces it with CSS.
  optimizeDeps: { exclude: ["@react-spectrum/s2/style"] },
  build: {
    rolldownOptions: {
      // This application runs only in the browser; React server/client boundaries do not apply.
      checks: { moduleLevelDirective: false },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "feedback",
              test: /[\\/]src[\\/](feedback(?:-image)?|issues|issue-analysis)\.tsx?$/,
              includeDependenciesRecursively: false,
            },
            { name: "translations", test: /[\\/]src[\\/]locales[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: "spectrum",
              test: /node_modules[\\/]@react-spectrum[\\/]/,
              includeDependenciesRecursively: false,
            },
            {
              name: "react-aria",
              test: /node_modules[\\/](react-aria(?:-components)?|react-stately|@internationalized|clsx|use-sync-external-store)[\\/]/,
              includeDependenciesRecursively: false,
            },
            {
              name: "policy",
              test: /[\\/]packages[\\/]policy[\\/]|node_modules[\\/]zod[\\/]|[\\/]src[\\/]client-validation\.ts$/,
            },
          ],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:17465", "/auth": "http://127.0.0.1:17465" } },
  test: {
    include: ["src/**/*.test.ts"],
    // The macro plugin registers virtual CSS during transformation, not on a disk cache hit.
    fsModuleCache: false,
    server: { deps: { inline: [/@react-spectrum\/s2/] } },
  },
})
