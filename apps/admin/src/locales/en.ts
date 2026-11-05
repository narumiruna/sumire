import { chatsMessages } from "./en/chats.js"
import { commonMessages } from "./en/common.js"
import { policyMessages } from "./en/policy.js"
import { providersMessages } from "./en/providers.js"
import { recordsMessages } from "./en/records.js"
import { settingsMessages } from "./en/settings.js"

export const en = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
} as const
