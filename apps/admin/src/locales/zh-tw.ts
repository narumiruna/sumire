import chatsMessages from "./zh-tw/chats.json"
import commonMessages from "./zh-tw/common.json"
import policyMessages from "./zh-tw/policy.json"
import providersMessages from "./zh-tw/providers.json"
import recordsMessages from "./zh-tw/records.json"
import settingsMessages from "./zh-tw/settings.json"

export const zhTW = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
} as const
