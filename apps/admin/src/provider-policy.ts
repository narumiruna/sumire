import type { Policy, Selection } from "./api.js"

/** Add one explicit model. Do not grant its provider's full catalog or alter chat overrides. */
export function withProviderModel(
  policy: Policy,
  ref: string,
  thinking: Selection["thinking"],
  useDefault: boolean,
): Policy {
  return {
    ...policy,
    models: [...new Set([...policy.models, ref])],
    defaults: useDefault
      ? {
          ...policy.defaults,
          models: [...new Set([...(policy.defaults.models ?? []), ref])],
          model: ref,
          thinking,
        }
      : policy.defaults,
  }
}

/** Provider login URLs are untrusted data. Never render executable URL schemes. */
export function loginUrl(value?: string): string | undefined {
  if (!value) return
  try {
    const url = new URL(value)
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      return url.href
  } catch {
    return
  }
}
