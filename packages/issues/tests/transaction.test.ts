import { DatabaseSync } from "node:sqlite"
import { expect, it, vi } from "vitest"
import { transaction } from "../src/transaction.js"

it("preserves the initiating SQLite error when SQLite has already rolled back", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec(
      "CREATE TABLE items (id INTEGER); CREATE TRIGGER capacity BEFORE INSERT ON items BEGIN SELECT RAISE(ROLLBACK, 'capacity exhausted'); END",
    )
    let original: unknown
    expect(() =>
      transaction(db, () => {
        try {
          db.prepare("INSERT INTO items VALUES (1)").run()
        } catch (error) {
          original = error
          throw error
        }
      }),
    ).toThrow("capacity exhausted")
    expect(original).toBeInstanceOf(Error)
    expect(db.isTransaction).toBe(false)
    expect(db.prepare("SELECT * FROM items").all()).toEqual([])
  } finally {
    db.close()
  }
})
it("keeps the original failure if rollback cleanup also fails", () => {
  const db = new DatabaseSync(":memory:")
  const exec = db.exec.bind(db)
  const original = new Error("original audit/storage failure")
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "ROLLBACK") throw new Error("cleanup failed")
    exec(sql)
  })
  try {
    expect(() =>
      transaction(db, () => {
        throw original
      }),
    ).toThrow(original)
    expect(db.isTransaction).toBe(true)
  } finally {
    spy.mockRestore()
    if (db.isTransaction) db.exec("ROLLBACK")
    db.close()
  }
})
