import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { installArguments, installedPackages, parseOptions } from "./install-dependencies.mjs"

const execute = promisify(execFile)
const wrapper = fileURLToPath(new URL("./install-dependencies.mjs", import.meta.url))
const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8",
}).trim()
assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(), "1.4.4")
const node = realpathSync(process.execPath)
const policy = {
  "@google/genai": false,
  "esbuild@0.28.2": true,
  fsevents: false,
  "koffi@3.3.1": true,
  protobufjs: false,
}

// Minimal regular-file ustar archives keep the registry offline and dependency-free.
function tarball(files) {
  const chunks = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(`package/${name}`, 0, 100)
    for (const [offset, size, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, body.length],
      [136, 12, 0],
    ]) {
      header.write(`${value.toString(8).padStart(size - 1, "0")}\0`, offset, size)
    }
    header.fill(32, 148, 156)
    header.write("0", 156)
    header.write("ustar\0", 257)
    header.write("00", 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8)
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

function marker(hook, exitCode = 0, extra = "") {
  return `const fs = require("node:fs")
const pkg = require("./package.json")
fs.appendFileSync(process.env.MARKER, JSON.stringify({
  name: pkg.name, version: pkg.version, hook: ${JSON.stringify(hook)},
  cwd: process.cwd(), node: process.versions.node, bun: process.versions.bun,
  execPath: process.execPath, args: process.argv.slice(2), path: process.env.PATH
}) + "\\n")
${extra}
process.exitCode = ${exitCode}
`
}

async function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sumire-install-test-")))
  const packages = new Map()
  const archives = new Map()
  const requests = []
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url)
    requests.push(path)
    const archive = archives.get(path)
    const versions = packages.get(path.slice(1))
    const body =
      archive ??
      (versions &&
        Buffer.from(
          JSON.stringify({
            name: path.slice(1),
            "dist-tags": { latest: Object.keys(versions).at(-1) },
            versions,
          }),
        ))
    res.writeHead(body ? 200 : 404, {
      "content-type": archive ? "application/octet-stream" : "application/json",
      connection: "close",
    })
    res.end(body ?? "{}")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false)
  })
  const registry = `http://127.0.0.1:${server.address().port}`
  for (const directory of ["home", "bin", "cache"]) mkdirSync(join(root, directory))
  symlinkSync(node, join(root, "bin/node"))
  const env = {
    HOME: join(root, "home"),
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    TMPDIR: root,
    BUN_INSTALL_CACHE_DIR: join(root, "cache"),
    MARKER: join(root, "markers.jsonl"),
    CI: "1",
    NO_COLOR: "1",
  }
  const pkg = {
    name: "fixture-root",
    version: "1.0.0",
    private: true,
    packageManager: "bun@1.4.4",
    engines: { node: ">=26", bun: "1.4.4" },
    allowScripts: policy,
    trustedDependencies: [],
    dependencies: { esbuild: "0.28.2", koffi: "3.3.1" },
    devDependencies: { husky: "9.1.7" },
    scripts: {
      preinstall: "node forbidden.cjs",
      install: "node forbidden.cjs",
      postinstall: "node forbidden.cjs",
      prepare: "husky",
    },
    ...overrides,
  }
  function json(path, value) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`)
  }
  const save = () => json("package.json", pkg)
  save()
  writeFileSync(join(root, "forbidden.cjs"), marker("forbidden-root"))
  writeFileSync(join(root, ".npmrc"), `registry=${registry}\nengine-strict=true\n`)
  writeFileSync(
    join(root, "bunfig.toml"),
    'env = false\n[install]\nignoreScripts = true\nlinker = "hoisted"\n',
  )
  writeFileSync(join(root, ".env"), "MARKER=/must-not-load-env\nNODE_OPTIONS=--invalid-option\n")
  function add(name, version, fields = {}, options = {}) {
    const data = {
      name,
      version,
      scripts: Object.fromEntries(
        ["preinstall", "install", "postinstall", "prepare"].map((hook) => [
          hook,
          "node forbidden.cjs",
        ]),
      ),
      ...fields,
    }
    const archivePath = `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`
    const body = tarball({
      "package.json": JSON.stringify({ ...data, ...options.archiveMetadata }),
      // Forged metadata must not make two registry identities share archive integrity.
      "fixture-identity.txt": `${name}@${version}\n`,
      "forbidden.cjs": marker("forbidden"),
      "install.js": marker("native-esbuild", options.exitCode, options.extra),
      "cnoke.cjs": marker("native-koffi", options.exitCode),
      "bin.js": marker("prepare", options.exitCode),
    })
    archives.set(archivePath, body)
    const versions = packages.get(name) ?? {}
    versions[version] = {
      ...data,
      dist: {
        tarball: `${registry}${archivePath}`,
        integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
      },
    }
    packages.set(name, versions)
  }
  add("esbuild", "0.28.2")
  add("koffi", "3.3.1")
  add("husky", "9.1.7", { bin: { husky: "bin.js" } })
  async function command(executable, args, customEnv = env) {
    try {
      const result = await execute(executable, args, {
        cwd: root,
        env: customEnv,
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGTERM",
      })
      return { code: 0, output: result.stdout + result.stderr }
    } catch (error) {
      if (typeof error.code !== "number") throw error
      return { code: error.code, output: error.stdout + error.stderr }
    }
  }
  const run = (args = [], customEnv) => command(bun, ["--no-env-file", wrapper, ...args], customEnv)
  const markers = () =>
    existsSync(env.MARKER)
      ? readFileSync(env.MARKER, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  async function lock() {
    const result = await run(["--lockfile-only"])
    assert.equal(result.code, 0, result.output)
    assert.equal(existsSync(join(root, "bun.lock")), true)
    assert.equal(existsSync(join(root, "node_modules")), false)
    assert.deepEqual(markers(), [])
  }
  return { root, pkg, env, add, json, save, command, run, lock, markers, requests }
}

function success(result) {
  assert.equal(result.code, 0, result.output)
  assert.doesNotMatch(result.output, /Usage: bun|Usage: bun install/)
}

function failure(result, pattern) {
  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, pattern)
}

test("argument contract rejects every unsupported or weakening option", () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["--"],
    ["add", "x"],
    ["--ignore-scripts=false"],
    ["--trust"],
    ["--no-save"],
    ["--force"],
    ["--backend", "copyfile"],
    ["--frozen-lockfile"],
    ["--production", "--production"],
    ["--lockfile-only", "--lockfile-only"],
    ["--filter"],
    ["--filter", ""],
    ["--filter", "--help"],
    ["--filter", "a\nb"],
  ])
    assert.throws(() => parseOptions(args))
  assert.deepEqual(installArguments(parseOptions([])), [
    "--no-env-file",
    "install",
    "--ignore-scripts",
    "--linker=hoisted",
    "--frozen-lockfile",
  ])
  assert.deepEqual(
    installArguments(
      parseOptions([
        "--production",
        "--filter",
        "@fixture/a",
        "--filter",
        "@fixture/b",
        "--lockfile-only",
      ]),
    ),
    [
      "--no-env-file",
      "install",
      "--ignore-scripts",
      "--linker=hoisted",
      "--lockfile-only",
      "--production",
      "--filter",
      "@fixture/a",
      "--filter",
      "@fixture/b",
    ],
  )
})

test("exact approved commands only; denied and transitive hooks never execute", async (t) => {
  const f = await fixture(t)
  for (const name of ["@google/genai", "fsevents", "protobufjs", "@fixture/transitive"])
    f.add(name, "1.0.0")
  f.add("koffi", "3.3.1", { dependencies: { "@fixture/transitive": "1.0.0" } })
  Object.assign(f.pkg.dependencies, {
    "@google/genai": "1.0.0",
    fsevents: "1.0.0",
    protobufjs: "1.0.0",
  })
  // Prove CLI suppression remains effective even if Bun's own trust policy differs.
  f.pkg.trustedDependencies = ["esbuild", "koffi", "@google/genai", "@fixture/transitive"]
  f.save()
  await f.lock()
  const before = readFileSync(join(f.root, "bun.lock"), "utf8")
  success(await f.run())
  assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), before)
  const markers = f.markers()
  assert.deepEqual(
    markers.map((m) => [m.name, m.hook]),
    [
      ["esbuild", "native-esbuild"],
      ["koffi", "native-koffi"],
      ["husky", "prepare"],
    ],
  )
  assert.deepEqual(markers[0].args, [])
  assert.deepEqual(markers[1].args, ["-P", ".", "-D", "src/koffi", "--prebuild", "--release"])
  for (const m of markers) {
    assert.equal(m.node, process.versions.node)
    assert.equal(m.bun, undefined)
    assert.equal(realpathSync(m.execPath), node)
    assert.equal(m.path.split(":")[0], dirname(node))
    assert.equal(m.cwd, m.name === "husky" ? f.root : join(f.root, "node_modules", m.name))
  }
  assert.ok(
    f.requests.some((path) => path.includes(".tgz")),
    "fixture packages must actually be fetched",
  )
})

test("allowScripts controls execution without default or name-only trust", async (t) => {
  const f = await fixture(t, { allowScripts: { ...policy, "esbuild@0.28.2": false } })
  await f.lock()
  success(await f.run())
  assert.deepEqual(
    f.markers().map((m) => m.name),
    ["koffi", "husky"],
  )
  for (const allowScripts of [
    undefined,
    { esbuild: true },
    { "other@1.0.0": true },
    { koffi: "true" },
  ]) {
    f.pkg.allowScripts = allowScripts
    f.save()
    failure(await f.run(), /allowScripts/)
  }
})

test("root engine, Bun pin, prepare and arguments fail before install", async (t) => {
  const f = await fixture(t)
  for (const args of [["--help"], ["--trust"], ["--filter", "--help"]]) {
    failure(await f.run(args), /Unsupported|requires a workspace/)
  }
  for (const engines of [
    { node: ">=999" },
    { bun: ">=999" },
    { node: 26 },
    { node: "not-semver" },
    { node: "=>26" },
    { node: ">=26 ||" },
    { node: "|| >=26" },
    { node: ">=26 <" },
    { node: "26.01.0" },
    { node: "26.0.0-rc." },
    { node: "26.0.0-01" },
    { node: "26-rc" },
    { node: ">=26.*-rc" },
  ]) {
    f.pkg.engines = engines
    f.save()
    failure(await f.run(), /engine/)
  }
  f.pkg.engines = { node: ">=26" }
  f.pkg.packageManager = "bun@1.4.3"
  f.save()
  failure(await f.run(), /packageManager/)
  f.pkg.packageManager = "bun@1.4.4"
  f.pkg.scripts.prepare = "husky; node forbidden.cjs"
  f.save()
  failure(await f.run(), /Husky prepare/)
  assert.equal(existsSync(join(f.root, "bun.lock")), false)
  assert.equal(existsSync(join(f.root, "node_modules")), false)
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.markers(), [])
})

test("current Bun mismatch, missing Node and Bun masquerading as Node fail preflight", async (t) => {
  const f = await fixture(t)
  const noNode = { ...f.env, PATH: join(f.root, "empty-bin") }
  mkdirSync(noNode.PATH)
  failure(await f.run([], noNode), /External Node.js/)
  const fakeBin = join(f.root, "bun-node")
  mkdirSync(fakeBin)
  symlinkSync(bun, join(fakeBin, "node"))
  failure(await f.run([], { ...f.env, PATH: fakeBin }), /External Node.js/)
  const mismatch = join(f.root, "mismatch.mjs")
  writeFileSync(
    mismatch,
    `globalThis.Bun = { version: "1.4.3" }; const { main } = await import(${JSON.stringify(new URL("./install-dependencies.mjs", import.meta.url).href)}); await main([])`,
  )
  failure(await f.command(node, [mismatch]), /Bun 1.4.4 is required/)
  assert.deepEqual(f.requests, [])
  assert.equal(existsSync(join(f.root, "bun.lock")), false)
})

test("wrong direct and nested approved versions abort before any installer", async (t) => {
  for (const name of ["esbuild", "koffi"]) {
    await t.test(name, async (t) => {
      const f = await fixture(t)
      const wrong = name === "esbuild" ? "0.28.3" : "3.3.2"
      f.add(name, wrong)
      f.add("@fixture/carrier", "1.0.0", { dependencies: { [name]: wrong } })
      f.pkg.dependencies["@fixture/carrier"] = "1.0.0"
      f.save()
      await f.lock()
      failure(await f.run(), new RegExp(`Unapproved installer version: ${name}@${wrong}`))
      assert.deepEqual(f.markers(), [])
      assert.ok(
        existsSync(
          join(f.root, "node_modules/@fixture/carrier/node_modules", name, "package.json"),
        ),
        "wrong version must actually be nested",
      )
      f.pkg.dependencies[name] = wrong
      f.save()
      success(await f.run(["--lockfile-only"]))
      failure(await f.run(), /Unapproved installer version/)
      assert.deepEqual(f.markers(), [])
    })
  }
})

test("forged direct and nested archive versions cannot authorize native installers", async (t) => {
  for (const name of ["esbuild", "koffi"]) {
    for (const placement of ["direct", "nested", "alias", "nested-alias"]) {
      await t.test(`${name} ${placement}`, async (t) => {
        const f = await fixture(t)
        const approved = f.pkg.dependencies[name]
        const wrong = name === "esbuild" ? "0.28.3" : "3.3.2"
        const nested = placement.startsWith("nested")
        const logical = placement.endsWith("alias") ? "@fixture/native-alias" : name
        const requirement = logical === name ? wrong : `npm:${name}@${wrong}`
        f.add(name, wrong, {}, { archiveMetadata: { version: approved } })
        if (nested) {
          if (logical !== name) f.pkg.dependencies[logical] = `npm:${name}@${approved}`
          f.add("@fixture/carrier", "1.0.0", { dependencies: { [logical]: requirement } })
          f.pkg.dependencies["@fixture/carrier"] = "1.0.0"
        } else {
          f.pkg.dependencies[logical] = requirement
        }
        f.save()
        await f.lock()
        const locator = nested ? `@fixture/carrier/${logical}` : logical
        assert.ok(
          readFileSync(join(f.root, "bun.lock"), "utf8").includes(
            `"${locator}": ["${name}@${wrong}"`,
          ),
          "the frozen identity must retain the unapproved registry version",
        )
        failure(await f.run(), /Locked installer identity mismatch/)
        const directory = nested
          ? join(f.root, "node_modules/@fixture/carrier/node_modules", logical)
          : join(f.root, "node_modules", logical)
        assert.equal(JSON.parse(readFileSync(join(directory, "package.json"))).version, approved)
        assert.deepEqual(f.markers(), [], "no native command or prepare may run")
      })
    }
  }
})

test("name impostors and alias metadata mismatches fail before all approved commands", async (t) => {
  for (const alias of [false, true]) {
    for (const nativeName of [false, true]) {
      await t.test(`alias=${alias} nativeName=${nativeName}`, async (t) => {
        const f = await fixture(t)
        const name = nativeName ? "esbuild" : "@fixture/impostor"
        const version = nativeName ? "0.28.2" : "1.0.0"
        const archiveMetadata = nativeName
          ? { name: "@fixture/impostor" }
          : { name: "esbuild", version: "0.28.2" }
        f.add(name, version, {}, { archiveMetadata })
        if (alias) {
          f.pkg.dependencies["@fixture/alias"] = `npm:${name}@${version}`
          // Avoid Bun sharing a registry identity between two installed locators.
          if (nativeName) delete f.pkg.dependencies.esbuild
        } else {
          f.pkg.dependencies[name] = version
        }
        f.save()
        await f.lock()
        failure(await f.run(), /Locked installer identity mismatch/)
        const locator = alias ? "@fixture/alias" : name
        const actual = JSON.parse(
          readFileSync(join(f.root, "node_modules", locator, "package.json")),
        )
        assert.equal(actual.name, archiveMetadata.name)
        assert.deepEqual(f.markers(), [], "even legitimate native commands must not start")
      })
    }
  }
})

test("Husky prepare rejects forged archive identities before native setup", async (t) => {
  for (const alias of [false, true]) {
    await t.test(alias ? "name impostor" : "forged version", async (t) => {
      const f = await fixture(t)
      const name = alias ? "@fixture/husky-impostor" : "husky"
      const version = alias ? "1.0.0" : "9.1.8"
      f.add(
        name,
        version,
        { bin: { husky: "bin.js" } },
        {
          archiveMetadata: { name: "husky", version: "9.1.7" },
        },
      )
      f.pkg.devDependencies.husky = alias ? `npm:${name}@${version}` : version
      f.save()
      await f.lock()
      failure(await f.run(), /Locked Husky identity mismatch/)
      assert.deepEqual(f.markers(), [], "all native commands must wait for prepare validation")
    })
  }
})

test("valid locked aliases retain native authorization", async (t) => {
  const f = await fixture(t)
  delete f.pkg.dependencies.esbuild
  f.pkg.dependencies["@fixture/esbuild-alias"] = "npm:esbuild@0.28.2"
  f.save()
  await f.lock()
  success(await f.run())
  assert.deepEqual(
    f.markers().map((m) => [m.name, m.hook]),
    [
      ["esbuild", "native-esbuild"],
      ["koffi", "native-koffi"],
      ["husky", "prepare"],
    ],
  )
})

test("approved nested native closure works in package and workspace-local trees", async (t) => {
  for (const workspace of [false, true]) {
    await t.test(workspace ? "workspace" : "scoped package", async (t) => {
      const f = await fixture(t, workspace ? { workspaces: ["packages/*"] } : {})
      f.add("@fixture/other", "1.0.0")
      f.pkg.dependencies.esbuild = "npm:@fixture/other@1.0.0"
      const carrier = {
        name: "@fixture/carrier",
        version: "1.0.0",
        dependencies: { esbuild: "0.28.2", koffi: "3.3.1" },
      }
      if (workspace) {
        f.json("packages/carrier/package.json", carrier)
      } else {
        f.add(carrier.name, carrier.version, { dependencies: carrier.dependencies })
        f.pkg.dependencies[carrier.name] = carrier.version
      }
      f.save()
      await f.lock()
      success(await f.run())
      const native = f.markers().filter((m) => m.hook.startsWith("native-"))
      assert.deepEqual(native.map((m) => m.name).sort(), ["esbuild", "koffi"])
      const parent = workspace ? "packages/carrier" : "node_modules/@fixture/carrier"
      assert.equal(
        native.find((m) => m.name === "esbuild").cwd,
        join(f.root, parent, "node_modules/esbuild"),
      )
    })
  }
})

test("unlocked workspace-local native packages cannot borrow a hoisted identity", async (t) => {
  const f = await fixture(t, { workspaces: ["packages/*"] })
  f.json("packages/a/package.json", { name: "@fixture/a", version: "1.0.0" })
  await f.lock()
  f.json("packages/a/node_modules/esbuild/package.json", { name: "esbuild", version: "0.28.2" })
  failure(await f.run(), /Locked installer identity mismatch/)
  assert.deepEqual(f.markers(), [])
})

test("all dependency engines are checked, including denied scoped transitive packages", async (t) => {
  const f = await fixture(t)
  f.add("@fixture/bad-engine", "1.0.0", { engines: { node: ">=999" } })
  f.add("protobufjs", "1.0.0", { dependencies: { "@fixture/bad-engine": "1.0.0" } })
  f.pkg.dependencies.protobufjs = "1.0.0"
  f.save()
  await f.lock()
  failure(await f.run(), /Unsupported node engine @fixture\/bad-engine/)
  assert.deepEqual(f.markers(), [])
})

test("workspace node_modules are scanned even without a root workspace link", async (t) => {
  const f = await fixture(t, { workspaces: ["packages/*"] })
  f.json("packages/a/package.json", { name: "@fixture/a", version: "1.0.0" })
  await f.lock()
  // An active leftover workspace installation must not evade the full-graph gate.
  f.json("packages/a/node_modules/@fixture/local/package.json", {
    name: "@fixture/local",
    version: "1.0.0",
    engines: { node: ">=999" },
  })
  failure(await f.run(), /Unsupported node engine @fixture\/local/)
  assert.deepEqual(f.markers(), [])
})

test("production is frozen, excludes dev tools and skips root prepare", async (t) => {
  const f = await fixture(t)
  await f.lock()
  const before = readFileSync(join(f.root, "bun.lock"), "utf8")
  success(await f.run(["--production"]))
  assert.equal(existsSync(join(f.root, "node_modules/husky")), false)
  assert.deepEqual(
    f.markers().map((m) => m.name),
    ["esbuild", "koffi"],
  )
  assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), before)
})

test("repeated filters use actual workspace closure and do not run workspace hooks", async (t) => {
  const f = await fixture(t, { workspaces: ["packages/*"] })
  for (const name of ["a", "b", "c"]) {
    f.add(`only-${name}`, "1.0.0")
    f.json(`packages/${name}/package.json`, {
      name: `@fixture/${name}`,
      version: "1.0.0",
      dependencies: { [`only-${name}`]: "1.0.0" },
      scripts: { prepare: "node missing-must-not-run.cjs" },
    })
  }
  await f.lock()
  const before = readFileSync(join(f.root, "bun.lock"), "utf8")
  success(await f.run(["--production", "--filter", "@fixture/a", "--filter", "@fixture/b"]))
  const names = installedPackages(f.root, [
    join(f.root, "packages/a"),
    join(f.root, "packages/b"),
    join(f.root, "packages/c"),
  ]).map((entry) => entry.manifest.name)
  assert.ok(names.includes("only-a"))
  assert.ok(names.includes("only-b"))
  assert.equal(names.includes("only-c"), false)
  assert.equal(names.includes("husky"), false)
  assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), before)
  assert.ok(f.markers().every((m) => m.hook.startsWith("native-")))
})

test("filtered development installs preserve optional root prepare", async (t) => {
  const f = await fixture(t, { workspaces: ["packages/*"] })
  f.pkg.scripts.prepare = "if command -v husky >/dev/null 2>&1; then husky; fi"
  f.save()
  f.json("packages/app/package.json", {
    name: "@fixture/app",
    version: "1.0.0",
    dependencies: { esbuild: "0.28.2", koffi: "3.3.1" },
  })
  await f.lock()
  success(await f.run(["--filter", "@fixture/app"]))
  assert.equal(existsSync(join(f.root, "node_modules/husky")), false)
  assert.deepEqual(
    f.markers().map((m) => m.name),
    ["esbuild", "koffi"],
  )
  f.pkg.scripts.prepare = "husky"
  f.save()
  failure(await f.run(["--filter", "@fixture/app"]), /Root Husky installation is required/)
  assert.equal(f.markers().length, 2, "mandatory prepare must fail before more native commands")
})

test("frozen install rejects changed manifests; lockfile-only updates without graph or hooks", async (t) => {
  const f = await fixture(t)
  await f.lock()
  const before = readFileSync(join(f.root, "bun.lock"), "utf8")
  f.add("new-package", "1.0.0")
  f.pkg.dependencies["new-package"] = "1.0.0"
  f.save()
  failure(await f.run(), /lockfile|frozen/i)
  assert.equal(readFileSync(join(f.root, "bun.lock"), "utf8"), before)
  assert.deepEqual(f.markers(), [])
  // A broken installed graph must be irrelevant to lock-only operations.
  f.json("node_modules/broken/package.json", {
    name: "broken",
    version: "1.0.0",
    engines: { node: ">=999" },
  })
  success(await f.run(["--lockfile-only"]))
  assert.notEqual(readFileSync(join(f.root, "bun.lock"), "utf8"), before)
  assert.deepEqual(f.markers(), [])
})

test("native and Husky failures propagate exact status and stop later commands", async (t) => {
  for (const name of ["esbuild", "husky"]) {
    await t.test(name, async (t) => {
      const f = await fixture(t)
      f.add(name, name === "esbuild" ? "0.28.2" : "9.1.7", {}, { exitCode: 37 })
      await f.lock()
      const result = await f.run()
      assert.equal(result.code, 37, result.output)
      assert.deepEqual(
        f.markers().map((m) => m.name),
        name === "esbuild" ? ["esbuild"] : ["esbuild", "koffi", "husky"],
      )
    })
  }
})

test("installer descendants are terminated on child failure", async (t) => {
  const f = await fixture(t)
  const pidFile = join(f.root, "descendant.pid")
  f.add(
    "esbuild",
    "0.28.2",
    {},
    {
      exitCode: 39,
      extra: `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref()`,
    },
  )
  await f.lock()
  const result = await f.run()
  assert.equal(result.code, 39, result.output)
  const pid = Number(readFileSync(pidFile, "utf8"))
  let alive = true
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      assert.equal(error.code, "ESRCH")
      alive = false
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (alive) process.kill(pid, "SIGKILL")
  assert.equal(alive, false, "installer descendant must not survive the wrapper")
})

test("termination stops the active installer and its descendants before exiting", async (t) => {
  const f = await fixture(t)
  const pidFile = join(f.root, "active.pids")
  f.add(
    "esbuild",
    "0.28.2",
    {},
    {
      extra: `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"}); fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000)`,
    },
  )
  await f.lock()
  const running = execute(bun, ["--no-env-file", wrapper], {
    cwd: f.root,
    env: f.env,
    timeout: 20000,
    killSignal: "SIGTERM",
  })
  // Attach the rejection handler before sending the signal.
  const outcome = running.then(
    () => ({ code: 0 }),
    (error) => error,
  )
  t.after(() => running.child.kill("SIGTERM"))
  for (let attempt = 0; attempt < 1000 && !existsSync(pidFile); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(existsSync(pidFile), true, "native installer must start before cancellation")
  const pids = JSON.parse(readFileSync(pidFile, "utf8"))
  running.child.kill("SIGTERM")
  assert.equal((await outcome).code, 143)
  for (const pid of pids) {
    let alive = true
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        assert.equal(error.code, "ESRCH")
        alive = false
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (alive) process.kill(pid, "SIGKILL")
    assert.equal(alive, false, "cancelled native processes must not survive")
  }
  assert.deepEqual(
    f.markers().map((m) => m.name),
    ["esbuild"],
  )
})

test("repeat installs support npm metadata and known tool caches without hiding packages", async (t) => {
  const f = await fixture(t)
  await f.lock()
  success(await f.run())
  f.json("node_modules/.package-lock.json", { lockfileVersion: 3 })
  for (const directory of [".cache", ".vite", ".vite-temp", ".vitest-cache"]) {
    f.json(`node_modules/${directory}/data/metadata.json`, { result: true })
  }
  f.json("node_modules/.vite/package.json", { type: "module" })
  success(await f.run())
  assert.equal(f.markers().length, 6)
  f.json("node_modules/.cache/hidden/package.json", { name: "esbuild", version: "0.28.3" })
  failure(await f.run(), /Package hidden in tool cache/)
  assert.equal(f.markers().length, 6)
})

test("empty and whitespace engine ranges retain npm wildcard meaning", async (t) => {
  const f = await fixture(t, { engines: { node: "   ", bun: "" } })
  await f.lock()
  success(await f.run())
  assert.equal(f.markers().length, 3)
})

test("unknown stores and external package links fail closed", async (t) => {
  const f = await fixture(t, { dependencies: {}, devDependencies: {}, scripts: {} })
  f.json("node_modules/.bun/hidden/package.json", { name: "hidden", version: "1.0.0" })
  assert.throws(() => installedPackages(f.root), /Unsupported package store/)
  rmSync(join(f.root, "node_modules/.bun"), { recursive: true })
  symlinkSync(resolve(f.root, ".."), join(f.root, "node_modules/external"))
  assert.throws(() => installedPackages(f.root), /Unsupported package layout/)
})
