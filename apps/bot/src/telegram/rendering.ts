import { Marked, type Token, type Tokens } from "marked"
import markedCjkFriendly from "marked-cjk-friendly"

// Use a private lexer: Telegram rendering must not change Pi's Markdown settings.
const markdown = new Marked(markedCjkFriendly(), { gfm: true })

interface Fragment {
  html: string
  text: string
  // Telegram code/pre entities cannot overlap other formatting entities.
  verbatim?: boolean
}

interface RenderContext {
  bold?: boolean
  quote?: boolean
  link?: boolean
  listDepth?: number
}

export function sanitizeTelegramText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        character === "\n" ||
        character === "\t" ||
        (codePoint >= 0x20 && !(codePoint >= 0xd800 && codePoint <= 0xdfff))
      )
    })
    .join("")
}

export function telegramHtmlChunks(text: string, limit = 4_096): string[] {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("limit must be a positive integer")
  const sanitized = sanitizeTelegramText(text)
  return chunkByCodePoints(sanitized || " ", limit).map((chunk) =>
    renderTelegram(chunk)
      .map((fragment) => fragment.html)
      .join(""),
  )
}

// Derive reply-checkpoint comparisons from the same tokens as the sent HTML.
export function telegramVisibleText(text: string): string {
  const firstChunk = chunkByCodePoints(sanitizeTelegramText(text) || " ", 4_096)[0] ?? " "
  return renderTelegram(firstChunk)
    .map((fragment) => fragment.text)
    .join("")
}

export function trimUrl(url: string): string {
  let value = url.trim()
  const pairs: Record<string, string> = { ")": "(", "）": "（", "]": "[", "}": "{" }
  while (value) {
    const last = value.at(-1) ?? ""
    const opening = pairs[last]
    if (
      /[.,，。!！?？ >]/u.test(last) ||
      (opening && value.split(last).length > value.split(opening).length)
    ) {
      value = value.slice(0, -1)
    } else break
  }
  return value
}

function renderTelegram(text: string): Fragment[] {
  try {
    const fragments = renderTokens(markdown.lexer(text))
    // Definition-only Markdown or empty fences must not produce an empty API payload.
    return fragments.some((fragment) => fragment.text.trim()) ? fragments : literal(text)
  } catch {
    // Malformed or excessively nested input must remain deliverable, not raw HTML.
    return literal(text)
  }
}

function renderTokens(tokens: readonly Token[], context: RenderContext = {}): Fragment[] {
  return tokens.flatMap((token) => {
    const childTokens = "tokens" in token ? (token.tokens ?? []) : []
    const children = () => renderTokens(childTokens, context)
    switch (token.type) {
      case "space":
        return literal(token.raw)
      case "heading":
        return trailingNewlines(
          wrap("b", renderTokens(childTokens, { ...context, bold: true })),
          token.raw,
        )
      case "paragraph":
        return trailingNewlines(children(), token.raw)
      case "strong": {
        const content = renderTokens(childTokens, { ...context, bold: true })
        return context.bold ? content : wrap("b", content)
      }
      case "em":
        return wrap("i", children())
      case "del":
        return wrap("s", children())
      case "codespan":
        return context.link
          ? literal(token.text)
          : [{ html: `<code>${escapeHtml(token.text)}</code>`, text: token.text, verbatim: true }]
      case "code": {
        const language = (token.lang ?? "").split(/\s/u)[0] ?? ""
        const code = escapeHtml(token.text)
        const content = /^[\w+-]{1,64}$/u.test(language)
          ? `<code class="language-${language}">${code}</code>`
          : code
        return trailingNewlines(
          [{ html: `<pre>${content}</pre>`, text: token.text, verbatim: true }],
          token.raw,
        )
      }
      case "blockquote": {
        const content = renderTokens(childTokens, { ...context, quote: true })
        // Telegram does not support nested blockquotes.
        return trailingNewlines(context.quote ? content : wrap("blockquote", content), token.raw)
      }
      case "list":
        return renderList(token as Tokens.List, context)
      case "link":
      case "image":
        return renderLink(token as Tokens.Link | Tokens.Image, context)
      case "br":
        return literal("\n")
      case "hr":
        return trailingNewlines(literal("────────"), token.raw)
      case "def":
        return []
      case "table":
        // Telegram has no table entity. Preserve the complete source in monospace.
        return [{ html: `<pre>${escapeHtml(token.raw)}</pre>`, text: token.raw, verbatim: true }]
      case "text":
        return token.tokens ? trailingNewlines(children(), token.raw) : literal(token.text)
      case "escape":
        return literal(token.text)
      default:
        // In particular, never pass through model-supplied HTML or unsupported tags.
        return literal(token.raw)
    }
  })
}

function renderList(token: Tokens.List, context: RenderContext): Fragment[] {
  const depth = context.listDepth ?? 0
  const content = token.items.flatMap((item, index) => {
    const marker = token.ordered ? `${Number(token.start) + index}. ` : "• "
    const fragments = [
      ...literal(`${"  ".repeat(depth)}${marker}`),
      ...renderTokens(item.tokens, { ...context, listDepth: depth + 1 }),
    ]
    const raw =
      index < token.items.length - 1 && !item.raw.endsWith("\n") ? `${item.raw}\n` : item.raw
    return trailingNewlines(fragments, raw)
  })
  return trailingNewlines(content, token.raw)
}

function renderLink(token: Tokens.Link | Tokens.Image, context: RenderContext): Fragment[] {
  const bare = token.type === "link" && token.raw === token.text && /^https?:\/\//iu.test(token.raw)
  const href = bare ? trimUrl(token.href) : token.href
  const label = bare ? literal(href) : renderTokens(token.tokens, { ...context, link: true })
  const content = label.length > 0 ? label : literal(token.type === "image" ? "圖片" : href)
  let url: URL
  try {
    url = new URL(href)
    if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password)
      return bare ? literal(token.text) : content
  } catch {
    return bare ? literal(token.text) : content
  }
  const linked = context.link ? content : wrap(`a href="${escapeAttribute(url.href)}"`, content)
  return bare ? [...linked, ...literal(token.text.slice(href.length))] : linked
}

function literal(text: string): Fragment[] {
  return text ? [{ html: escapeHtml(text), text }] : []
}

function wrap(tag: string, fragments: Fragment[]): Fragment[] {
  const output: Fragment[] = []
  let pending: Fragment[] = []
  const flush = () => {
    if (pending.length === 0) return
    output.push({
      html: `<${tag}>${pending.map((fragment) => fragment.html).join("")}</${tag.split(" ")[0]}>`,
      text: pending.map((fragment) => fragment.text).join(""),
    })
    pending = []
  }
  for (const fragment of fragments) {
    if (fragment.verbatim) {
      flush()
      output.push(fragment)
    } else pending.push(fragment)
  }
  flush()
  return output
}

function trailingNewlines(fragments: Fragment[], raw: string): Fragment[] {
  const expected = /\n*$/u.exec(raw)?.[0].length ?? 0
  const text = fragments.map((fragment) => fragment.text).join("")
  const actual = /\n*$/u.exec(text)?.[0].length ?? 0
  return [...fragments, ...literal("\n".repeat(Math.max(0, expected - actual)))]
}

function chunkByCodePoints(text: string, limit: number): string[] {
  const characters = Array.from(text)
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += limit) {
    chunks.push(characters.slice(index, index + limit).join(""))
  }
  return chunks
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;")
}
