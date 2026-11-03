import type { RichBlock, RichBlockCaption, RichText } from "grammy/types"

/** Context projection, not a Markdown renderer. Link destinations remain available to Pi. */
export function richMessageText(blocks: RichBlock[]): string {
  return joinText(blocks.map(projectBlock))
}

function joinText(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n")
}

function projectInline(value: RichText): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(projectInline).join("")
  switch (value.type) {
    case "anchor":
      return ""
    case "custom_emoji":
      return value.alternative_text
    case "mathematical_expression":
      return value.expression
    case "button":
      return projectInline(value.button.text)
    case "url": {
      const label = projectInline(value.text)
      return label === value.url ? label : `${label} (${value.url})`
    }
    default:
      return projectInline(value.text)
  }
}

function projectCaption(caption: RichBlockCaption | undefined): string {
  return caption ? joinText([projectInline(caption.text), projectInline(caption.credit ?? "")]) : ""
}

function projectBlock(block: RichBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
    case "thinking":
      return projectInline(block.text)
    case "divider":
    case "anchor":
      return ""
    case "mathematical_expression":
      return block.expression
    case "list":
      return joinText(
        block.items.map((item) => {
          const prefix = item.has_checkbox ? (item.is_checked ? "[x]" : "[ ]") : item.label
          return `${prefix} ${richMessageText(item.blocks)}`
        }),
      )
    case "blockquote":
      return joinText([richMessageText(block.blocks), projectInline(block.credit ?? "")])
    case "expandable_blockquote":
    case "pullquote":
      return joinText([projectInline(block.text), projectInline(block.credit ?? "")])
    case "details":
      return joinText([projectInline(block.summary), richMessageText(block.blocks)])
    case "table":
      return joinText([
        ...block.cells.map((row) => row.map((cell) => projectInline(cell.text ?? "")).join("\t")),
        projectInline(block.caption ?? ""),
      ])
    case "buttons":
      return block.buttons.map((button) => projectInline(button.text)).join(" ")
    case "collage":
    case "slideshow":
      return joinText([richMessageText(block.blocks), projectCaption(block.caption)])
    case "map":
      return joinText([
        `[Location: ${block.location.latitude}, ${block.location.longitude}]`,
        projectCaption(block.caption),
      ])
    default:
      // Media is not downloaded by this projection; only its supplied caption is available.
      return projectCaption(block.caption)
  }
}

/** Check semantic mentions, excluding literal code and unrelated media/URL metadata. */
export function richMessageHasMention(
  blocks: RichBlock[],
  botId: number,
  username: string,
): boolean {
  const normalize = (name: string) => name.replace(/^@/, "").toLowerCase()
  const target = normalize(username)
  const inlineMentions = (value: RichText): boolean => {
    if (typeof value === "string") return false
    if (Array.isArray(value)) return value.some(inlineMentions)
    switch (value.type) {
      case "mention":
        return normalize(value.username) === target
      case "text_mention":
        return value.user.id === botId
      case "code":
      case "anchor":
      case "custom_emoji":
      case "mathematical_expression":
        return false
      case "button":
        return inlineMentions(value.button.text)
      default:
        return inlineMentions(value.text)
    }
  }
  const captionMentions = (caption: RichBlockCaption | undefined): boolean =>
    !!caption && (inlineMentions(caption.text) || inlineMentions(caption.credit ?? ""))
  const blockMentions = (block: RichBlock): boolean => {
    switch (block.type) {
      case "pre":
      case "divider":
      case "anchor":
      case "mathematical_expression":
        return false
      case "paragraph":
      case "heading":
      case "footer":
      case "thinking":
        return inlineMentions(block.text)
      case "list":
        return block.items.some((item) => item.blocks.some(blockMentions))
      case "blockquote":
        return block.blocks.some(blockMentions) || inlineMentions(block.credit ?? "")
      case "expandable_blockquote":
      case "pullquote":
        return inlineMentions(block.text) || inlineMentions(block.credit ?? "")
      case "details":
        return inlineMentions(block.summary) || block.blocks.some(blockMentions)
      case "table":
        return (
          block.cells.some((row) => row.some((cell) => inlineMentions(cell.text ?? ""))) ||
          inlineMentions(block.caption ?? "")
        )
      case "buttons":
        return block.buttons.some((button) => inlineMentions(button.text))
      case "collage":
      case "slideshow":
        return block.blocks.some(blockMentions) || captionMentions(block.caption)
      default:
        return captionMentions(block.caption)
    }
  }
  return blocks.some(blockMentions)
}
