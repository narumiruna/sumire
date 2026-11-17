import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const execute = promisify(execFile)

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

describe("CLI audio lifecycle", () => {
  it.each(["success", "load_failure", "parse_failure"] as const)(
    "closes its audio child after %s and exits",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "sumire-cli-audio-"))
      const pidPath = join(directory, "child.pid")
      const closedPath = join(directory, "closed")
      const hookPath = join(directory, "hook.mjs")
      // Replace only the boundary modules. The real entrypoint must call disposal,
      // including when argument parsing fails before loadUrl is called.
      const audioSource = `
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        import { writeFileSync } from 'node:fs';
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        export async function closeAudioTranscriber() {
          const closed = once(child, 'close');
          child.kill('SIGTERM');
          await closed;
          writeFileSync(${JSON.stringify(closedPath)}, 'closed');
        }
      `
      const apiSource =
        outcome === "load_failure"
          ? "export async function loadUrl() { throw new Error('fixture load failed') }"
          : "export async function loadUrl() { return 'fixture transcript' }"
      await writeFile(
        hookPath,
        `
        import { registerHooks } from 'node:module';
        registerHooks({
          load(url, context, nextLoad) {
            if (url === ${JSON.stringify(new URL("../dist/audio.js", import.meta.url).href)})
              return { format: 'module', source: ${JSON.stringify(audioSource)}, shortCircuit: true };
            if (url === ${JSON.stringify(new URL("../dist/api.js", import.meta.url).href)})
              return { format: 'module', source: ${JSON.stringify(apiSource)}, shortCircuit: true };
            return nextLoad(url, context);
          }
        });
      `,
      )
      let pid: number | undefined
      try {
        const args = outcome === "parse_failure" ? ["--invalid"] : ["https://example.com/video"]
        const result = await execute(
          process.execPath,
          [
            "--import",
            hookPath,
            fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
            ...args,
          ],
          { timeout: 10_000 },
        ).then(
          ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
          (error: unknown) => {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              !("stdout" in error) ||
              !("stderr" in error)
            )
              throw error
            return { code: error.code, stdout: error.stdout, stderr: error.stderr }
          },
        )
        expect(result.code).toBe(outcome === "success" ? 0 : 1)
        if (outcome === "success") expect(result.stdout).toBe("fixture transcript\n")
        else
          expect(result.stderr).toContain(
            outcome === "parse_failure" ? "Unknown option" : "fixture load failed",
          )
        expect(await readFile(closedPath, "utf8")).toBe("closed")
        pid = Number(await readFile(pidPath, "utf8"))
        expect(pid).toBeGreaterThan(0)
        expect(processExists(pid)).toBe(false)
      } finally {
        // Also stop the fixture child if a regression leaves the CLI waiting.
        if (!pid) pid = Number(await readFile(pidPath, "utf8").catch(() => "0"))
        if (pid && processExists(pid)) process.kill(pid, "SIGKILL")
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
