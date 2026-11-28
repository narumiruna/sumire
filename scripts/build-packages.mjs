import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)

export function readPackages(directory = root) {
  return readdirSync(new URL("packages/", directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      directory: `packages/${entry.name}`,
      ...JSON.parse(
        readFileSync(new URL(`packages/${entry.name}/package.json`, directory), "utf8"),
      ),
    }))
}

/** Order package builds by local dependency edges, not directory/alphabetical order. */
export function packageBuildOrder(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  if (byName.size !== packages.length) throw new Error("Duplicate workspace package name")
  const done = new Set()
  const visiting = new Set()
  const ordered = []
  function visit(pkg) {
    if (done.has(pkg.name)) return
    if (visiting.has(pkg.name)) throw new Error(`Cyclic package build dependency: ${pkg.name}`)
    visiting.add(pkg.name)
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    }
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = byName.get(name)
      if (dependency) visit(dependency)
    }
    visiting.delete(pkg.name)
    done.add(pkg.name)
    if (pkg.scripts?.build) ordered.push(pkg)
  }
  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg)
  return ordered
}

export function buildPackages(packages, run = execFileSync) {
  const ordered = packageBuildOrder(packages)
  if (!ordered.length) return
  // One npm process, explicitly ordered workspaces; no recursive prebuild hooks.
  // This is CI-only. Ordinary local build/test/typecheck scripts keep their hooks.
  const args = ["--ignore-scripts", "run", "build"]
  for (const pkg of ordered) args.push("--workspace", pkg.directory)
  run("npm", args, { cwd: fileURLToPath(root), stdio: "inherit" })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildPackages(readPackages())
