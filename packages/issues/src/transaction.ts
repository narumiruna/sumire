import type { DatabaseSync } from "node:sqlite"

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = work()
    db.exec("COMMIT")
    return result
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK")
    } catch {
      // Preserve the original failure if rollback also fails.
    }
    throw error
  }
}
