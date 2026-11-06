import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const dockerfileUrl = new URL("../../../Dockerfile", import.meta.url)
const ciUrl = new URL("../../../.github/workflows/ci.yml", import.meta.url)

describe("container application packaging", () => {
  it("shares one compiled-package artifact between the bot build and production application", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const compiledPackages = dockerfile
      .split("FROM scratch AS compiled-packages\n")[1]
      ?.split("\nFROM ")[0]
    const packages = [
      ["runtime-config-build", "runtime-config"],
      ["policy-build", "policy"],
      ["contracts-build", "contracts"],
      ["progress-build", "progress"],
      ["imagegen-build", "imagegen"],
      ["github-notifications-build", "github-notifications"],
      ["polymarket-build", "pi-polymarket"],
      ["url-reader-build", "url-reader"],
      ["pi-url-reader-build", "pi-url-reader"],
    ]
    expect(compiledPackages?.match(/^COPY .+$/gm)).toEqual(
      packages.map(
        ([stage, directory]) =>
          `COPY --from=${stage} /build/packages/${directory}/dist /packages/${directory}/dist`,
      ),
    )
    const build = dockerfile.split("FROM dependencies AS build\n")[1]?.split("\nFROM ")[0]
    expect(build).toContain("COPY --from=compiled-packages /packages /build/packages")
    const application = dockerfile
      .split("FROM node:26-bookworm-slim AS runtime-application\n")[1]
      ?.split("\nFROM ")[0]
    expect(application).toContain("COPY --from=compiled-packages /packages /app/packages")
    const admin = dockerfile.split("FROM dependencies AS admin-build\n")[1]?.split("\nFROM ")[0]
    expect(admin?.match(/^COPY --from=.+$/gm)).toEqual([
      "COPY --from=policy-build /build/packages/policy/dist /build/packages/policy/dist",
      "COPY --from=contracts-build /build/packages/contracts/dist /build/packages/contracts/dist",
    ])
  })

  it("checks a complete production application and copies that artifact into the final image", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const application = dockerfile
      .split("FROM node:26-bookworm-slim AS runtime-application\n")[1]
      ?.split("\nFROM ")[0]
    expect(application).toBeDefined()
    for (const directory of ["node_modules", "apps/bot", "packages"])
      expect(application).toContain(
        `COPY --from=production-dependencies /build/${directory} /app/${directory}`,
      )
    expect(application).toContain(
      "RUN --network=none node --input-type=module -e \"await import('/app/apps/bot/dist/startup.js')\"",
    )
    const runtime = dockerfile.split("FROM runtime-dependencies AS runtime\n")[1]
    expect(runtime).toContain("COPY --from=runtime-application --chown=app:app /app /app")
    expect(runtime).not.toContain("COPY --from=production-dependencies")
  })

  it("creates runtime data directories and takes application directories from the copied artifact", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const runtime = dockerfile.split("FROM runtime-dependencies AS runtime\n")[1]
    expect(runtime).toContain("WORKDIR /workdir")
    expect(runtime?.match(/&& mkdir -p (.+) \\\n/)?.[1]?.split(" ")).toEqual([
      "/app/.telegramagent",
      "/app/.events",
      "/app/.cache/whisper",
      "/app/instructions",
      "/app/skills",
    ])
    expect(runtime).toContain("&& chown -R app:app /app /workdir")
    expect(runtime).toContain("COPY --from=runtime-application --chown=app:app /app /app")
  })

  it("installs GitHub CLI in the runtime and checks tools offline as the bot user", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const dependencies = dockerfile
      .split("FROM node:26-bookworm-slim AS runtime-dependencies\n")[1]
      ?.split("\nFROM ")[0]
    expect(dependencies).toMatch(/apt-get install[^\n]*\bgh\b/)

    const runtime = dockerfile.split("FROM runtime-dependencies AS runtime\n")[1]
    const runtimeUser = runtime?.split("\nUSER app\n")[1]
    expect(runtimeUser).toContain(
      "RUN --network=none git --version && gh --version && ssh -V && command -v ssh-keygen",
    )
  })

  it("installs YouTube JavaScript dependencies and checks them offline as the bot user", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const audio = dockerfile
      .split("FROM node:26-bookworm-slim AS audio-dependencies\n")[1]
      ?.split("\nFROM ")[0]
    expect(audio).toContain('"yt-dlp[default,deno]==')

    const runtimeUser = dockerfile.split("\nUSER app\n")[1]
    expect(runtimeUser).toContain(
      "RUN --network=none node /app/apps/bot/scripts/check-url-failures.mjs",
    )
    const check = await readFile(
      new URL("../scripts/check-url-failures.mjs", import.meta.url),
      "utf8",
    )
    expect(check).toContain('await runCommand("pip", ["show", "yt-dlp-ejs"])')
    expect(check).toContain(
      'await runCommand("deno", ["eval", "--no-config", "console.log(1 + 1)"])',
    )
  })

  it("builds the same application target in CI when Docker inputs change", async () => {
    const workflow = await readFile(ciUrl, "utf8")
    for (const input of ["Dockerfile", ".dockerignore", "scripts/**"])
      expect(workflow.split(`- "${input}"`)).toHaveLength(3)
    const container = workflow.split("\n  container:\n")[1]
    expect(container).toContain("uses: docker/build-push-action@v7")
    expect(container).toContain("push: false")
    expect(container).toContain("target: runtime-application")
  })
})
