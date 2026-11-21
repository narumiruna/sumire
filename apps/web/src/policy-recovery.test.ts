import { inherited, initialPolicy, type Policy } from "@narumitw/sumire-policy"
import { afterEach, describe, expect, it } from "vitest"
import { setLocale } from "./i18n.js"
import { recoverPolicy } from "./policy-recovery.js"

function policies() {
  const base = initialPolicy()
  return { base, draft: structuredClone(base), latest: structuredClone(base) }
}

describe("localized policy recovery", () => {
  afterEach(() => setLocale("en"))

  it.each([
    {
      locale: "zh-TW",
      labels: [
        "全域工具可用性",
        "全域技能可用性",
        "全域 MCP 可用性",
        "全域模型可用性",
        "私人訊息存取權",
        "群組與頻道存取權",
        "供應商設定與順序",
        "GitHub 提及作者",
        "共用預設值：已授權的工具",
        "共用預設值：已啟用的技能",
        "共用預設值：已授權的 MCP 伺服器",
        "共用預設值：允許的模型",
        "共用預設值：模型",
        "共用預設值：思考層級",
        "聊天 42 設定",
      ],
    },
    {
      locale: "ja",
      labels: [
        "グローバルなツールの利用可否",
        "グローバルなスキルの利用可否",
        "グローバルな MCP の利用可否",
        "グローバルなモデルの利用可否",
        "ダイレクトメッセージのアクセス権",
        "グループとチャンネルのアクセス権",
        "プロバイダーの設定と順序",
        "GitHub メンションの投稿者",
        "共通の既定値：許可されたツール",
        "共通の既定値：有効なスキル",
        "共通の既定値：許可された MCP サーバー",
        "共通の既定値：許可されたモデル",
        "共通の既定値：モデル",
        "共通の既定値：思考レベル",
        "チャット 42 の設定",
      ],
    },
  ] as const)("uses $locale labels without changing recovery values, IDs, or choices", (text) => {
    const { base, draft, latest } = policies()
    for (const key of ["tools", "skills", "servers", "models"] as const) {
      draft[key] = ["local-value"]
      latest[key] = ["saved-value"]
      draft.defaults[key] = ["local-value"]
      latest.defaults[key] = ["saved-value"]
    }
    draft.privateUsers = [42]
    latest.privateUsers = [43]
    draft.groups = [-42]
    latest.groups = [-43]
    draft.providers = [{ id: "local-provider", enabled: true, models: [] }]
    latest.providers = [{ id: "saved-provider", enabled: false, models: [] }]
    draft.githubNotifications.allowedUsernames = ["octocat"]
    latest.githubNotifications.allowedUsernames = ["hubot"]
    draft.defaults.model = "local-provider/model"
    latest.defaults.model = "saved-provider/model"
    draft.defaults.thinking = "high"
    latest.defaults.thinking = "low"
    draft.chats["42"] = { ...inherited, tools: [], enabled: true }
    latest.chats["42"] = { ...inherited, enabled: false }
    const original = structuredClone({ base, draft, latest })
    const english = recoverPolicy(base, draft, latest)
    const choices = Object.fromEntries(english.changes.map(({ id }) => [id, "draft" as const]))
    const chosen = recoverPolicy(base, draft, latest, choices)

    setLocale(text.locale)
    const result = recoverPolicy(base, draft, latest)
    expect(result.changes.map(({ label }) => label)).toEqual(text.labels)
    expect(result.policy).toEqual(english.policy)
    expect(result.unresolved).toBe(15)
    expect(result.changes.map(({ label: _, ...change }) => change)).toEqual(
      english.changes.map(({ label: _, ...change }) => change),
    )
    const resolved = recoverPolicy(base, draft, latest, choices)
    expect(resolved.policy).toEqual(chosen.policy)
    expect(resolved.policy).toEqual(draft)
    expect(resolved.unresolved).toBe(0)
    expect({ base, draft, latest }).toEqual(original)

    setLocale("en")
    expect(recoverPolicy(base, draft, latest)).toEqual(english)
  })
})

describe("policy recovery", () => {
  it("recovers mention author edits without unioning concurrent grants or revocations", () => {
    const { base, draft, latest } = policies()
    base.githubNotifications.allowedUsernames = ["octocat"]
    draft.githubNotifications.allowedUsernames = []
    latest.githubNotifications.allowedUsernames = ["octocat", "hubot"]
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(1)
    expect(result.changes[0]).toMatchObject({
      id: "githubNotifications",
      label: "GitHub mention authors",
      state: "conflict",
    })
    expect(result.policy.githubNotifications.allowedUsernames).toEqual(["octocat", "hubot"])
    expect(
      recoverPolicy(base, draft, latest, { githubNotifications: "draft" }).policy
        .githubNotifications.allowedUsernames,
    ).toEqual([])
    latest.githubNotifications.allowedUsernames = ["octocat"]
    expect(recoverPolicy(base, draft, latest).policy.githubNotifications.allowedUsernames).toEqual(
      [],
    )
  })
  it("keeps concurrent values outside local edits", () => {
    const { base, draft, latest } = policies()
    draft.defaults.thinking = "high"
    latest.privateUsers = [42]
    latest.chats["42"] = { ...inherited, enabled: false }
    const result = recoverPolicy(base, draft, latest)
    expect(result.policy.privateUsers).toEqual([42])
    expect(result.policy.chats["42"]?.enabled).toBe(false)
    expect(result.policy.defaults.thinking).toBe("high")
    expect(result.unresolved).toBe(0)
    expect(result.changes.map((change) => change.id)).toEqual(["defaults.thinking"])
  })

  it("requires an explicit choice for overlapping changes", () => {
    const { base, draft, latest } = policies()
    draft.defaults.thinking = "high"
    latest.defaults.thinking = "low"
    const unresolved = recoverPolicy(base, draft, latest)
    expect(unresolved.unresolved).toBe(1)
    expect(unresolved.policy.defaults.thinking).toBe("low")
    expect(unresolved.changes[0]?.state).toBe("conflict")
    expect(
      recoverPolicy(base, draft, latest, { "defaults.thinking": "draft" }).policy.defaults.thinking,
    ).toBe("high")
    expect(
      recoverPolicy(base, draft, latest, { "defaults.thinking": "saved" }).policy.defaults.thinking,
    ).toBe("low")
  })

  it.each(["tools", "skills", "servers", "models", "privateUsers", "groups"] as const)(
    "treats %s as an atomic list without combining members",
    (key) => {
      const { base, draft, latest } = policies()
      Object.assign(draft, {
        [key]: [key === "privateUsers" ? 42 : key === "groups" ? -42 : "local"],
      })
      Object.assign(latest, {
        [key]: [key === "privateUsers" ? 43 : key === "groups" ? -43 : "saved"],
      })
      expect(recoverPolicy(base, draft, latest).unresolved).toBe(1)
      const result = recoverPolicy(base, draft, latest, { [key]: "draft" })
      expect(result.unresolved).toBe(0)
      expect(result.policy[key]).toEqual(draft[key])
    },
  )

  it("preserves provider order and treats provider configuration as one value", () => {
    const { base, draft, latest } = policies()
    base.providers = [
      { id: "a", enabled: true, models: [] },
      { id: "b", enabled: true, models: [] },
    ]
    draft.providers = structuredClone([...base.providers].reverse())
    latest.providers = structuredClone(base.providers)
    latest.providers[0] = { id: "a", enabled: false, models: [] }
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(1)
    expect(result.policy.providers).toEqual(latest.providers)
    expect(recoverPolicy(base, draft, latest, { providers: "draft" }).policy.providers).toEqual(
      draft.providers,
    )
  })

  it("keeps deletion, inheritance, and explicit empty overrides distinct", () => {
    const { base, draft, latest } = policies()
    base.chats["42"] = { ...inherited, enabled: true }
    draft.chats["42"] = { ...inherited, tools: [], enabled: true }
    const conflict = recoverPolicy(base, draft, latest)
    expect(conflict.unresolved).toBe(1)
    expect(conflict.policy.chats["42"]).toBeUndefined()
    expect(
      recoverPolicy(base, draft, latest, { "chats.42": "draft" }).policy.chats["42"]?.tools,
    ).toEqual([])
    expect(
      recoverPolicy(base, draft, latest, { "chats.42": "saved" }).policy.chats["42"],
    ).toBeUndefined()
    draft.defaults.tools = null
    const result = recoverPolicy(base, draft, latest, { "chats.42": "saved" })
    expect(result.policy.defaults.tools).toBeNull()
  })

  it("handles local record additions and removals without dropping remote records", () => {
    const { base, draft, latest } = policies()
    base.chats["42"] = { ...inherited, enabled: true }
    latest.chats["42"] = { ...inherited, enabled: true }
    latest.chats["43"] = { ...inherited, enabled: false }
    draft.chats["44"] = { ...inherited, enabled: true }
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(0)
    expect(result.policy.chats["42"]).toBeUndefined()
    expect(result.policy.chats["43"]?.enabled).toBe(false)
    expect(result.policy.chats["44"]?.enabled).toBe(true)
  })

  it("recognizes identical drafts as already saved, independent of object key order", () => {
    const { base, draft, latest } = policies()
    draft.chats["42"] = { ...inherited, enabled: true }
    latest.chats["42"] = { enabled: true, ...inherited }
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(0)
    expect(result.policy).toEqual(latest)
    expect(result.changes[0]?.state).toBe("saved")
  })

  it("requires a choice for edits that undo an unconfirmed submitted change", () => {
    const { base, draft, latest } = policies()
    const submitted = structuredClone(base)
    submitted.privateUsers = [42]
    submitted.defaults.thinking = "high"
    submitted.chats["42"] = { ...inherited, enabled: true }
    Object.assign(latest, structuredClone(submitted))
    const result = recoverPolicy(base, draft, latest, {}, submitted)
    expect(result.unresolved).toBe(3)
    expect(result.changes.map((change) => change.id)).toEqual([
      "privateUsers",
      "defaults.thinking",
      "chats.42",
    ])
    const restored = recoverPolicy(
      base,
      draft,
      latest,
      { privateUsers: "draft", "defaults.thinking": "draft", "chats.42": "draft" },
      submitted,
    )
    expect(restored.unresolved).toBe(0)
    expect(restored.policy).toEqual(base)
  })

  it("does not let a supplied choice alter a field that was not edited locally", () => {
    const { base, draft, latest } = policies()
    latest.defaults.thinking = "high"
    const result = recoverPolicy(base, draft, latest, { "defaults.thinking": "draft" })
    expect(result.changes).toEqual([])
    expect(result.policy.defaults.thinking).toBe("high")
  })

  it("does not mutate or alias any input policy or change value", () => {
    const { base, draft, latest } = policies()
    draft.privateUsers = [42]
    const originals = [base, draft, latest].map((policy) => structuredClone(policy))
    const result = recoverPolicy(base, draft, latest)
    result.policy.privateUsers.push(43)
    const retainedValue = result.changes[0]?.draft
    if (!Array.isArray(retainedValue)) throw new Error("Missing retained list")
    retainedValue.push(44)
    expect([base, draft, latest]).toEqual(originals)
  })

  it("is deterministic for all supported recovery units", () => {
    const { base, draft, latest } = policies()
    draft.defaults = {
      tools: [],
      skills: [],
      servers: [],
      models: [],
      model: "fixture/model",
      thinking: "high",
    }
    const first = recoverPolicy(base, draft, latest)
    expect(first).toEqual(recoverPolicy(base, draft, latest))
    expect(first.changes.map((change) => change.id)).toEqual([
      "defaults.model",
      "defaults.thinking",
    ])
    const copy: Policy = first.policy
    expect(copy.defaults.model).toBe("fixture/model")
  })
})
