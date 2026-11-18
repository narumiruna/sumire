import { type Proposal, proposalSchema } from "./analysis.js"

const xmlText = (value: string) =>
  Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 65534 || code === 65535) return " "
    if (code >= 55296 && code <= 57343) return "\uFFFD"
    return character
  })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
function lines(value: string, length: number, max: number) {
  const result: string[] = []
  const characters = Array.from(value.replaceAll(/\s+/g, " "))
  for (let index = 0; index < characters.length && result.length < max; index += length)
    result.push(characters.slice(index, index + length).join(""))
  return result
}
/** Trusted SVG template only: no model-supplied markup, attributes, URLs, CSS, or foreignObject. */
export function renderProposalSvg(input: Proposal): string {
  const proposal = proposalSchema.parse(input)
  const columns = proposal.preview.layout === "columns" ? 2 : 1
  const width = 840
  const cellWidth = columns === 2 ? 384 : 784
  const height = 100 + Math.ceil(proposal.preview.sections.length / columns) * 200
  const cards = proposal.preview.sections
    .map((section, index) => {
      const x = 28 + (index % columns) * 400
      const y = 88 + Math.floor(index / columns) * 200
      return `<g transform="translate(${x} ${y})"><rect width="${cellWidth}" height="180" rx="12" fill="#fff" stroke="#cbd5d1"/><text x="20" y="32" font-size="18" font-weight="600">${xmlText(lines(section.heading, columns === 2 ? 18 : 36, 1)[0] ?? "")}</text><text x="20" y="62" font-size="15" fill="#475569">${lines(
        section.body,
        columns === 2 ? 22 : 46,
        3,
      )
        .map((line, row) => `<tspan x="20" dy="${row === 0 ? 0 : 23}">${xmlText(line)}</tspan>`)
        .join(
          "",
        )}</text>${section.button ? `<rect x="20" y="132" width="${Math.min(cellWidth - 40, 280)}" height="32" rx="6" fill="#0f5e4d"/><text x="32" y="154" fill="#fff" font-size="14">${xmlText(lines(section.button, 18, 1)[0] ?? "")}</text>` : ""}</g>`
    })
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${xmlText(proposal.preview.title)}</title><rect width="840" height="${height}" fill="#f5f7f6"/><g font-family="sans-serif" fill="#183d32"><text x="28" y="42" font-size="24" font-weight="600">${xmlText(lines(proposal.preview.title, 34, 1)[0] ?? "")}</text><text x="28" y="66" font-size="12" fill="#64748b">Concept wireframe · not an interactive implementation</text>${cards}</g></svg>`
}
