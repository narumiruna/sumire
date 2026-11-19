import chatsMessages from "./ja/chats.json" with { type: "json" }
import commonMessages from "./ja/common.json" with { type: "json" }
import policyMessages from "./ja/policy.json" with { type: "json" }
import providersMessages from "./ja/providers.json" with { type: "json" }
import recordsMessages from "./ja/records.json" with { type: "json" }
import schedulesMessages from "./ja/schedules.json" with { type: "json" }
import settingsMessages from "./ja/settings.json" with { type: "json" }

export const ja = {
  ...commonMessages,
  ...chatsMessages,
  ...recordsMessages,
  ...providersMessages,
  ...policyMessages,
  ...settingsMessages,
  ...schedulesMessages,
} as const
