import chatsMessages from "./en/chats.json"
import commonMessages from "./en/common.json"
import policyMessages from "./en/policy.json"
import providersMessages from "./en/providers.json"
import recordsMessages from "./en/records.json"
import settingsMessages from "./en/settings.json"

export const en = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
} as const
