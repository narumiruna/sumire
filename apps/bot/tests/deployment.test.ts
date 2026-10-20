import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"

const script = fileURLToPath(new URL("../scripts/deploy.sh", import.meta.url))
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deploy(failures: number, diagnosticFailure = false) {
  const directory = mkdtempSync(join(tmpdir(), "sumire-deploy-"))
  directories.push(directory)
  writeFileSync(
    join(directory, "docker"),
    `#!/bin/sh
set -eu
echo "$*" >> "$CALLS"
if [ "$1 $2" = "compose up" ]; then
  count=0
  if [ -f "$COUNTER" ]; then read -r count < "$COUNTER"; fi
  count=$((count + 1))
  echo "$count" > "$COUNTER"
  [ "$count" -gt "$FAILURES" ]
else
  [ "$DIAGNOSTIC_FAILURE" = "false" ]
fi
`,
    { mode: 0o700 },
  )
  writeFileSync(join(directory, "sleep"), '#!/bin/sh\necho "sleep $*" >> "$CALLS"\n', {
    mode: 0o700,
  })
  const calls = join(directory, "calls")
  const result = spawnSync("/bin/sh", [script], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CALLS: calls,
      COUNTER: join(directory, "counter"),
      FAILURES: String(failures),
      DIAGNOSTIC_FAILURE: String(diagnosticFailure),
    },
    encoding: "utf8",
    timeout: 10_000,
  })
  return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n") }
}

const up = "compose up --no-build --remove-orphans --force-recreate --wait --wait-timeout 180"
const diagnostics = ["compose ps --all", "compose logs --no-color --tail 100"]

it("waits for health and exits immediately on success", () => {
  const result = deploy(0)
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([up])
})

it("recovers from a transient container startup failure without deleting volumes", () => {
  const result = deploy(1)
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([up, ...diagnostics, "sleep 5", up])
})

it("fails after three attempts and reports the final failure without another delay", () => {
  const result = deploy(3)
  expect(result.status).toBe(1)
  expect(result.calls).toEqual([
    up,
    ...diagnostics,
    "sleep 5",
    up,
    ...diagnostics,
    "sleep 5",
    up,
    ...diagnostics,
  ])
  expect(result.stderr).toContain("Deployment failed after 3 startup attempts.")
})

it("continues recovery even when diagnostic commands fail", () => {
  const result = deploy(1, true)
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([up, ...diagnostics, "sleep 5", up])
})

it("uses the tested deployment script and does not cancel an active deployment", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  )
  expect(workflow).toContain("cancel-in-progress: false")
  expect(workflow).toContain("sh apps/bot/scripts/deploy.sh")
})
