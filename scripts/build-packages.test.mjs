import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

import { buildPackages, packageBuildOrder, readPackages } from "./build-packages.mjs"

const root = new URL("../", import.meta.url)
const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8")
const manifest = (directory) =>
  JSON.parse(readFileSync(new URL(`${directory}/package.json`, root), "utf8"))
const pkg = (name, dependencies = {}, scripts = { build: "tsc" }) => ({
  name,
  directory: `packages/${name}`,
  dependencies,
  scripts,
})

test("orders dependencies first, including a shared diamond, exactly once", () => {
  const packages = [
    pkg("application", { left: "*", right: "*", external: "*" }),
    pkg("left", { shared: "*" }),
    pkg("right", { shared: "*" }),
    pkg("shared"),
  ]
  assert.deepEqual(
    packageBuildOrder(packages).map((entry) => entry.name),
    ["shared", "left", "right", "application"],
  )
})

test("honors dev, optional, and peer workspace dependencies", () => {
  for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    const entry = { ...pkg("a"), [field]: { z: "*" } }
    assert.deepEqual(
      packageBuildOrder([entry, pkg("z")]).map((item) => item.name),
      ["z", "a"],
    )
  }
})

test("traverses a package without a build script and builds its dependency", () => {
  assert.deepEqual(
    packageBuildOrder([pkg("a", { z: "*" }, {}), pkg("z")]).map((entry) => entry.name),
    ["z"],
  )
})

test("rejects dependency cycles and duplicate names before invoking npm", () => {
  let calls = 0
  const run = () => {
    calls += 1
  }
  assert.throws(() => buildPackages([pkg("a", { b: "*" }), pkg("b", { a: "*" })], run), /Cyclic/)
  assert.throws(() => buildPackages([pkg("a"), pkg("a")], run), /Duplicate/)
  assert.equal(calls, 0)
})

test("issues one ordered npm invocation with recursive build hooks disabled", () => {
  const calls = []
  buildPackages([pkg("a", { z: "*" }), pkg("z")], (...args) => calls.push(args))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "npm")
  assert.deepEqual(calls[0][1], [
    "--ignore-scripts",
    "run",
    "build",
    "--workspace",
    "packages/z",
    "--workspace",
    "packages/a",
  ])
  assert.equal(calls[0][2].stdio, "inherit")
})

test("builds every repository package with its local dependencies already built", () => {
  const packages = readPackages()
  const ordered = packageBuildOrder(packages)
  assert.equal(ordered.length, packages.filter((entry) => entry.scripts?.build).length)
  const positions = new Map(ordered.map((entry, index) => [entry.name, index]))
  for (const entry of ordered) {
    for (const dependency of Object.keys({
      ...entry.dependencies,
      ...entry.devDependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    })) {
      if (positions.has(dependency))
        assert.ok(positions.get(dependency) < positions.get(entry.name))
    }
  }
})

test("partitions bot tests into both shards and covers every other test workspace", () => {
  const matrix = workflow.split("      matrix:\n")[1]?.split("    steps:\n")[0]
  assert.ok(matrix)
  assert.deepEqual(
    [...matrix.matchAll(/args: (--shard=\d\/\d)/g)].map((match) => match[1]),
    ["--shard=1/2", "--shard=2/2"],
  )
  for (const entry of readdirSync(new URL("apps/", root), { withFileTypes: true })) {
    if (entry.isDirectory() && manifest(`apps/${entry.name}`).scripts?.test)
      assert.ok(matrix.includes(`workspace: apps/${entry.name}`))
  }
  assert.ok(matrix.includes("workspace: packages\n"))
  assert.ok(workflow.includes("fail-fast: false"))
})

test("preserves non-build test hooks when CI skips lifecycle scripts", () => {
  const preserved = new Map([["@narumitw/sumire-pi-polymarket", "npm run generate:check"]])
  const buildHooks = new Set([
    "npm run build",
    "npm run build:dependencies",
    "npm run build --workspace @narumitw/sumire-policy",
  ])
  for (const entry of [...readPackages(), manifest("apps/bot"), manifest("apps/web")]) {
    const pretest = entry.scripts?.pretest
    if (!pretest || buildHooks.has(pretest)) continue
    assert.equal(pretest, preserved.get(entry.name), `Account for ${entry.name}'s pretest in CI`)
    assert.ok(workflow.includes(`${pretest} --workspace ${entry.directory}`))
  }
})

test("keeps local lifecycle hooks and gates the old required check on every matrix result", () => {
  for (const directory of ["apps/bot", "apps/web"]) {
    const scripts = manifest(directory).scripts
    assert.equal(scripts.pretest, "npm run build:dependencies")
    assert.equal(scripts.pretypecheck, "npm run build:dependencies")
    assert.equal(scripts.prebuild, "npm run build:dependencies")
  }
  const gate = workflow.split("  typescript:\n")[1]?.split("\n  container:\n")[0]
  assert.ok(gate?.includes("name: typescript-checks"))
  assert.ok(gate.includes("if: always()"))
  assert.ok(gate.includes("needs: [quality, tests]"))
  assert.ok(gate.includes('test "$QUALITY_RESULT" = success'))
  assert.ok(gate.includes('test "$TEST_RESULT" = success'))
})
