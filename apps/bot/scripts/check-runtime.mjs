import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backup } from "node:sqlite"
import { safeFetch } from "@narumitw/sumire-url-reader/network"
import { AdminStore } from "../dist/admin/store.js"
import { AnyDocConverter } from "../dist/documents/converter.js"

// Use temporary state only. No credentials, external requests, or bot startup.
assert.ok(process.versions.bun, "The Docker bot runtime must use Bun")
const root = await mkdtemp(join(tmpdir(), "sumire-runtime-check-"))
let store
let restored
try {
  const file = join(root, "admin.sqlite")
  store = new AdminStore(file, 42)
  const snapshot = store.snapshot()
  snapshot.policy.privateUsers = [42]
  const saved = store.save(snapshot.policy, snapshot.revision, "42")
  assert.equal(saved.revision, snapshot.revision + 1)
  assert.equal(store.db.prepare("SELECT chat_lower(?) AS name").get("BUN").name, "bun")
  assert.equal(store.db.isTransaction, false)

  const copy = join(root, "backup.sqlite")
  await backup(store.db, copy)
  store.close()
  store = undefined
  restored = new AdminStore(copy, 42)
  assert.deepEqual(restored.snapshot(), saved)

  const converter = await AnyDocConverter.create({
    timeoutMs: 10_000,
    maxMarkdownChars: 1_000,
    maxConcurrency: 1,
  })
  const converted = await converter.convert(
    async () => Buffer.from("runtime,result\nBun,passed\n"),
    "runtime.csv",
  )
  assert.equal(converted.format, "csv")
  assert.ok(converted.markdown.includes("Bun"))
  assert.ok(converted.markdown.includes("passed"))

  let lookups = 0
  await assert.rejects(
    safeFetch(
      "https://rebind.invalid/path",
      {},
      {
        resolve: async () => {
          lookups += 1
          return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]
        },
      },
    ),
    /private or non-routable/,
  )
  assert.equal(lookups, 2)
  console.log(
    `Bun ${process.versions.bun}: SQLite persistence/backup, native document child, and DNS rebinding checks passed`,
  )
} finally {
  store?.close()
  restored?.close()
  await rm(root, { recursive: true, force: true })
}
