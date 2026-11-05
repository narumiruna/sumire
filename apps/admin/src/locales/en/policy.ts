import type { Catalog } from "../types.js"

export const policyMessages = {
  "policy.invalidTelegramId": "Enter a valid, non-zero Telegram ID",
  "policy.field.tools": "Authorized tools",
  "policy.field.skills": "Enabled skills",
  "policy.field.servers": "Authorized MCP servers",
  "policy.field.models": "Allowed models",
  "policy.field.model": "Model",
  "policy.field.thinking": "Thinking level",
  "policy.field.enabled": "Enabled switch",
  "policy.field.enabledReset": "Enabled switch (reset)",
  "policy.field.baseUrl": "Endpoint URL",
  "policy.field.api": "API protocol",
  "policy.field.modelId": "Model ID",
  "policy.field.name": "Display name",
  "policy.field.reasoning": "Reasoning support",
  "policy.field.image": "Image support",
  "policy.field.contextWindow": "Context window",
  "policy.field.maxTokens": "Maximum output tokens",
  "policy.source.inherit": "inherit shared defaults",
  "policy.source.noDefault": "no shared default",
  "policy.source.emptyOverride": "explicit empty override",
  "policy.source.emptySelection": "explicit empty selection",
  "policy.source.override": "explicit override",
  "policy.source.selection": "explicit selection",
  "policy.selection": "{field} ({source})",
  "policy.listSeparator": ", ",
  "policy.provider.added": "Added provider settings",
  "policy.provider.removed": "Removed provider settings",
  "policy.provider.modelDefinitions": "Model definitions",
  "policy.provider.modelDetails": "Model definitions ({detail})",
  "policy.provider.entryOrder": "entry order",
  "policy.provider.order": "Provider order",
  "policy.scope.privateUsers": "Private-message access",
  "policy.scope.groups": "Group/channel access",
  "policy.access.approve": "{scope}: approve {id}",
  "policy.access.revoke": "{scope}: revoke {id}",
  "policy.chat.changed":
    "Chat {id}: {fields} — this chat only; shared defaults and access approval unchanged.",
  "policy.chat.added":
    "Chat {id}: added settings; {fields} — this chat only; shared defaults and access approval unchanged.",
  "policy.chat.removed":
    "Chat {id}: removed settings; {fields} — this chat only; shared defaults and access approval unchanged.",
  "policy.github.add":
    "GitHub mentions: add username {username} — automatic replies on GitHub; no Telegram chat or tool permission dependency.",
  "policy.github.remove":
    "GitHub mentions: remove username {username} — automatic replies on GitHub; no Telegram chat or tool permission dependency.",
  "policy.defaults.changed":
    "Shared defaults: {fields} — affects chats inheriting each changed field; explicit overrides unchanged; does not grant access.",
  "policy.global.tools": "Global tool availability",
  "policy.global.skills": "Global skill availability",
  "policy.global.servers": "Global MCP availability",
  "policy.global.models": "Global model availability",
  "policy.global.changed":
    "{scope} ({key}): limits shared defaults and all chat selections, including explicit overrides; does not grant access.",
  "policy.provider.changed":
    "Provider configuration: {fields} — global provider settings; may affect chats using these providers, including explicit overrides.",
  "policy.recovery.groups": "Group and channel access",
  "policy.recovery.providers": "Provider configuration and order",
  "policy.recovery.github": "GitHub mention authors",
  "policy.recovery.default": "Shared defaults: {field}",
  "policy.recovery.chat": "Chat {id} settings",
} as const satisfies Catalog
