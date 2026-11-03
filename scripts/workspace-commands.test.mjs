import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const root = path.resolve(import.meta.dirname, "..")

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-workspace-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  function put(name, content) {
    const file = path.join(directory, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
  }
  put("package.json", { private: true, workspaces: ["packages/*"] })
  put("bunfig.toml", readFileSync(path.join(root, "bunfig.toml"), "utf8"))
  put(
    "mark.mjs",
    'import {appendFileSync,writeFileSync} from "node:fs"; import path from "node:path"; if(process.argv.length!==3)throw new Error("Unexpected compiler arguments"); const root=path.resolve(import.meta.dirname); appendFileSync(path.join(root,"markers"),process.argv[2]+"\\n"); if(process.argv[2]==="compile")writeFileSync(path.join(root,"built"),"ready");',
  )
  put("packages/base/package.json", {
    name: "fixture-base",
    scripts: {
      prebuild: "node ../../mark.mjs pre",
      build: "bun run build:compile",
      "build:compile": "node ../../mark.mjs compile",
      postbuild: "node ../../mark.mjs post",
    },
  })
  put(
    "require-build.mjs",
    'import {accessSync} from "node:fs"; accessSync(new URL("./built",import.meta.url));',
  )
  put("packages/app/package.json", {
    name: "fixture-app",
    scripts: {
      prebuild: "bun run --filter fixture-base build",
      build: "node ../../require-build.mjs",
      fail: 'node -e "process.exit(7)"',
    },
  })
  put("packages/empty/package.json", { name: "fixture-empty" })
  return { directory, put }
}

function run(directory, args) {
  const result = spawnSync("bun", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  })
  assert.ifError(result.error)
  return result
}

function succeeds(result) {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /Usage: bun run/)
}

test("Bun workspace builds retain dependency hooks and skip missing scripts", (t) => {
  const { directory } = fixture(t)
  const result = run(directory, ["run", "--workspaces", "--if-present", "--sequential", "build"])
  succeeds(result)
  const markers = readFileSync(path.join(directory, "markers"), "utf8").trim().split("\n")
  assert.deepEqual(markers, ["pre", "compile", "post", "pre", "compile", "post"])
})

test("compile-only entrypoint does not execute build lifecycle hooks", (t) => {
  const { directory } = fixture(t)
  succeeds(run(directory, ["run", "--filter", "fixture-base", "build:compile"]))
  assert.equal(readFileSync(path.join(directory, "markers"), "utf8"), "compile\n")
})

test("focused test arguments do not reach dependency hooks", (t) => {
  const { directory, put } = fixture(t)
  const bot = JSON.parse(readFileSync(path.join(root, "apps/bot/package.json"), "utf8"))
  put("packages/app/package.json", {
    name: "fixture-app",
    scripts: {
      pretest: bot.scripts.pretest,
      "build:dependencies": "bun run --filter fixture-base build",
      test: "node ../../test-args.mjs",
    },
  })
  put("test-args.mjs", "console.log(JSON.stringify(process.argv.slice(2)))")
  const result = run(directory, ["run", "--filter", "fixture-app", "test", "tests/only.test.ts"])
  succeeds(result)
  assert.match(result.stdout, /\["tests\/only\.test\.ts"\]/)
  assert.equal(readFileSync(path.join(directory, "markers"), "utf8"), "pre\ncompile\npost\n")
})

test("workspace failures reach the caller", (t) => {
  const { directory } = fixture(t)
  assert.equal(run(directory, ["run", "--filter", "fixture-app", "fail"]).status, 7)
})

test("Node.js shebang tools stay on Node.js", (t) => {
  const { directory, put } = fixture(t)
  put("package.json", { scripts: { probe: "runtime-probe" } })
  put(
    "node_modules/.bin/runtime-probe",
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({bun:!!process.versions.bun,node:process.versions.node}));\n",
  )
  // A real executable verifies the runner, not an explicit node command in the script.
  chmodSync(path.join(directory, "node_modules/.bin/runtime-probe"), 0o755)
  const result = run(directory, ["run", "probe"])
  succeeds(result)
  const runtime = JSON.parse(result.stdout.trim())
  assert.equal(runtime.bun, false)
  assert.equal(runtime.node, process.versions.node)
})

test("bot commands load only root .env and preserve external values", (t) => {
  const { directory, put } = fixture(t)
  const bot = JSON.parse(readFileSync(path.join(root, "apps/bot/package.json"), "utf8"))
  put("apps/bot/package.json", { scripts: { start: bot.scripts.start, dev: bot.scripts.dev } })
  const probe =
    "console.log(JSON.stringify({value:process.env.SUMIRE_ENV_FIXTURE??null,bun:!!process.versions.bun,cwd:process.cwd()}));"
  put("apps/bot/dist/index.js", probe)
  put("apps/bot/src/index.ts", probe)
  put(".env.local", "SUMIRE_ENV_FIXTURE=local\n")
  put("apps/bot/.env", "SUMIRE_ENV_FIXTURE=workspace\n")
  put(".env", "SUMIRE_ENV_FIXTURE=root\n")
  for (const script of ["start", "dev"]) {
    const result = run(path.join(directory, "apps/bot"), ["run", script])
    succeeds(result)
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      value: "root",
      bun: true,
      cwd: realpathSync(directory),
    })
  }
  rmSync(path.join(directory, ".env"))
  const missing = run(path.join(directory, "apps/bot"), ["run", "start"])
  succeeds(missing)
  assert.equal(JSON.parse(missing.stdout.trim()).value, null)
  put(".env", "PATH=/not-used\nSUMIRE_ENV_FIXTURE=root\n")
  const external = spawnSync("bun", ["run", "start"], {
    cwd: path.join(directory, "apps/bot"),
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, SUMIRE_ENV_FIXTURE: "external" },
  })
  succeeds(external)
  assert.equal(JSON.parse(external.stdout.trim()).value, "external")
})
