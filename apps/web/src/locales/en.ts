import chatsMessages from "./en/chats.json" with { type: "json" }
import commonMessages from "./en/common.json" with { type: "json" }
import policyMessages from "./en/policy.json" with { type: "json" }
import providersMessages from "./en/providers.json" with { type: "json" }
import recordsMessages from "./en/records.json" with { type: "json" }
import schedulesMessages from "./en/schedules.json" with { type: "json" }
import settingsMessages from "./en/settings.json" with { type: "json" }

export const en = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
  ...schedulesMessages,
} as const
