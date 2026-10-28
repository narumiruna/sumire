/** Browser-safe management data. Secret plaintext is never part of a response. */
export type RuntimeConfigEntry = {
  name: string
  updatedAt: number
  revision: number
} & ({ kind: "secret"; configured: true } | { kind: "variable"; value: string })

export interface RuntimeConfigResponse {
  revision: number
  applied: number
  status: string
  secretStatus: "ready" | "unavailable" | "locked"
  entries: RuntimeConfigEntry[]
}

export interface RuntimeConfigMutation {
  revision: number
  kind: "secret" | "variable"
  value: string
}
