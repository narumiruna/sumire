import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const workflow = readFileSync(
  new URL("../../../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
)

it("only handles closed pull requests targeting main", () => {
  expect(workflow).toContain(
    "on:\n  pull_request:\n    types:\n      - closed\n    branches:\n      - main\n",
  )
  expect(workflow).not.toContain("  push:")
  expect(workflow).not.toContain("  workflow_dispatch:")
})

it("only deploys merged release pull requests from this repository", () => {
  expect(workflow).toContain(
    "  deploy:\n    if: >-\n      github.event.pull_request.merged == true &&\n      github.event.pull_request.head.ref == 'changeset-release/main' &&\n      github.event.pull_request.head.repo.full_name == github.repository\n",
  )
})

it("only lets eligible deployment jobs cancel an active deployment", () => {
  expect(workflow).not.toMatch(/^concurrency:/m)
  expect(workflow).toContain(
    "    concurrency:\n      group: deploy\n      cancel-in-progress: true\n",
  )
})

it("checks out the release merge commit", () => {
  expect(workflow).toContain(
    "uses: actions/checkout@v7\n        with:\n          ref: ${{ github.event.pull_request.merge_commit_sha }}\n",
  )
})

it("recreates the container with the current policy and waits for health before pruning", () => {
  expect(workflow).toContain(
    "docker compose up -d --no-build --remove-orphans --force-recreate --wait --wait-timeout 180\n          docker image prune -f",
  )
  expect(workflow).toContain("if: always()\n        run: rm -f .env")
  const compose = readFileSync(new URL("../../../compose.yaml", import.meta.url), "utf8")
  expect(compose).toContain("healthcheck:")
  expect(compose).toContain("/healthz")
})
