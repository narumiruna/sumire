import { config } from "zod/v4/core"

// The Admin server disallows eval, including Zod's capability probe.
config({ jitless: true })
