import chatsMessages from "./zh-tw/chats.json" with { type: "json" }
import commonMessages from "./zh-tw/common.json" with { type: "json" }
import policyMessages from "./zh-tw/policy.json" with { type: "json" }
import providersMessages from "./zh-tw/providers.json" with { type: "json" }
import recordsMessages from "./zh-tw/records.json" with { type: "json" }
import schedulesMessages from "./zh-tw/schedules.json" with { type: "json" }
import settingsMessages from "./zh-tw/settings.json" with { type: "json" }

export const zhTW = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
  ...schedulesMessages,
} as const
