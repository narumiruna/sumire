const username = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?![\s\S])/i

export function allowsMentionAuthor(author: string, allowedUsernames: readonly string[]): boolean {
  return (
    username.test(author) &&
    allowedUsernames.some((name) => name.toLowerCase() === author.toLowerCase())
  )
}

/** Addressing is deterministic. Code, email, teams, and longer names are not direct mentions. */
export function mentionsAccount(body: string, login: string): boolean {
  if (!username.test(login)) return false
  const visible = visibleText(body)
  const address = new RegExp(`(?<![\\w@/])@${login}(?![\\w/-])`, "gi")
  for (const match of visible.matchAll(address)) {
    const prefix = visible.slice(0, match.index)
    const local = /[a-z\d.!#$%&'*+/=?^_`{|}~-]+$/i.exec(prefix)?.[0]
    const suffix = visible.slice(match.index + match[0].length)
    if (local && (/[a-z\d]/i.test(local) || /^\.[a-z\d]/i.test(suffix))) continue
    if (/"[^"\r\n]+"$/.test(prefix) && /^\.[a-z\d]/i.test(suffix)) continue
    return true
  }
  return false
}

function visibleText(body: string): string {
  // Index matching runs once so unmatched backticks do not cause repeated suffix scans.
  const spanEnds = new Map<number, number>()
  const previous = new Map<number, number>()
  const spans = /^ {0,3}(?:`{3,}|~{3,})[^\n]*|^(?: {4}|\t)[^\n]*|^[ \t\r]*$|(`+)/gm
  for (const match of body.matchAll(spans)) {
    if (!match[1]) {
      // Inline spans cannot cross paragraph or code-block boundaries.
      previous.clear()
      continue
    }
    const length = match[1].length
    const start = previous.get(length)
    if (start !== undefined) spanEnds.set(start, match.index + length)
    previous.set(length, match.index)
  }

  const visible: string[] = []
  const tokens = /^ {0,3}(`{3,}|~{3,})[^\n]*|^(?: {4}|\t)[^\n]*|<!--|(`+)/gm
  let cursor = 0
  for (let match = tokens.exec(body); match; match = tokens.exec(body)) {
    let end = tokens.lastIndex
    const fence = match[1]
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[^\\S\\n]*$`, "gm")
      closing.lastIndex = end
      const close = closing.exec(body)
      end = close ? close.index + close[0].length : body.length
    } else if (match[0] === "<!--") {
      const close = body.indexOf("-->", end)
      end = close === -1 ? body.length : close + 3
    } else if (match[2]) {
      // Spans can cross lines, but only an equally long run closes them.
      const close = spanEnds.get(match.index)
      if (close === undefined) continue
      end = close
    }
    visible.push(body.slice(cursor, match.index), " ")
    cursor = end
    tokens.lastIndex = end
  }
  visible.push(body.slice(cursor))
  return visible.join("")
}
