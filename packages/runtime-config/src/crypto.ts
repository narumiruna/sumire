import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export function parseKey(value?: string): Buffer | undefined {
  if (typeof value !== "string") return undefined
  const key = Buffer.from(value, "base64")
  return key.length === 32 && key.toString("base64") === value ? key : undefined
}
const aad = (name: string) => Buffer.from(JSON.stringify([1, name, "secret"]))

export function encrypt(key: Buffer, name: string, value: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad(name))
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  })
}

export function decrypt(key: Buffer, name: string, payload: string): string {
  const envelope = JSON.parse(payload) as Record<string, unknown>
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== 1 ||
    Object.keys(envelope).length !== 4
  )
    throw new Error("Invalid envelope")
  const decode = (field: string, length?: number) => {
    const value = envelope[field]
    if (typeof value !== "string") throw new Error("Invalid envelope")
    const bytes = Buffer.from(value, "base64")
    if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length))
      throw new Error("Invalid envelope")
    return bytes
  }
  const nonce = decode("nonce", 12)
  const tag = decode("tag", 16)
  const ciphertext = decode("ciphertext")
  if (!ciphertext.length || ciphertext.length > 8192) throw new Error("Invalid envelope")
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 })
  decipher.setAAD(aad(name))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}
