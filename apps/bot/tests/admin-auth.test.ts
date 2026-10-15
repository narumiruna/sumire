import { generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import { verifyTelegramToken } from "../src/admin/auth.js"

const keys = await generateKeyPair("RS256")
const other = await generateKeyPair("RS256")
async function signed(claims: Record<string, unknown> = {}, signingKey = keys.privateKey) {
  return new SignJWT({ nonce: "transaction-nonce", id: 42, ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://oauth.telegram.org")
    .setAudience("bot-client")
    .setSubject("different-opaque-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey)
}
const key = async () => keys.publicKey

describe("Telegram administrator ID tokens", () => {
  it("authorizes signed profile.id, not the opaque OIDC subject", async () => {
    expect(
      await verifyTelegramToken(await signed(), "bot-client", "transaction-nonce", 42, key),
    ).toBe("42")
  })
  it("rejects a forged signature", async () => {
    await expect(
      verifyTelegramToken(
        await signed({}, other.privateKey),
        "bot-client",
        "transaction-nonce",
        42,
        key,
      ),
    ).rejects.toThrow()
  })
  it.each([
    ["wrong nonce", {}, "other", 42],
    ["unauthorized user", { id: 43 }, "transaction-nonce", 42],
    ["frontend string ID", { id: "42" }, "transaction-nonce", 42],
    ["missing administrator", {}, "transaction-nonce", undefined],
  ])("rejects %s", async (_name, claims, nonce, admin) => {
    await expect(
      verifyTelegramToken(
        await signed(claims as Record<string, unknown>),
        "bot-client",
        nonce as string,
        admin as number | undefined,
        key,
      ),
    ).rejects.toThrow()
  })
  it("rejects wrong audience, issuer, expired and stale tokens", async () => {
    const base = () =>
      new SignJWT({ nonce: "transaction-nonce", id: 42 })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("subject")
    const now = Math.floor(Date.now() / 1000)
    for (const jwt of [
      base()
        .setIssuer("https://attacker.invalid")
        .setAudience("bot-client")
        .setIssuedAt(now)
        .setExpirationTime(now + 60),
      base()
        .setIssuer("https://oauth.telegram.org")
        .setAudience("wrong")
        .setIssuedAt(now)
        .setExpirationTime(now + 60),
      base()
        .setIssuer("https://oauth.telegram.org")
        .setAudience("bot-client")
        .setIssuedAt(now - 600)
        .setExpirationTime(now - 1),
      base()
        .setIssuer("https://oauth.telegram.org")
        .setAudience("bot-client")
        .setIssuedAt(now - 600)
        .setExpirationTime(now + 60),
    ])
      await expect(
        verifyTelegramToken(
          await jwt.sign(keys.privateKey),
          "bot-client",
          "transaction-nonce",
          42,
          key,
        ),
      ).rejects.toThrow()
  })
})
