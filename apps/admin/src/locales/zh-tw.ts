import { chatsMessages } from "./zh-tw/chats.js"
import { commonMessages } from "./zh-tw/common.js"
import { policyMessages } from "./zh-tw/policy.js"
import { providersMessages } from "./zh-tw/providers.js"
import { recordsMessages } from "./zh-tw/records.js"
import { settingsMessages } from "./zh-tw/settings.js"

export const zhTW = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
} as const
