import type { RuntimeConfigReader } from "@narumitw/sumire-runtime-config"

// Preserve runtime paths, Otter, and the applied GitHub CLI credential only.
// This prevents direct environment inheritance. It does not isolate same-user files or processes.
const shellFields = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "XDG_CACHE_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LIBCURL_PATH",
  "IMPER_DOWNLOAD_LIBCURL",
  "OTTER_TOKEN",
] as const
export function adminShellEnvironment(
  environment: NodeJS.ProcessEnv,
  runtime?: RuntimeConfigReader,
): NodeJS.ProcessEnv {
  const token = runtime?.readSecret("GH_TOKEN")
  if (token?.includes("\0"))
    throw new Error("Stored GH_TOKEN is invalid; replace it in Secrets & variables.")
  return {
    ...Object.fromEntries(
      shellFields.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]]],
      ),
    ),
    GH_PROMPT_DISABLED: "1",
    ...(token ? { GH_TOKEN: token } : {}),
  }
}
