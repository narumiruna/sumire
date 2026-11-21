import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:17466", browserName: "chromium", headless: true },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:17466",
    reuseExistingServer: false,
    timeout: 30000,
  },
})
