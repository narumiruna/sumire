import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { describe, expect, it } from "vitest"
import { historyGroups, matchesHistory } from "./durable-history.js"

function entry(
  id: number,
  role?: DurableEntryItem["role"],
  kind = role ? `pi.${role}` : "custom.event",
): DurableEntryItem {
  return {
    type: "entry",
    id,
    conversationId: id < 4 ? 6 : 7,
    kind,
    ...(role ? { role } : {}),
    // Deliberately do not follow creation order.
    timestamp: 10000 - id * 100,
    content: {
      messages: role ? [{ role, content: [{ type: "text", text: `Record ${id}` }] }] : [],
      truncated: false,
    },
  }
}

describe("saved conversation history grouping", () => {
  it("reverses newest-first pages without timestamp sorting or changing ancestor attribution", () => {
    const items = [
      entry(7, "assistant"),
      entry(6, "user"),
      entry(5, "assistant"),
      entry(4, "toolResult"),
      entry(3, "assistant"),
      entry(2, "user"),
      entry(1, "system"),
    ]
    const groups = historyGroups(items)
    expect(
      groups.map((group) => [group.id, group.userTurn, group.entries.map((item) => item.id)]),
    ).toEqual([
      [1, false, [1]],
      [2, true, [2, 3, 4, 5]],
      [6, true, [6, 7]],
    ])
    expect(groups[1]?.entries[0]?.conversationId).toBe(6)
    expect(items.map((item) => item.id)).toEqual([7, 6, 5, 4, 3, 2, 1])
  })

  it("does not treat passive context, compaction, or unknown user-role records as addressed turns", () => {
    const groups = historyGroups([
      entry(6, "assistant"),
      entry(5, "user", "pi.compaction"),
      entry(4, "user", "custom.input"),
      entry(3, "user", "telegram-passive-context"),
      entry(2, "user"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.entries.map((item) => item.id)).toEqual([2, 3, 4, 5, 6])
    expect(groups[0]?.userTurn).toBe(true)
  })

  it("keeps leading records separate without inventing an off-page user", () => {
    expect(historyGroups([])).toEqual([])
    const groups = historyGroups([
      entry(5, "assistant"),
      entry(4, "user"),
      entry(3, "assistant"),
      entry(2),
    ])
    expect(groups.map((group) => [group.id, group.userTurn])).toEqual([
      [2, false],
      [4, true],
    ])
    expect(groups.flatMap((group) => group.entries).map((item) => item.id)).toEqual([2, 3, 4, 5])
  })
})

describe("loaded-page history filters", () => {
  it("matches literal saved content and structured tool metadata without assuming complete history", () => {
    const item = entry(8, "assistant")
    item.content = {
      truncated: true,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Saved reasoning" },
            { type: "toolCall", id: "call-8", name: "read_file", arguments: '{"path":"<script>"}' },
          ],
        },
      ],
    }
    expect(matchesHistory(item, "tools", "READ_FILE")).toBe(true)
    expect(matchesHistory(item, "assistant", "saved reasoning")).toBe(true)
    expect(matchesHistory(item, "all", "<script>")).toBe(true)
    expect(matchesHistory(item, "user", "read_file")).toBe(false)
    expect(matchesHistory(item, "other", "")).toBe(false)
    expect(matchesHistory(item, "all", "missing uncaptured text")).toBe(false)
  })

  it("searches displayed strings without JSON escaping quotes, backslashes, or newlines", () => {
    const item = entry(2, "user")
    const text = 'Path C:\\repo\\file.ts\nsay "hello"'
    item.content = {
      truncated: false,
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    }
    expect(matchesHistory(item, "all", text)).toBe(true)
    expect(matchesHistory(item, "user", 'say "hello"')).toBe(true)
    expect(matchesHistory(item, "user", "C:\\repo\\file.ts")).toBe(true)
  })

  it("preserves tool results, system messages, empty records, and metadata-only responses", () => {
    const tool = entry(9, "toolResult")
    tool.toolName = "lookup"
    expect(matchesHistory(tool, "tools", "lookup")).toBe(true)
    expect(matchesHistory(entry(1, "system"), "other", "")).toBe(true)
    expect(matchesHistory(entry(2), "other", "custom.event")).toBe(true)
    const metadataOnly = { ...entry(3, "assistant"), content: undefined }
    expect(matchesHistory(metadataOnly, "assistant", "pi.assistant")).toBe(true)
    expect(matchesHistory(metadataOnly, "all", "   ")).toBe(true)
  })
})
