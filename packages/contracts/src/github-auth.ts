/** Public GitHub identity; credentials and device codes never cross this boundary. */
export interface GitHubAccount {
  id: number
  login: string
}

export interface GitHubApplicationState {
  revision: number
  applied: number
  status: string
}

export interface GitHubReceipt {
  savedRevision: number
  application: GitHubApplicationState
}

export interface GitHubFlow {
  id: string
  status: "pending" | "authorized" | "completed" | "cancelled" | "expired" | "failed" | "conflict"
  expiresAt: number
  userCode?: string
  verificationUri?: string
  account?: GitHubAccount
  scopes?: string[]
  error?: string
  receipt?: GitHubReceipt
}

export interface GitHubConnection extends GitHubApplicationState {
  secretStatus: "ready" | "unavailable" | "locked"
  clientId?: string
  mode: "none" | "manual" | "oauth" | "invalid"
  account?: GitHubAccount
  scopes?: string[]
  expiresAt?: number
  reconnectRequired: boolean
  /** Only this authenticated session's interaction, including a retained completed receipt. */
  flow?: GitHubFlow
}
