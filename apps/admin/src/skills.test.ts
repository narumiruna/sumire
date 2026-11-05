import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Inventory } from "./api.js"
import { Skills, skillNames, skillPurpose } from "./skills.js"

const inventory: Inventory = {
  tools: [],
  providers: [],
  mcp: [],
  skills: [
    { name: "loaded", description: "Read a document" },
    { name: "unselected", description: "<script>untrusted</script>" },
  ],
}

describe("skills workspace", () => {
  it("retains loaded, removed, default, and explicit chat names without duplicates", () => {
    const saved = initialPolicy()
    saved.skills = ["removed", "loaded"]
    saved.defaults.skills = ["default-only"]
    saved.chats["43"] = { ...inherited, enabled: false, skills: ["chat-only"] }
    const draft = initialPolicy()
    draft.skills = ["draft"]
    draft.chats["42"] = { ...inherited, enabled: true, skills: ["explicit"] }
    expect(skillNames(draft, saved, inventory)).toEqual([
      "chat-only",
      "default-only",
      "draft",
      "explicit",
      "loaded",
      "removed",
      "unselected",
    ])
  })

  it("shows unavailable retained selections and renders descriptions as text", () => {
    const policy = initialPolicy()
    policy.defaults.skills = ["missing"]
    policy.chats["42"] = { ...inherited, enabled: true, skills: ["missing"] }
    const html = renderToStaticMarkup(
      createElement(Skills, {
        policy,
        saved: policy,
        inventory,
        onChange: () => {},
        onChat: () => {},
      }),
    )
    expect(html).toContain("Not loaded")
    expect(html).toContain("Clear retained default and chat selections")
    expect(html).toContain("Chat 42")
    expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("bounds the purpose and keeps complete text in details", () => {
    expect(skillPurpose("First purpose. Full instructions follow.")).toBe("First purpose.")
    expect(skillPurpose("long ".repeat(100))).toHaveLength(140)
    const policy = initialPolicy()
    policy.skills = ["loaded", "missing"]
    policy.defaults.skills = ["loaded", "missing"]
    policy.chats["42"] = { ...inherited, enabled: true }
    policy.chats["43"] = { ...inherited, enabled: true, skills: [] }
    const html = renderToStaticMarkup(
      createElement(Skills, {
        policy,
        saved: policy,
        inventory,
        onChange: () => {},
        onChat: () => {},
      }),
    )
    expect(html).toContain('id="default-skills"')
    expect(html).toContain("Installation instructions")
    expect(html).not.toContain("Show skill setup instructions")
    expect(html).toContain("1 configured chat overrides inherit")
    expect(html).toContain("1 use explicit lists, including empty lists")
    expect(html).toContain("Unavailable: not loaded")
    expect(html).toContain("Skill selection does not grant tool access")
  })
  it("shows an empty inventory without adding tool permissions", () => {
    const policy = initialPolicy()
    const html = renderToStaticMarkup(
      createElement(Skills, {
        policy,
        saved: policy,
        inventory: { tools: [], providers: [], mcp: [] },
        onChange: () => {},
        onChat: () => {},
      }),
    )
    expect(html).toContain("Skill inventory unavailable")
    expect(html).toContain("No retained skill selections.")
    expect(policy.tools).toEqual([])
  })
})
