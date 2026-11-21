import type { DurableTaskItem } from "@narumitw/sumire-contracts"
import { describe, expect, it } from "vitest"
import { taskParents } from "./durable-tree.js"

const task = (id: number, ownerTaskId?: number): DurableTaskItem => ({
  type: "task",
  id,
  conversationId: 7,
  kind: "pi.tool",
  version: 1,
  status: "terminal",
  background: false,
  abortRequested: false,
  ...(ownerTaskId === undefined ? {} : { ownerTaskId }),
})

describe("bounded task tree grouping", () => {
  it("groups nested tasks and promotes missing parents without discarding records", () => {
    expect([...taskParents([task(1), task(2, 1), task(3, 2), task(4, 99)])]).toEqual([
      [1, undefined],
      [2, 1],
      [3, 2],
      [4, undefined],
    ])
  })
  it("breaks self-cycles, multi-task cycles, and chains into a cycle", () => {
    const parents = taskParents([task(1, 1), task(2, 3), task(3, 2), task(4, 3), task(5)])
    expect([...parents.values()]).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(parents.size).toBe(5)
  })
  it("does not change grouping when a parent appears later in the page", () => {
    expect(taskParents([task(2, 1), task(1)]).get(2)).toBe(1)
  })
})
