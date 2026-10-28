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
  const lines: string[] = []
  let fence: { char: string; length: number } | undefined
  for (const line of body.replace(/<!--[\s\S]*?(?:-->|$)/g, " ").split("\n")) {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (run && run[0] === fence.char && run.length >= fence.length && line.trim() === run)
        fence = undefined
      lines.push("")
    } else if (run) {
      fence = { char: run[0] as string, length: run.length }
      lines.push("")
    } else {
      lines.push(/^(?: {4}|\t)/.test(line) ? "" : line)
    }
  }
  // A backtick span closes only with the same delimiter length, including multiline spans.
  return lines.join("\n").replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ")
}
