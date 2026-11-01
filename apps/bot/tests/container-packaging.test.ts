import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const dockerfileUrl = new URL("../../../Dockerfile", import.meta.url)
const ciUrl = new URL("../../../.github/workflows/ci.yml", import.meta.url)

describe("container application packaging", () => {
  it("shares one complete compiled workspace artifact between compilation and runtime", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const compiled = dockerfile
      .split("FROM scratch AS compiled-workspaces\n")[1]
      ?.split("\nFROM ")[0]
    const workspaces = [
      ["runtime-config", "runtime-config-build"],
      ["policy", "policy-build"],
      ["contracts", "contracts-build"],
      ["progress", "progress-build"],
      ["imagegen", "imagegen-build"],
      ["github-notifications", "github-notifications-build"],
      ["pi-polymarket", "polymarket-build"],
      ["url-reader", "url-reader-build"],
      ["pi-url-reader", "pi-url-reader-build"],
    ] as const
    expect(compiled).toBeDefined()
    expect(compiled?.match(/^COPY /gm)).toHaveLength(workspaces.length)
    for (const [workspace, producer] of workspaces) {
      expect(dockerfile).toContain(`FROM dependencies AS ${producer}`)
      expect(compiled).toContain(
        `COPY --from=${producer} /build/packages/${workspace}/dist /packages/${workspace}/dist`,
      )
    }
    expect(compiled).not.toContain("node_modules")
    expect(compiled).not.toContain("/src/")
    for (const [stage, destination] of [
      ["build", "/build/packages"],
      ["runtime-application", "/app/packages"],
    ]) {
      const consumer = dockerfile.split(` AS ${stage}\n`)[1]?.split("\nFROM ")[0]
      expect(consumer).toContain(`COPY --from=compiled-workspaces /packages ${destination}`)
      expect(consumer).not.toMatch(/^COPY --from=\S+ \/build\/packages\//m)
    }
    const admin = dockerfile.split("FROM dependencies AS admin-build\n")[1]?.split("\nFROM ")[0]
    expect(admin).not.toContain("compiled-workspaces")
    for (const workspace of ["policy", "contracts"])
      expect(admin).toContain(
        `COPY --from=${workspace}-build /build/packages/${workspace}/dist /build/packages/${workspace}/dist`,
      )
  })

  it("creates only mutable runtime paths before copying the application tree", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const runtime = dockerfile.split("FROM runtime-dependencies AS runtime\n")[1]
    const setup = runtime?.split("\nCOPY --from=browser-download")[0]
    expect(setup).toContain(
      "mkdir -p /workdir /app/.telegramagent /app/.events /app/.cache/whisper",
    )
    expect(setup).toContain("chown -R app:app /app /workdir")
    for (const copied of ["/app/apps/", "/app/packages/", "/app/instructions", "/app/skills"])
      expect(setup).not.toContain(copied)
    expect(runtime).toContain("COPY --from=runtime-application --chown=app:app /app /app")
    expect(runtime).toContain("COPY --chown=app:app instructions/ /app/instructions/")
    expect(runtime).toContain("COPY --chown=app:app skills/ /app/skills/")
  })

  it("checks a complete production application and copies that artifact into the final image", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const application = dockerfile
      .split("FROM runtime-base AS runtime-application\n")[1]
      ?.split("\nFROM ")[0]
    expect(application).toBeDefined()
    for (const directory of ["node_modules", "apps/bot", "packages"])
      expect(application).toContain(
        `COPY --from=production-dependencies /build/${directory} /app/${directory}`,
      )
    expect(application).toContain(
      "RUN --network=none bun --no-env-file --input-type=module -e \"await import('/app/apps/bot/dist/startup.js')\"",
    )
    expect(application).toContain(
      "COPY apps/bot/scripts/check-runtime.mjs /app/apps/bot/scripts/check-runtime.mjs",
    )
    expect(application).toContain(
      "RUN --network=none bun --no-env-file /app/apps/bot/scripts/check-runtime.mjs",
    )
    const runtime = dockerfile.split("FROM runtime-dependencies AS runtime\n")[1]
    expect(runtime).toContain("COPY --from=runtime-application --chown=app:app /app /app")
    expect(runtime).not.toContain("COPY --from=production-dependencies")
  })

  it("installs GitHub CLI in the runtime and checks tools offline as the bot user", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const dependencies = dockerfile
      .split("FROM runtime-base AS runtime-dependencies\n")[1]
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
      "RUN --network=none bun --no-env-file /app/apps/bot/scripts/check-url-failures.mjs",
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

  it("checks Bun SQLite and native document conversion offline as the bot user", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const runtimeUser = dockerfile.split("\nUSER app\n")[1]
    expect(runtimeUser).toContain(
      "RUN --network=none bun --no-env-file /app/apps/bot/scripts/check-runtime.mjs",
    )
  })

  it("checks built-in URL pinning and actual codemode termination in CI and as the bot user", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8")
    const application = dockerfile
      .split("FROM runtime-base AS runtime-application\n")[1]
      ?.split("\nFROM ")[0]
    const runtimeUser = dockerfile.split("\nUSER app\n")[1]
    for (const stage of [application, runtimeUser]) {
      expect(stage).toContain(
        "RUN --network=none timeout --signal=KILL 15s bun --no-env-file /app/apps/bot/scripts/check-codemode.mjs",
      )
      expect(stage).toContain(
        "RUN --network=none bun --no-env-file /app/packages/pi-url-reader/scripts/check-runtime.mjs",
      )
    }
    expect(application).toContain(
      "COPY packages/pi-url-reader/scripts/check-runtime.mjs /app/packages/pi-url-reader/scripts/check-runtime.mjs",
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
