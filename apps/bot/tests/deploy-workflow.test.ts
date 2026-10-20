import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("recreates the container with the current policy and waits for health before pruning", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  )
  expect(workflow).toContain(
    "docker compose up -d --no-build --remove-orphans --force-recreate --wait --wait-timeout 180\n          docker image prune -f",
  )
  expect(workflow).toContain("if: always()\n        run: rm -f .env")
  const compose = readFileSync(new URL("../../../compose.yaml", import.meta.url), "utf8")
  expect(compose).toContain("healthcheck:")
  expect(compose).toContain("/healthz")
})
