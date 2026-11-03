/** Read text without disguising the actual API payload or transport method. */
export function telegramPayloadText(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const rich = payload?.rich_message
  if (rich && typeof rich === "object" && "markdown" in rich && typeof rich.markdown === "string")
    return rich.markdown
  return typeof payload?.text === "string" ? payload.text : undefined
}
