import { chatsMessages } from "./ja/chats.js"
import { commonMessages } from "./ja/common.js"
import { policyMessages } from "./ja/policy.js"
import { providersMessages } from "./ja/providers.js"
import { recordsMessages } from "./ja/records.js"
import { settingsMessages } from "./ja/settings.js"

export const ja = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
} as const
