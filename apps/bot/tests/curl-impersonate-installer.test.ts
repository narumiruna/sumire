import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

const installer = fileURLToPath(
  new URL("../../../scripts/install-curl-impersonate.sh", import.meta.url),
)
const release = "v2.3.2"
const platforms = [
  {
    architecture: "amd64",
    platform: "x86_64-linux-gnu",
    checksum: "7716be1ec87f13ecc776c211003bd1122c345287829b1f18a494a5467c90ab1e",
  },
  {
    architecture: "arm64",
    platform: "aarch64-linux-gnu",
    checksum: "1cb74a3b5103df020c252f9efef5a779c87380ee6244b365a90a0e4f7086864e",
  },
]

it("pins the native release required by the installed impers dependency", () => {
  // impers does not export this constant from its public entry point. Read the
  // loader source without initializing FFI or downloading a native library.
  const loader = readFileSync(new URL("./ffi/loader.js", import.meta.resolve("impers")), "utf8")
  const version = loader.match(/export const LIBCURL_IMPERSONATE_VERSION = "([^"]+)";/)?.[1]

  expect(version).toBe(release)
  expect(readFileSync(installer, "utf8")).toContain(
    `/releases/download/${version}/libcurl-impersonate-${version}.`,
  )
})

function runInstaller(architecture: string, checksumStatus: number) {
  const directory = mkdtempSync(join(tmpdir(), "sumire-curl-installer-"))
  const log = join(directory, "commands.log")
  try {
    // Replace every external command. The real installer cannot access the
    // network, write /opt, or create/delete the shared /tmp archive in tests.
    for (const command of ["curl", "sha256sum", "mkdir", "tar", "rm"]) {
      writeFileSync(
        join(directory, command),
        `#!/bin/sh
printf '%s\\n' '${command}' "$@" >> "$TEST_LOG"
${command === "sha256sum" ? 'IFS= read -r line; printf "%s\\n" "$line" >> "$TEST_LOG"; exit "$CHECKSUM_STATUS"' : ""}
`,
        { mode: 0o755 },
      )
    }
    const result = spawnSync("/bin/sh", [installer], {
      env: {
        TARGETARCH: architecture,
        PATH: directory,
        TEST_LOG: log,
        CHECKSUM_STATUS: String(checksumStatus),
      },
      encoding: "utf8",
      timeout: 5_000,
    })
    return { result, commands: readFileSync(log, "utf8").trimEnd().split("\n") }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it.skipIf(process.platform === "win32").each(platforms)(
  "verifies the $architecture archive before bounded extraction",
  ({ architecture, platform, checksum }) => {
    const { result, commands } = runInstaller(architecture, 0)

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(commands).toEqual([
      "curl",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--continue-at",
      "-",
      "--connect-timeout",
      "15",
      "--max-time",
      "600",
      "--max-redirs",
      "5",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      `https://github.com/lexiforest/curl-impersonate/releases/download/${release}/libcurl-impersonate-${release}.${platform}.tar.gz`,
      "--output",
      "/tmp/libcurl.tar.gz",
      "sha256sum",
      "--check",
      `${checksum}  /tmp/libcurl.tar.gz`,
      "mkdir",
      "-p",
      "/opt/curl-impersonate",
      "tar",
      "-xzf",
      "/tmp/libcurl.tar.gz",
      "-C",
      "/opt/curl-impersonate",
      "--wildcards",
      "libcurl-impersonate*.so*",
      "LICENSE*",
      "rm",
      "/tmp/libcurl.tar.gz",
    ])
  },
)

it.skipIf(process.platform === "win32").each(platforms)(
  "stops before extraction when the $architecture checksum fails",
  ({ architecture, checksum }) => {
    const { result, commands } = runInstaller(architecture, 1)

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(commands.slice(-3)).toEqual(["sha256sum", "--check", `${checksum}  /tmp/libcurl.tar.gz`])
    expect(commands).not.toContain("mkdir")
    expect(commands).not.toContain("tar")
    expect(commands).not.toContain("rm")
  },
)
