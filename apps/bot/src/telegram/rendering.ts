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
