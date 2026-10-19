import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { AdminStore } from "../src/admin/store.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sumire-chat-metadata-"))
  const store = new AdminStore(path.join(root, "admin.sqlite"), 42)
  cleanups.push(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return store
}

it("merges each observed field independently and keeps bootstrap metadata insert-only", async () => {
  const store = await fixture()
  const before = store.snapshot()
  store.observe(-100, "supergroup", " Known name ")
  for (const name of [undefined, "", "  ", "-100", " -100 "]) {
    store.observe(-100, undefined, name)
    store.observe(-100, "group", name, "inferred")
    expect(store.listChats(0)).toEqual([{ id: -100, type: "supergroup", name: "Known name" }])
  }
  store.observe(-100, "  ", "Renamed")
  expect(store.listChats(0)).toEqual([{ id: -100, type: "supergroup", name: "Renamed" }])
  store.observe(-100, "channel")
  expect(store.listChats(0)).toEqual([{ id: -100, type: "channel", name: "Renamed" }])
  expect(store.snapshot()).toEqual(before)
  expect(store.allows(-100)).toBe(false)
  expect(store.listAudit(0)).toEqual([])
  expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 })
})

it("reads legacy blank and ID-only rows without a rewrite and accepts later observed metadata", async () => {
  const store = await fixture()
  store.db.prepare("INSERT INTO chats VALUES (?,?,?)").run(-100, "group", "-100")
  store.db.prepare("INSERT INTO chats VALUES (?,?,?)").run(-200, "", "  ")
  store.observe(-100, "group", "-100", "inferred")
  expect(store.listChats(0)).toEqual([
    { id: -200, type: "", name: "  " },
    { id: -100, type: "group", name: "-100" },
  ])
  store.observe(-100, "supergroup", "Recovered by observation")
  store.observe(-200, "channel", "Observed channel")
  expect(store.listChats(0)).toEqual([
    { id: -200, type: "channel", name: "Observed channel" },
    { id: -100, type: "supergroup", name: "Recovered by observation" },
  ])
})

it("preserves JavaScript case-insensitive name matching for Unicode names", async () => {
  const store = await fixture()
  store.observe(-100, "group", "Müller")
  store.observe(-200, "group", "Ελληνικά")
  store.observe(-300, "group", "團隊名稱")
  for (const [query, id] of [
    ["MÜLLER", -100],
    ["εΛΛΗΝΙΚΆ", -200],
    ["團隊", -300],
  ] as const)
    expect(store.listChats(0, { q: query })).toEqual([expect.objectContaining({ id })])
})

it("retains directory capacity and field bounds while allowing existing chats to update", async () => {
  const store = await fixture()
  for (const id of [0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    store.observe(id, "group", "bad")
  expect(store.listChats(0)).toEqual([])
  for (let id = 1; id <= 1000; id++) store.observe(id, "private", String(id), "inferred")
  store.observe(1001, "private", "Over capacity")
  store.observe(1, "t".repeat(100), "n".repeat(200))
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM chats").get()).toMatchObject({ n: 1000 })
  expect(store.listChats(0)[0]).toEqual({ id: 1, type: "t".repeat(32), name: "n".repeat(128) })
  expect(store.listChats(1000)).toEqual([])
})
