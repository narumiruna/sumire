import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialPolicy } from "../../src/admin/policy.js"
import { AdminStore } from "../../src/admin/store.js"

const stores = new Set<TestAdminStore>()
const roots = new Set<string>()

/** Explicit fixture seeding only. Production constructors always start with empty access. */
export class TestAdminStore extends AdminStore {
  private closed = false
  constructor(file: string, ids: ReadonlySet<number>, adminId = 42) {
    const existed = existsSync(file)
    super(file, adminId)
    const policy = this.snapshot().policy
    // Never reseed an existing fixture database after a restart.
    if (!existed) {
      policy.privateUsers = [...ids].filter((id) => id > 0)
      policy.groups = [...ids].filter((id) => id < 0)
      this.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(policy))
    }
    stores.add(this)
  }
  override close() {
    if (this.closed) return
    this.closed = true
    stores.delete(this)
    super.close()
  }
}

export function approvedStore(ids: number[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sumire-policy-fixture-"))
  roots.add(root)
  const store = new TestAdminStore(path.join(root, "admin.sqlite"), new Set(ids), 7)
  const policy = store.snapshot().policy
  policy.models = [
    "test/plain",
    "test/reasoner",
    "other/reasoner",
    "anthropic/claude-sonnet-4",
    "openrouter/anthropic/claude-sonnet-4",
  ]
  policy.defaults.models = [...policy.models]
  store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(policy))
  store.applied(1, true)
  return store
}

export function closeTestStores() {
  for (const store of [...stores]) store.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
}

export function testPolicy(ids: ReadonlySet<number>) {
  return {
    ...initialPolicy(),
    privateUsers: [...ids].filter((id) => id > 0),
    groups: [...ids].filter((id) => id < 0),
  }
}
