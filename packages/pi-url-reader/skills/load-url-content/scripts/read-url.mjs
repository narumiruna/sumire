import { main } from "@narumitw/sumire-url-reader/cli"

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
