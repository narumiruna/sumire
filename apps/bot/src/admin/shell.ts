// Preserve runtime paths and the existing skill credentials, not bot or model-provider secrets.
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
  "FIRECRAWL_API_KEY",
] as const
export function adminShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    shellFields.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])),
  )
}
