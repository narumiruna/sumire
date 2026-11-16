import chatsMessages from "./ja/chats.json"
import commonMessages from "./ja/common.json"
import policyMessages from "./ja/policy.json"
import providersMessages from "./ja/providers.json"
import recordsMessages from "./ja/records.json"
import settingsMessages from "./ja/settings.json"

export const ja = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
} as const
