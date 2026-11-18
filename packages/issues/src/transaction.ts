import type { DatabaseSync } from "node:sqlite"

/** SQLite can roll back automatically (e.g. SQLITE_FULL); cleanup must preserve the initiating error. */
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
      // The caller must receive the original failure, even if connection cleanup also fails.
    }
    throw error
  }
}
