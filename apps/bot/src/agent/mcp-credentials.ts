const AUTH = new Set(["auth", "authorization", "authentication", "xauth", "authtoken"])
const COOKIE = new Set(["cookie", "cookies", "setcookie"])
const SECRET = new Set([
  "key",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "signature",
  "sig",
  "apikey",
  "accesskey",
  "privatekey",
  "secretkey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
])

/** Match credential words, not ordinary substrings (MONKEY, AUTHOR, tokenizer). */
export function mcpCredentialKind(name: string): "auth" | "cookie" | "secret" | undefined {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  if (words.some((word) => AUTH.has(word))) return "auth"
  if (words.some((word) => COOKIE.has(word))) return "cookie"
  if (words.some((word) => SECRET.has(word))) return "secret"
  return undefined
}
