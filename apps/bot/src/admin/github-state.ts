import { createHash } from "node:crypto"
import type { GitHubAccount } from "@narumitw/sumire-contracts"
import { z } from "zod"

export const githubStateName = "GITHUB_OAUTH_STATE"

/** Encrypted, server-owned metadata for the GH_TOKEN credential. */
export interface GitHubCredentials {
  version: 1
  generation: string
  rotation: number
  clientId: string
  account: GitHubAccount
  scopes: string[]
  accessDigest: string
  expiresAt?: number
  refreshToken?: string
  refreshExpiresAt?: number
  attempt?: string
  reconnectRequired?: boolean
}

export interface GitHubPair {
  token: string
  state: GitHubCredentials
}

export type GitHubStored =
  | { kind: "none" }
  | { kind: "manual"; token: string }
  | ({ kind: "oauth" } & GitHubPair)
  | { kind: "invalid" }

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const githubCredentialsSchema: z.ZodType<GitHubCredentials> = z
  .object({
    version: z.literal(1),
    generation: identifier,
    rotation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    clientId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    account: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        login: z.string().min(1).max(100),
      })
      .strict(),
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_:.-]+$/),
      )
      .max(64),
    accessDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: timestamp.optional(),
    refreshToken: z.string().min(1).max(8192).optional(),
    refreshExpiresAt: timestamp.optional(),
    attempt: identifier.optional(),
    reconnectRequired: z.boolean().optional(),
  })
  .strict()

export function githubAccessDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function parseGitHubCredentials(value: unknown): GitHubCredentials | undefined {
  const result = githubCredentialsSchema.safeParse(value)
  return result.success ? result.data : undefined
}
