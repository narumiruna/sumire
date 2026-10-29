import { describe, expect, it } from "vitest"
import { allowsMentionAuthor, mentionsAccount } from "../src/index.js"

describe("GitHub author admission", () => {
  it.each(["Alice", "ALICE", "alice"])("admits case-insensitive exact username %s", (author) => {
    expect(allowsMentionAuthor(author, ["aLiCe"])).toBe(true)
  })
  it.each([
    "",
    "alice-team",
    "malice",
    "alice2",
    " alice",
    "@alice",
    "alice/ops",
    "alice--ops",
    "alice_",
    "-alice",
    "alice-",
    "a".repeat(40),
  ])("rejects an invalid or nonmatching author %s", (author) => {
    expect(allowsMentionAuthor(author, ["alice"])).toBe(false)
  })
  it.each(["alice\n", "alice\r\n", "alice_"])(
    "rejects invalid author %j even if the allowlist contains the same value",
    (author) => {
      expect(allowsMentionAuthor(author, [author])).toBe(false)
    },
  )
  it("does not grant access through an empty allowlist or an invalid username", () => {
    expect(allowsMentionAuthor("alice", [])).toBe(false)
    expect(allowsMentionAuthor("alice_", ["alice_"])).toBe(false)
    expect(allowsMentionAuthor("alice", ["@alice", " alice "])).toBe(false)
  })
})

describe("direct account mentions", () => {
  it.each([
    "@sumire-bot",
    "Please @SUMIRE-BOT check",
    "(@sumire-bot), thanks",
    "@sumire-bot\nnext",
    "@sumire-bot.",
    "**@sumire-bot**",
    "*@sumire-bot*",
    "`not a mention` then @sumire-bot",
    "```text\n@someone-else\n```\n@sumire-bot",
    "<!-- @someone-else --> @sumire-bot",
  ])("accepts %s", (body) => expect(mentionsAccount(body, "sumire-bot")).toBe(true))
  it.each([
    "plain text",
    "@sumire",
    "@sumire-bot2",
    "@sumire-bot-extra",
    "@sumire-bot_team",
    "@sumire-bot/team",
    "@org/sumire-bot",
    "name@sumire-bot.example",
    "name+@sumire-bot.example",
    "name-@sumire-bot.example",
    "name*@sumire-bot.example",
    "name'@sumire-bot.example",
    "name!@sumire-bot.example",
    "@@sumire-bot",
    "/@sumire-bot",
    "x@sumire-bot",
  ])("rejects non-direct mention %s", (body) =>
    expect(mentionsAccount(body, "sumire-bot")).toBe(false),
  )
  it.each([
    "`@sumire-bot`",
    "before ``@sumire-bot`` after",
    "```\n@sumire-bot\n```",
    '```typescript\nconst mention = "@sumire-bot"\n```',
    "~~~text\n@sumire-bot\n~~~",
    "<!-- @sumire-bot -->",
    "<!--\nPlease @sumire-bot\n-->",
    "    @sumire-bot",
    "\t@sumire-bot",
  ])("does not treat code or hidden HTML comments as addressing: %s", (body) => {
    expect(mentionsAccount(body, "sumire-bot")).toBe(false)
  })

  it.each([
    "What does `<!--` mean, @sumire-bot?",
    "```html\n<!--\n```\n@sumire-bot",
    "~~~html\n<!--\n~~~\n@sumire-bot",
    "    <!--\n@sumire-bot",
    "\t<!--\n@sumire-bot",
    "`<!--` <!-- hidden --> @sumire-bot",
    "`-->` <!-- hidden --> @sumire-bot",
    "<!-- ` --> @sumire-bot",
    "<!-- ```\n--> @sumire-bot",
    "``<!-- ` literal -->`` @sumire-bot",
    "`first\n<!--\nlast` @sumire-bot",
    "``first\n` <!-- -->\nlast`` @sumire-bot",
    "````html\n<!--\n```\n````\n@sumire-bot",
    "```html\n<!--\n````\n@sumire-bot",
    "unmatched ` @sumire-bot",
    "unmatched `` ` @sumire-bot",
    "`literal\n\n    `<!--\n\n@sumire-bot",
    "`literal\n\n```html\n`<!--\n```\n@sumire-bot",
    "`literal\n\n~~~html\n`<!--\n~~~\n@sumire-bot",
  ])("preserves visible mentions after mixed code and comments: %s", (body) => {
    expect(mentionsAccount(body, "sumire-bot")).toBe(true)
  })

  it.each([
    "`<!--` <!-- @sumire-bot -->",
    "`-->` <!-- @sumire-bot -->",
    "```html\n<!--\n```\n<!-- @sumire-bot -->",
    "~~~html\n-->\n~~~\n<!-- @sumire-bot -->",
    "    <!--\n<!-- @sumire-bot -->",
    "\t-->\n<!-- @sumire-bot -->",
    "<!-- ` @sumire-bot -->",
    "<!-- ```\n@sumire-bot\n``` -->",
    "<!-- ` --> `@sumire-bot`",
    "<!-- ```\n-->\n```\n@sumire-bot\n```",
    "`first\n@sumire-bot <!--\nlast`",
    "``first ` @sumire-bot <!--\nlast``",
    "````html\n<!--\n```\n@sumire-bot\n````",
    "<!-- unclosed `\n@sumire-bot",
    "```html\n<!--\n@sumire-bot",
    "~~~html\n-->\n@sumire-bot",
    "unmatched ` <!-- @sumire-bot -->",
    "``<!-- @sumire-bot -->`",
    "`literal\n\n<!-- ` @sumire-bot -->",
    "`literal\n\n```text\n` @sumire-bot\n```",
    "`literal\n\n    ` @sumire-bot",
  ])("keeps mixed code and comment mentions hidden: %s", (body) => {
    expect(mentionsAccount(body, "sumire-bot")).toBe(false)
  })

  it.each(["", "bot.*", "@sumire-bot", "bad/name"])("rejects invalid account %s", (login) => {
    expect(mentionsAccount("@sumire-bot", login)).toBe(false)
  })
})
