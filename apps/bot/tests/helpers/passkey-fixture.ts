import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server"
import { isoCBOR } from "@simplewebauthn/server/helpers"

export const passkeyOrigin = "https://admin.example.test"
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest()
export function createPasskeyFixture(algorithm = -7) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwk = keys.publicKey.export({ format: "jwk" })
  const id = randomBytes(32)
  const publicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, algorithm],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x as string, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y as string, "base64url"))],
    ]),
  )
  function client(type: string, challenge: string, origin = passkeyOrigin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }
  function authData(rpID: string, flags: number, counter: number) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(counter)
    return Buffer.concat([hash(rpID), Buffer.from([flags]), count])
  }
  return {
    registration(
      challenge: string,
      options: { origin?: string; rpID?: string; flags?: number } = {},
    ): RegistrationResponseJSON {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(id.length)
      const data = Buffer.concat([
        authData(options.rpID ?? "admin.example.test", options.flags ?? 0x45, 0),
        Buffer.alloc(16),
        length,
        id,
        publicKey,
      ])
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", new Uint8Array(data)],
        ]),
      )
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          attestationObject: Buffer.from(attestation).toString("base64url"),
          clientDataJSON: client("webauthn.create", challenge, options.origin).toString(
            "base64url",
          ),
          transports: ["internal"],
        },
      }
    },
    authentication(
      challenge: string,
      userHandle: string,
      options: { origin?: string; rpID?: string; flags?: number; counter?: number } = {},
    ): AuthenticationResponseJSON {
      const data = authData(
        options.rpID ?? "admin.example.test",
        options.flags ?? 0x05,
        options.counter ?? 1,
      )
      const clientData = client("webauthn.get", challenge, options.origin)
      const signature = sign("sha256", Buffer.concat([data, hash(clientData)]), keys.privateKey)
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: data.toString("base64url"),
          clientDataJSON: clientData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle,
        },
      }
    },
  }
}
