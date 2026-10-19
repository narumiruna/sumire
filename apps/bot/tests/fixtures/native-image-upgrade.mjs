import assert from "node:assert/strict"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createPiFixture, toolResultText } from "../helpers/pi-fixture.ts"

// Run in disposable build-stage images with --network=none and /fixtures mounted.
// Use the matching image's source and helper: seed/rollback use the old image.
const [mode, directory = "/fixtures"] = process.argv.slice(2)
assert.ok(["seed", "upgrade", "rollback"].includes(mode))
const fixture = await createPiFixture()
try {
  const durable = path.join(fixture.settings.botSessionLogDir, "123", "durable")
  const backup = path.join(directory, "baseline")
  if (mode !== "seed") {
    await mkdir(path.dirname(durable), { recursive: true })
    await cp(backup, durable, { recursive: true })
  }
  const session = await fixture.createSession()
  if (mode === "seed") {
    assert.equal((await fixture.script(session, "store('marker', 1)")).isError, false)
    const checkpoint = session.getCheckpoint()
    assert.ok(checkpoint)
    assert.equal((await fixture.script(session, "store('marker', 2)")).isError, false)
    fixture.enqueueAnswer("Pending fixture answer")
    await session.prompt("pending fixture response", {
      delivery: { sourceMessageId: 71, statusMessageId: 72, mode: "default" },
    })
    // Disposal closes SQLite before the consistent directory copy.
    await session.dispose()
    await mkdir(directory, { recursive: true })
    await cp(durable, backup, { recursive: true })
    await writeFile(path.join(directory, "checkpoint.json"), JSON.stringify({ checkpoint }))
  } else {
    let deliveries = 0
    await session.recoverPending(async (answer) => {
      assert.equal(answer.text, "Pending fixture answer")
      assert.ok(answer.requestId)
      await session.acknowledge(answer.requestId)
      deliveries++
    })
    assert.equal(deliveries, 1)
    assert.equal(fixture.requests.length, 0)
    assert.match(
      toolResultText(await fixture.script(session, "return load('marker')")),
      /(?:^|\n)2$/,
    )
    const { checkpoint } = JSON.parse(
      await readFile(path.join(directory, "checkpoint.json"), "utf8"),
    )
    await session.restoreBranch(checkpoint)
    assert.match(
      toolResultText(await fixture.script(session, "return load('marker')")),
      /(?:^|\n)1$/,
    )
    await session.dispose()
    if (mode === "upgrade") await cp(durable, path.join(directory, "upgraded"), { recursive: true })
  }
  console.log(
    `Native image ${mode} passed: consistent state, historical branch, and pending delivery.`,
  )
} finally {
  await fixture.cleanup()
}
