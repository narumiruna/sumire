import type { Tool } from "@earendil-works/pi-mcp"
import { redactMcpData } from "./mcp-results.js"

const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
])
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])
const schemaChildren = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contentSchema",
])

/** Never rewrite protocol-significant keys/constants to hide a credential. Withhold such schemas. */
export function mcpPresentationSchema(
  schema: Tool["inputSchema"],
  redact: (text: string) => string,
): Tool["inputSchema"] | undefined {
  const clean = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (["title", "description", "$comment"].includes(key) && typeof item === "string")
          return [[key, redact(item)]]
        if (
          ["default", "examples"].includes(key) &&
          JSON.stringify(item) !== JSON.stringify(redactMcpData(item, redact))
        )
          return []
        if (schemaMaps.has(key) && item && typeof item === "object" && !Array.isArray(item))
          return [
            [
              key,
              Object.fromEntries(Object.entries(item).map(([name, child]) => [name, clean(child)])),
            ],
          ]
        if (schemaArrays.has(key) && Array.isArray(item)) return [[key, item.map(clean)]]
        if (schemaChildren.has(key))
          return [[key, Array.isArray(item) ? item.map(clean) : clean(item)]]
        return [[key, item]]
      }),
    )
  }
  const candidate = clean(schema) as Tool["inputSchema"]
  return JSON.stringify(candidate) === JSON.stringify(redactMcpData(candidate, redact))
    ? candidate
    : undefined
}
