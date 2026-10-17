import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import ts from "typescript"

const require = createRequire(import.meta.url)
const entry = resolve(dirname(require.resolve("@polymarket/client")), "index.d.ts")
const program = ts.createProgram([entry], {
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
})
const checker = program.getTypeChecker()
const source = program.getSourceFile(entry)
const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source))
const groups = {
  discovery: ["DiscoveryActions"],
  market_data: ["DataActions"],
  analytics: ["AnalyticsActions"],
  account: ["PublicAccountActions", "SecureAccountActions"],
  rewards: ["PublicRewardsActions", "SecureRewardsActions"],
  wallet: ["PublicWalletActions", "SecureWalletActions"],
  orders: ["SecureTradingActions"],
  subscriptions: ["PublicSubscriptionsActions", "SecureSubscriptionsActions"],
  perps: ["PublicPerpsActions", "SecurePerpsActions"],
  rfq: ["SecureRfqActions"],
  session_keys: ["SessionKeyActions"],
  Paginated: ["Paginated"],
  TransactionHandle: ["TransactionHandle"],
  SubscriptionHandle: ["SubscriptionHandle"],
  PerpsSession: ["PerpsSession"],
  RfqSession: ["RfqSession"],
}

// Schemas are discovery hints. The SDK remains responsible for input validation.
function schema(type, depth = 0, seen = new Set()) {
  if (type.flags & ts.TypeFlags.StringLiteral) return { const: type.value, type: "string" }
  if (type.flags & ts.TypeFlags.NumberLiteral) return { const: type.value, type: "number" }
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return { const: type.intrinsicName === "true", type: "boolean" }
  if (type.flags & ts.TypeFlags.Null) return { type: "null" }
  if (type.flags & ts.TypeFlags.StringLike) return { type: "string" }
  if (type.flags & ts.TypeFlags.NumberLike) return { type: "number" }
  if (type.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" }
  if (type.flags & ts.TypeFlags.BigIntLike)
    return {
      type: "object",
      properties: { $bigint: { type: "string", pattern: "^-?[0-9]+$" } },
      required: ["$bigint"],
      additionalProperties: false,
    }
  if (type.isUnion())
    return {
      anyOf: type.types
        .filter((t) => !(t.flags & ts.TypeFlags.Undefined))
        .map((t) => schema(t, depth, seen)),
    }
  if (type.isIntersection()) {
    const primitive = type.types.find(
      (t) =>
        t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike),
    )
    if (primitive) return schema(primitive, depth, seen)
  }
  if (depth >= 2 || seen.has(type)) return { description: checker.typeToString(type) }
  const next = new Set(seen).add(type)
  if (checker.isArrayType(type))
    return { type: "array", items: schema(checker.getTypeArguments(type)[0], depth + 1, next) }
  if (type.getCallSignatures().length)
    return {
      description:
        "Function input requires a host-provided adapter; it cannot be supplied as JSON.",
    }
  if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
    const properties = {}
    const required = []
    for (const prop of type.getProperties()) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0]
      if (!decl) continue
      properties[prop.name] = schema(checker.getTypeOfSymbolAtLocation(prop, decl), depth + 1, next)
      if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(prop.name)
    }
    return { type: "object", properties, required, additionalProperties: true }
  }
  return { description: checker.typeToString(type) }
}

const catalog = []
for (const [group, names] of Object.entries(groups)) {
  for (const name of names) {
    const symbol = exports.find((s) => s.name === name)
    if (!symbol) throw new Error(`Missing SDK type: ${name}`)
    const type = checker.getDeclaredTypeOfSymbol(symbol)
    for (const prop of type.getProperties()) {
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0]
      const methodType = checker.getTypeOfSymbolAtLocation(prop, declaration)
      const signature = methodType.getCallSignatures()[0]
      if (!signature) continue
      if (prop.name.startsWith("__@")) continue
      const secure = name.startsWith("Secure") || name === "SessionKeyActions"
      const readOnly =
        group === "subscriptions" ||
        prop.name === "planCollateralReturn" ||
        (!secure && !/^[A-Z]/.test(group)) ||
        /^(fetch|list|estimate|download|prepare|wait)/.test(prop.name) ||
        ["firstPage", "from"].includes(prop.name)
      const args = signature.parameters.map((p) => {
        const d = p.valueDeclaration ?? p.declarations[0]
        const t = checker.getTypeOfSymbolAtLocation(p, d)
        return {
          name: p.name,
          optional: Boolean(d.questionToken || d.initializer),
          type: checker.typeToString(t, d, ts.TypeFormatFlags.NoTruncation),
          schema: schema(t),
        }
      })
      catalog.push({
        group,
        method: prop.name,
        secure,
        readOnly,
        signature: checker.signatureToString(
          signature,
          declaration,
          ts.TypeFormatFlags.NoTruncation,
        ),
        description: ts.displayPartsToString(prop.getDocumentationComment(checker)),
        args,
      })
    }
  }
}
// Fail generation if upstream adds an action outside the known groups.
for (const name of ["PublicActions", "SecureActions"]) {
  const symbol = exports.find((item) => item.name === name)
  const methods = checker
    .getDeclaredTypeOfSymbol(symbol)
    .getProperties()
    .map((item) => item.name)
    .sort()
  const covered = [
    ...new Set(
      catalog
        .filter((item) => !/^[A-Z]/.test(item.group) && (name === "SecureActions" || !item.secure))
        .map((item) => item.method),
    ),
  ].sort()
  if (JSON.stringify(methods) !== JSON.stringify(covered))
    throw new Error(`Incomplete ${name} coverage`)
}

for (const [file, records] of [
  ["api", catalog.filter((item) => !/^[A-Z]/.test(item.group))],
  ["handles-api", catalog.filter((item) => /^[A-Z]/.test(item.group))],
]) {
  const target = new URL(`../src/${file}.json`, import.meta.url)
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(readFileSync(target, "utf8"))) !== JSON.stringify(records))
      throw new Error("SDK catalog is stale. Run npm run generate in this workspace.")
  } else writeFileSync(target, `${JSON.stringify(records, null, 2)}\n`)
}
