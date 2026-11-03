import { spawn } from "node:child_process"
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"

const bunVersion = "1.4.4"
const cacheDirectories = new Set([".cache", ".vite", ".vite-temp", ".vitest-cache"])
// Bun 1.4.4 treats malformed ranges such as "not-semver" as wildcards.
// Accept standard comparator sets and hyphen ranges before using Bun.semver.
const numericPattern = String.raw`(?:0|[1-9]\d*)`
const componentPattern = `(?:${numericPattern}|[xX*])`
const prereleasePattern = String.raw`(?:${numericPattern}|\d*[A-Za-z-][\dA-Za-z-]*)`
const releasePattern = String.raw`${numericPattern}\.${numericPattern}\.${numericPattern}`
const versionPattern = String.raw`v?(?:${componentPattern}(?:\.${componentPattern}){0,2}|${releasePattern}(?:-${prereleasePattern}(?:\.${prereleasePattern})*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?)`
const comparatorPattern = String.raw`(?:[<>]=?|[~^]|=)?\s*${versionPattern}`
const engineRangePattern = new RegExp(
  String.raw`^(?:${comparatorPattern})(?:\s+${comparatorPattern})*$|^${versionPattern}\s+-\s+${versionPattern}$`,
)
const installers = new Map([
  ["esbuild", { version: "0.28.2", args: ["install.js"] }],
  [
    "koffi",
    {
      version: "3.3.1",
      args: ["./cnoke.cjs", "-P", ".", "-D", "src/koffi", "--prebuild", "--release"],
    },
  ],
])

export function parseOptions(args) {
  const options = { production: false, lockfileOnly: false, filters: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--production" && !options.production) {
      options.production = true
    } else if (arg === "--lockfile-only" && !options.lockfileOnly) {
      options.lockfileOnly = true
    } else if (arg === "--filter") {
      const filter = args[++i]
      if (
        !filter ||
        filter.startsWith("-") ||
        [...filter].some((char) => char.codePointAt(0) < 32)
      ) {
        throw new Error("--filter requires a workspace selector")
      }
      options.filters.push(filter)
    } else {
      throw new Error(`Unsupported install argument: ${arg}`)
    }
  }
  return options
}

export function installArguments(options) {
  return [
    "--no-env-file",
    "install",
    "--ignore-scripts",
    "--linker=hoisted",
    options.lockfileOnly ? "--lockfile-only" : "--frozen-lockfile",
    ...(options.production ? ["--production"] : []),
    ...options.filters.flatMap((filter) => ["--filter", filter]),
  ]
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
}

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

function inside(root, path) {
  const part = relative(root, path)
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

// Hoisted package directories and workspace links are supported. Do not silently
// skip an unknown store or external link: it could hide an unvalidated installer.
export function installedPackages(root, workspaceDirectories = []) {
  const packages = []
  const seen = new Map([[root, null]])
  function visitPackage(path, locator) {
    const directory = realpathSync(path)
    if (!inside(root, directory) || !statSync(directory).isDirectory()) {
      throw new Error(`Unsupported package layout: ${path}`)
    }
    if (seen.has(directory)) {
      seen.get(directory)?.locators.add(locator)
      return
    }
    const pkg = manifest(directory)
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
      throw new Error(`Invalid installed package: ${directory}`)
    }
    const entry = { directory, manifest: pkg, locators: new Set([locator]) }
    seen.set(directory, entry)
    packages.push(entry)
    visitModules(join(directory, "node_modules"), locator)
  }
  function validateCache(path) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new Error(`Unsupported cache layout: ${path}`)
    }
    for (const name of readdirSync(path)) {
      const entry = join(path, name)
      if (name === "node_modules" || lstatSync(entry).isSymbolicLink()) {
        throw new Error(`Unsupported cache layout: ${entry}`)
      }
      if (name === "package.json") {
        const pkg = manifest(path)
        // Vite can write {"type":"module"} to a generated-code cache.
        if (Object.keys(pkg).some((key) => key !== "type")) {
          throw new Error(`Package hidden in tool cache: ${path}`)
        }
      }
      if (statSync(entry).isDirectory()) validateCache(entry)
    }
  }
  function visitModules(path, parent = "") {
    if (!exists(path)) return
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Unsupported node_modules link: ${path}`)
    }
    for (const name of readdirSync(path).sort()) {
      if (name === ".bin") continue
      const entry = join(path, name)
      if (name === ".package-lock.json" && lstatSync(entry).isFile()) continue
      if (cacheDirectories.has(name)) {
        validateCache(entry)
        continue
      }
      if (name.startsWith(".")) {
        throw new Error(`Unsupported package store: ${join(path, name)}`)
      }
      // Bun's hoisted lock locators omit node_modules and retain scope segments.
      const locator = parent ? `${parent}/${name}` : name
      if (name.startsWith("@")) {
        const scope = join(path, name)
        if (lstatSync(scope).isSymbolicLink()) {
          throw new Error(`Unsupported scope link: ${scope}`)
        }
        for (const member of readdirSync(scope).sort()) {
          visitPackage(join(scope, member), `${locator}/${member}`)
        }
      } else {
        visitPackage(join(path, name), locator)
      }
    }
  }
  visitModules(join(root, "node_modules"))
  for (const directory of workspaceDirectories) {
    visitPackage(directory, manifest(directory).name)
  }
  return packages
}

function workspaces(root, pkg) {
  if (pkg.workspaces === undefined) return []
  if (!Array.isArray(pkg.workspaces)) {
    throw new Error("Expected an array of workspace patterns")
  }
  const directories = new Set()
  for (const pattern of pkg.workspaces) {
    if (typeof pattern !== "string" || isAbsolute(pattern)) {
      throw new Error("Invalid workspace pattern")
    }
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({
      cwd: root,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const directory = realpathSync(join(root, dirname(file)))
      if (!inside(root, directory) || directory.includes(`${sep}node_modules${sep}`)) {
        throw new Error(`Unsupported workspace: ${directory}`)
      }
      directories.add(directory)
    }
  }
  return [...directories]
}

function validateEngines(pkg, directory, runtime) {
  // npm/yarn engines describe other package managers, not the runtime in use.
  for (const [engine, version] of Object.entries(runtime)) {
    const range = pkg.engines?.[engine]
    if (
      range !== undefined &&
      (typeof range !== "string" ||
        (range.trim() !== "" &&
          !range.split("||").every((part) => engineRangePattern.test(part.trim()))) ||
        !Bun.semver.satisfies(version, range))
    ) {
      throw new Error(`Unsupported ${engine} engine ${pkg.name}: ${range} in ${directory}`)
    }
  }
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Root allowScripts policy is required")
  }
  const supported = new Set(
    [...installers].map(([name, installer]) => `${name}@${installer.version}`),
  )
  for (const [name, enabled] of Object.entries(policy)) {
    if (typeof enabled !== "boolean" || (enabled && !supported.has(name))) {
      throw new Error(`Unsupported allowScripts entry: ${name}`)
    }
  }
}

function sourceFile(directory, file) {
  const path = realpathSync(join(directory, file))
  if (!inside(directory, path) || !statSync(path).isFile()) {
    throw new Error(`Unsupported installer source: ${path}`)
  }
  return path
}

// Await every child, forward termination to its process group, and remove any
// descendants when the direct child exits. No shell interprets package scripts.
async function run(command, args, { cwd, env, capture = false }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  })
  let output = ""
  let interrupted
  let terminated = false
  const kill = (signal) => {
    if (!child.pid || terminated) return
    try {
      if (process.platform === "win32") child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
    terminated = true
  }
  const onInt = () => {
    interrupted = 130
    kill("SIGKILL")
  }
  const onTerm = () => {
    interrupted = 143
    kill("SIGKILL")
  }
  process.on("SIGINT", onInt)
  process.on("SIGTERM", onTerm)
  if (capture) child.stdout.setEncoding("utf8").on("data", (data) => (output += data))
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", () => kill("SIGKILL"))
      child.once("close", (code, signal) => {
        if (code === 0 && !interrupted) resolve()
        else {
          const error = new Error(`${command} failed (${signal ?? code})`)
          error.exitCode = interrupted ?? (code || 1)
          reject(error)
        }
      })
    })
    return output
  } finally {
    process.off("SIGINT", onInt)
    process.off("SIGTERM", onTerm)
    kill("SIGKILL")
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (globalThis.Bun?.version !== bunVersion) {
    throw new Error(`Bun ${bunVersion} is required`)
  }
  const root = realpathSync(process.cwd())
  const pkg = manifest(root)
  if (pkg.packageManager !== `bun@${bunVersion}`) {
    throw new Error(`Root packageManager must be bun@${bunVersion}`)
  }
  validatePolicy(pkg.allowScripts)
  const prepare = !options.production && !options.lockfileOnly && pkg.scripts?.prepare
  if (
    prepare &&
    prepare !== "husky" &&
    prepare !== "if command -v husky >/dev/null 2>&1; then husky; fi"
  ) {
    throw new Error("Only the root Husky prepare script is supported")
  }
  const nodePath = Bun.which("node")
  if (!nodePath) throw new Error("External Node.js >=26 is required before install")
  const node = realpathSync(nodePath)
  const env = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}` }
  const probe = JSON.parse(
    await run(
      node,
      [
        "-p",
        "JSON.stringify({node:process.versions.node,bun:process.versions.bun,execPath:process.execPath})",
      ],
      { cwd: root, env, capture: true },
    ),
  )
  if (
    probe.bun ||
    typeof probe.node !== "string" ||
    !Bun.semver.satisfies(probe.node, ">=26") ||
    realpathSync(probe.execPath) !== node
  ) {
    throw new Error("External Node.js >=26 is required before install")
  }
  const runtime = { node: probe.node, bun: Bun.version }
  validateEngines(pkg, root, runtime)
  await run(process.execPath, installArguments(options), { cwd: root, env })
  if (options.lockfileOnly) return

  const { default: lock } = await import(pathToFileURL(join(root, "bun.lock")).href, {
    with: { type: "jsonc" },
  })
  const packages = installedPackages(root, workspaces(root, pkg))
  const lockedIdentities = (entry) =>
    [...entry.locators].map((locator) => {
      const tuple = Object.hasOwn(lock.packages, locator) && lock.packages[locator]
      return Array.isArray(tuple) ? tuple[0] : undefined
    })
  const commands = []
  // Queue commands without running them: the complete physical graph, including
  // denied and unlisted packages, must pass validation before any setup executes.
  for (const entry of packages) {
    validateEngines(entry.manifest, entry.directory, runtime)
    const { name, version } = entry.manifest
    const installer = installers.get(name)
    const identity = `${name}@${version}`
    const identities = lockedIdentities(entry)
    // Also check locked native packages whose archive forged a non-native name.
    const lockedNative = identities.some(
      (id) => typeof id === "string" && installers.has(id.slice(0, id.lastIndexOf("@"))),
    )
    if (!installer && !lockedNative) continue
    if (installer && version !== installer.version) {
      throw new Error(`Unapproved installer version: ${name}@${version} in ${entry.directory}`)
    }
    if (!installer || identities.some((id) => id !== identity)) {
      throw new Error(
        `Locked installer identity mismatch: ${identity} at ${[...entry.locators].join(", ")} in ${entry.directory}`,
      )
    }
    if (pkg.allowScripts[`${name}@${version}`] === true && pkg.allowScripts[name] !== false) {
      const [file, ...args] = installer.args
      commands.push({ cwd: entry.directory, args: [sourceFile(entry.directory, file), ...args] })
    }
  }
  if (prepare) {
    const husky = join(root, "node_modules/husky")
    if (!exists(husky)) {
      if (prepare === "husky") throw new Error("Root Husky installation is required for prepare")
      // Filtered Docker installs omit root tools; the original prepare is optional.
    } else {
      const directory = realpathSync(husky)
      const entry = packages.find(
        (entry) => entry.directory === directory && entry.manifest.name === "husky",
      )
      if (!entry) throw new Error("Root Husky installation is required for prepare")
      if (lockedIdentities(entry).some((id) => id !== `husky@${entry.manifest.version}`)) {
        throw new Error("Locked Husky identity mismatch")
      }
      commands.push({ cwd: root, args: [sourceFile(directory, "bin.js")] })
    }
  }
  for (const command of commands) {
    await run(node, command.args, { cwd: command.cwd, env })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = error.exitCode || 1
  })
}
