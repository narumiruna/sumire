import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { ProviderSettings, Selection } from "./api.js"
import {
  policyChangeCount,
  policyChangeEntries,
  policyChanges,
  withChatAccess,
} from "./policy-changes.js"

const chatImpact = "this chat only; shared defaults and access approval unchanged."
const defaultImpact =
  "affects chats inheriting each changed field; explicit overrides unchanged; does not grant access."
const globalImpact =
  "limits shared defaults and all chat selections, including explicit overrides; does not grant access."
const providerImpact =
  "global provider settings; may affect chats using these providers, including explicit overrides."
const selectionCases: {
  key: keyof Selection
  label: string
  value: Selection[keyof Selection]
}[] = [
  { key: "tools", label: "Authorized tools", value: ["sensitive-tool"] },
  { key: "skills", label: "Enabled skills", value: ["sensitive-skill"] },
  { key: "servers", label: "Authorized MCP servers", value: ["sensitive-server"] },
  { key: "models", label: "Allowed models", value: ["sensitive-provider/private-model"] },
  { key: "model", label: "Model", value: "sensitive-provider/private-model" },
  { key: "thinking", label: "Thinking level", value: "high" },
]
const providerModel: ProviderSettings["models"][number] = {
  id: "private-model",
  name: "Sensitive model name",
  reasoning: false,
  image: false,
  contextWindow: 8000,
  maxTokens: 1000,
}
const provider: ProviderSettings = {
  id: "private-provider",
  enabled: true,
  baseUrl: "https://user:secret@private.example.test/endpoint?key=token",
  api: "openai-completions",
  models: [providerModel],
}

describe("typed policy review destinations", () => {
  it("reviews recipient additions and removals without changing other access", () => {
    const saved = initialPolicy()
    saved.githubNotifications.allowedUserIds = [42]
    const draft = structuredClone(saved)
    draft.githubNotifications.allowedUserIds = [43]
    expect(policyChangeCount(saved, draft)).toBe(2)
    expect(policyChangeEntries(saved, draft)).toEqual(
      ["add recipient 43", "remove recipient 42"].map((action) => ({
        label: `GitHub notifications: ${action} — private chats only; chat access and tool permissions unchanged.`,
        targets: [{ page: "GitHub notifications", selector: "#github-notification-recipients" }],
      })),
    )
    expect(draft.privateUsers).toEqual([])
    expect(draft.tools).toEqual([])
    draft.githubNotifications.allowedUserIds = [42]
    expect(policyChanges(saved, draft)).toEqual([])
    expect(policyChangeCount(saved, draft)).toBe(0)
  })
  it("ignores recipient order when a removal is undone", () => {
    const saved = initialPolicy()
    saved.githubNotifications.allowedUserIds = [42, 43]
    const draft = structuredClone(saved)
    draft.githubNotifications.allowedUserIds.reverse()
    expect(policyChanges(saved, draft)).toEqual([])
    expect(policyChangeCount(saved, draft)).toBe(0)
  })
  it.each(selectionCases)(
    "opens the changed chat $key editor without exposing values",
    ({ key, value }) => {
      const saved = initialPolicy()
      saved.chats["42"] = { ...inherited, enabled: true }
      const draft = structuredClone(saved)
      const chat = draft.chats["42"]
      if (!chat) throw new Error("Missing chat fixture")
      Object.assign(chat, { [key]: value })
      const selector =
        key === "model"
          ? "#model-selection"
          : key === "thinking"
            ? "#thinking-selection"
            : `#chat-${key}-options`
      const entries = policyChangeEntries(saved, draft)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.targets).toEqual([{ page: "Chats", chat: "42", selector }])
      expect(JSON.stringify(entries)).not.toContain("sensitive-")
    },
  )
  it("routes mixed policy scopes to their own editors without protected configuration", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.privateUsers = [42]
    draft.tools = ["sensitive-tool"]
    draft.skills = ["sensitive-skill"]
    draft.defaults.model = "sensitive-model"
    draft.providers = [provider]
    const entries = policyChangeEntries(saved, draft)
    expect(new Set(entries.flatMap((entry) => entry.targets.map((target) => target.page)))).toEqual(
      new Set(["Access", "Tool permissions", "Skills", "Defaults", "Model Providers"]),
    )
    expect(JSON.stringify(entries)).not.toContain(provider.baseUrl)
    expect(JSON.stringify(entries)).not.toContain("sensitive-")
  })
})

describe("policyChangeCount", () => {
  it("counts model and thinking independently of their grouped review entry", () => {
    const saved = initialPolicy()
    saved.defaults.model = "fixture/old"
    saved.defaults.thinking = "off"
    const draft = structuredClone(saved)
    draft.defaults.model = "fixture/new"
    draft.defaults.thinking = "high"
    expect(policyChangeEntries(saved, draft)).toHaveLength(1)
    expect(policyChangeCount(saved, draft)).toBe(2)
    draft.defaults.model = saved.defaults.model
    expect(policyChangeCount(saved, draft)).toBe(1)
    draft.defaults.thinking = saved.defaults.thinking
    expect(policyChangeCount(saved, draft)).toBe(0)
  })
  it("counts list membership edits without treating approval undo order as an edit", () => {
    const saved = initialPolicy()
    saved.tools = ["read", "write"]
    saved.privateUsers = [42, 43]
    const draft = structuredClone(saved)
    draft.tools = ["read", "bash", "edit"]
    expect(policyChangeCount(saved, draft)).toBe(3)
    expect(
      policyChangeCount(saved, withChatAccess(withChatAccess(saved, 42, false), 42, true)),
    ).toBe(0)
  })
  it("does not report a restored permission as a change because its list position moved", () => {
    const saved = initialPolicy()
    saved.tools = ["read", "write"]
    saved.defaults.tools = ["read", "write"]
    const draft = structuredClone(saved)
    draft.tools = ["write", "read"]
    draft.defaults.tools = ["write", "read"]
    expect(policyChangeCount(saved, draft)).toBe(0)
    expect(policyChangeEntries(saved, draft)).toEqual([])
  })
  it("keeps empty overrides different from inheritance and ignores object key order", () => {
    const saved = initialPolicy()
    saved.chats["42"] = { ...inherited, enabled: true }
    const draft = structuredClone(saved)
    draft.chats["42"] = { enabled: true, ...inherited }
    expect(policyChangeCount(saved, draft)).toBe(0)
    draft.chats["42"].tools = []
    expect(policyChangeCount(saved, draft)).toBe(1)
  })
})

describe("policyChanges", () => {
  it("reports no changes for identical policies", () => {
    expect(policyChanges(initialPolicy(), initialPolicy())).toEqual([])
  })
  it("distinguishes approval, revocation, overrides, and global edits", () => {
    const saved = initialPolicy()
    saved.privateUsers = [42]
    const draft = structuredClone(saved)
    draft.privateUsers = [43]
    draft.groups = [-100]
    draft.chats["43"] = {
      tools: [],
      skills: null,
      servers: null,
      models: null,
      model: null,
      thinking: null,
      enabled: false,
    }
    draft.tools = ["read"]
    expect(policyChanges(saved, draft)).toEqual([
      "Private-message access: approve 43",
      "Private-message access: revoke 42",
      "Group/channel access: approve -100",
      `Chat 43: added settings; Authorized tools (explicit empty override), Enabled switch — ${chatImpact}`,
      `Global tool availability (tools): ${globalImpact}`,
    ])
  })
  it("tracks global, default, and chat skill edits in the policy draft", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.skills = ["load-public-url"]
    draft.defaults.skills = ["load-public-url"]
    draft.chats["42"] = { ...inherited, enabled: true, skills: [] }
    expect(policyChanges(saved, draft)).toEqual([
      `Chat 42: added settings; Enabled skills (explicit empty override), Enabled switch — ${chatImpact}`,
      `Shared defaults: Enabled skills (explicit selection) — ${defaultImpact}`,
      `Global skill availability (skills): ${globalImpact}`,
    ])
  })
  it.each(selectionCases)(
    "identifies the exact chat field $key without its value",
    ({ key, label, value }) => {
      const saved = initialPolicy()
      saved.chats["42"] = { ...inherited, enabled: true }
      const draft = structuredClone(saved)
      draft.chats["42"] = { ...inherited, enabled: true, [key]: value }
      expect(policyChanges(saved, draft)).toEqual([
        `Chat 42: ${label} (explicit override) — ${chatImpact}`,
      ])
    },
  )

  it.each(selectionCases)(
    "identifies the exact default field $key without its value",
    ({ key, label, value }) => {
      const saved = initialPolicy()
      saved.defaults = { ...inherited }
      const draft = structuredClone(saved)
      draft.defaults = { ...draft.defaults, [key]: value }
      expect(policyChanges(saved, draft)).toEqual([
        `Shared defaults: ${label} (explicit selection) — ${defaultImpact}`,
      ])
      expect(policyChanges(draft, saved)).toEqual([
        `Shared defaults: ${label} (no shared default) — ${defaultImpact}`,
      ])
    },
  )

  it.each(selectionCases.filter(({ key }) => !["model", "thinking"].includes(key)))(
    "distinguishes null and explicit empty $key selections in both directions",
    ({ key, label }) => {
      const saved = initialPolicy()
      saved.defaults = { ...inherited }
      saved.chats["42"] = { ...inherited, enabled: true }
      const draft = structuredClone(saved)
      draft.defaults = { ...draft.defaults, [key]: [] }
      draft.chats["42"] = { ...inherited, enabled: true, [key]: [] }
      expect(policyChanges(saved, draft)).toEqual([
        `Chat 42: ${label} (explicit empty override) — ${chatImpact}`,
        `Shared defaults: ${label} (explicit empty selection) — ${defaultImpact}`,
      ])
      expect(policyChanges(draft, saved)).toEqual([
        `Chat 42: ${label} (inherit shared defaults) — ${chatImpact}`,
        `Shared defaults: ${label} (no shared default) — ${defaultImpact}`,
      ])
    },
  )

  it.each(selectionCases)(
    "describes reset of chat $key to inheritance",
    ({ key, label, value }) => {
      const saved = initialPolicy()
      saved.chats["42"] = { ...inherited, enabled: true, [key]: value }
      const draft = structuredClone(saved)
      draft.chats["42"] = { ...inherited, enabled: true, [key]: null }
      expect(policyChanges(saved, draft)).toEqual([
        `Chat 42: ${label} (inherit shared defaults) — ${chatImpact}`,
      ])
    },
  )

  it("distinguishes added and removed inherited chat settings without granting access", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.chats["42"] = { ...inherited, enabled: true }
    expect(policyChanges(saved, draft)).toEqual([
      `Chat 42: added settings; Enabled switch — ${chatImpact}`,
    ])
    expect(policyChanges(draft, saved)).toEqual([
      `Chat 42: removed settings; Enabled switch (reset) — ${chatImpact}`,
    ])
    expect(draft.privateUsers).toEqual([])
  })

  it("names fields restored to inheritance when a chat override is removed", () => {
    const saved = initialPolicy()
    saved.chats["42"] = { ...inherited, tools: [], model: "private-model", enabled: false }
    const draft = structuredClone(saved)
    delete draft.chats["42"]
    expect(policyChanges(saved, draft)).toEqual([
      `Chat 42: removed settings; Authorized tools (inherit shared defaults), Model (inherit shared defaults), Enabled switch (reset) — ${chatImpact}`,
    ])
  })

  it("keeps enabled changes separate from approval and default edits", () => {
    const saved = initialPolicy()
    saved.chats["42"] = { ...inherited, enabled: true }
    const draft = structuredClone(saved)
    draft.chats["42"] = { ...inherited, enabled: false }
    expect(policyChanges(saved, draft)).toEqual([`Chat 42: Enabled switch — ${chatImpact}`])
  })

  it("reports default impact without claiming explicit overrides or an exact chat count change", () => {
    const saved = initialPolicy()
    saved.chats["42"] = { ...inherited, tools: [], enabled: true }
    saved.chats["43"] = { ...inherited, enabled: true }
    const draft = structuredClone(saved)
    draft.defaults.tools = ["sensitive-tool"]
    expect(policyChanges(saved, draft)).toEqual([
      `Shared defaults: Authorized tools (explicit selection) — ${defaultImpact}`,
    ])
  })

  it.each([
    ["tools", "Global tool availability"],
    ["skills", "Global skill availability"],
    ["servers", "Global MCP availability"],
    ["models", "Global model availability"],
  ] as const)("identifies global %s impact, including explicit overrides", (key, label) => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft[key] = ["sensitive-selection"]
    expect(policyChanges(saved, draft)).toEqual([`${label} (${key}): ${globalImpact}`])
    expect(policyChanges(draft, saved)).toEqual([`${label} (${key}): ${globalImpact}`])
  })

  it.each([
    ["enabled", "Enabled switch", false],
    ["baseUrl", "Endpoint URL", "https://other-private.example.test/secret"],
    ["api", "API protocol", "openai-responses"],
  ] as const)("names provider %s edits without values", (key, label, value) => {
    const saved = initialPolicy()
    saved.providers = [structuredClone(provider)]
    const draft = structuredClone(saved)
    draft.providers = [{ ...provider, [key]: value }]
    expect(policyChanges(saved, draft)).toEqual([
      `Provider configuration: ${label} — ${providerImpact}`,
    ])
  })

  it.each([
    ["name", "Display name", "Changed sensitive name"],
    ["reasoning", "Reasoning support", true],
    ["image", "Image support", true],
    ["contextWindow", "Context window", 9000],
    ["maxTokens", "Maximum output tokens", 2000],
  ] as const)("names nested provider model %s edits without values", (key, label, value) => {
    const saved = initialPolicy()
    saved.providers = [structuredClone(provider)]
    const draft = structuredClone(saved)
    draft.providers = [{ ...provider, models: [{ ...providerModel, [key]: value }] }]
    expect(policyChanges(saved, draft)).toEqual([
      `Provider configuration: Model definitions (${label}) — ${providerImpact}`,
    ])
  })

  it("identifies added and removed provider and model fields without IDs or endpoints", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.providers = [structuredClone(provider)]
    const fields =
      "Enabled switch, Endpoint URL, API protocol, Model definitions (Model ID, Display name, Reasoning support, Image support, Context window, Maximum output tokens)"
    expect(policyChanges(saved, draft)).toEqual([
      `Provider configuration: Added provider settings, ${fields} — ${providerImpact}`,
    ])
    expect(policyChanges(draft, saved)).toEqual([
      `Provider configuration: Removed provider settings, ${fields} — ${providerImpact}`,
    ])
    const removedModel = structuredClone(draft)
    removedModel.providers = [{ ...provider, models: [] }]
    expect(policyChanges(draft, removedModel)).toEqual([
      `Provider configuration: Model definitions (Model ID, Display name, Reasoning support, Image support, Context window, Maximum output tokens) — ${providerImpact}`,
    ])
    expect(policyChanges(removedModel, draft)).toEqual(policyChanges(draft, removedModel))
  })

  it("reports an empty provider catalog without claiming entries were reordered", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.providers = [{ id: "private-provider", enabled: true, models: [] }]
    expect(policyChanges(saved, draft)).toEqual([
      `Provider configuration: Added provider settings, Enabled switch, Model definitions — ${providerImpact}`,
    ])
    expect(policyChanges(draft, saved)).toEqual([
      `Provider configuration: Removed provider settings, Enabled switch, Model definitions — ${providerImpact}`,
    ])
  })

  it("identifies removal of optional provider endpoint and protocol fields", () => {
    const saved = initialPolicy()
    saved.providers = [structuredClone(provider)]
    const draft = structuredClone(saved)
    const changedProvider = structuredClone(provider)
    delete changedProvider.baseUrl
    delete changedProvider.api
    draft.providers = [changedProvider]
    expect(policyChanges(saved, draft)).toEqual([
      `Provider configuration: Endpoint URL, API protocol — ${providerImpact}`,
    ])
  })

  it("identifies provider and model entry order without leaking IDs", () => {
    const saved = initialPolicy()
    const firstProvider = structuredClone(provider)
    firstProvider.models.push({ ...providerModel, id: "another-private-model" })
    const secondProvider = { id: "another-private-provider", enabled: false, models: [] }
    saved.providers = [firstProvider, secondProvider]
    const draft = structuredClone(saved)
    const reversedProvider = structuredClone(firstProvider)
    reversedProvider.models.reverse()
    draft.providers = [secondProvider, reversedProvider]
    expect(policyChanges(saved, draft)).toEqual([
      `Provider configuration: Model definitions (entry order), Provider order — ${providerImpact}`,
    ])
  })

  it("does not count object property order as a field change", () => {
    const saved = initialPolicy()
    saved.chats["42"] = { ...inherited, enabled: true }
    saved.providers = [structuredClone(provider)]
    const draft = structuredClone(saved)
    draft.chats["42"] = { enabled: true, ...inherited }
    const reordered = Object.fromEntries(Object.entries(provider).reverse()) as ProviderSettings
    reordered.models = [
      Object.fromEntries(Object.entries(providerModel).reverse()) as typeof providerModel,
    ]
    draft.providers = [reordered]
    expect(policyChanges(saved, draft)).toEqual([])
  })

  it("keeps values and unknown credential fields out of all summaries and does not mutate inputs", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.providers = [
      { ...provider, ...{ apiKey: "private-api-key", password: "private-password" } },
    ]
    draft.tools = ["sensitive-tool"]
    draft.skills = ["sensitive-skill"]
    draft.servers = ["sensitive-server"]
    draft.models = ["sensitive-provider/private-model"]
    draft.defaults = {
      tools: [...draft.tools],
      skills: [...draft.skills],
      servers: [...draft.servers],
      models: [...draft.models],
      model: "sensitive-provider/private-model",
      thinking: "high",
    }
    draft.chats["42"] = { ...draft.defaults, enabled: false }
    const before = structuredClone({ saved, draft })
    const changes = policyChanges(saved, draft)
    const text = changes.join(" ")
    expect(changes).toHaveLength(7)
    for (const secret of [
      "sensitive-tool",
      "sensitive-skill",
      "sensitive-server",
      "sensitive-provider",
      "private-provider",
      "private-model",
      "Sensitive model name",
      "private.example.test",
      "https://",
      "user:secret",
      "key=token",
      "private-api-key",
      "private-password",
      "8000",
      "1000",
      "high",
    ])
      expect(text).not.toContain(secret)
    expect({ saved, draft }).toEqual(before)
  })
})

describe("withChatAccess", () => {
  it("edits only the explicit ID scope without enabling a disabled chat", () => {
    const policy = initialPolicy()
    policy.privateUsers = [42]
    policy.chats["-100"] = {
      skills: null,
      tools: [],
      servers: null,
      models: null,
      model: null,
      thinking: null,
      enabled: false,
    }
    const draft = withChatAccess(policy, -100, true)
    expect(draft.groups).toEqual([-100])
    expect(draft.privateUsers).toEqual([42])
    expect(draft.chats).toEqual(policy.chats)
    expect(policy.groups).toEqual([])
    expect(withChatAccess(draft, -100, true).groups).toEqual([-100])
  })
  it("supports grant, revocation, and undo without counting access-list order as a change", () => {
    const policy = initialPolicy()
    policy.privateUsers = [42, 43]
    const revoked = withChatAccess(policy, 42, false)
    expect(policyChanges(policy, revoked)).toEqual(["Private-message access: revoke 42"])
    expect(policyChanges(policy, withChatAccess(revoked, 42, true))).toEqual([])
  })
  it("rejects invalid IDs instead of editing another access scope", () => {
    for (const id of [0, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => withChatAccess(initialPolicy(), id, true)).toThrow("valid, non-zero Telegram ID")
    }
  })
})
