# Gondolin coding sandbox

Sumire's production `read`, `write`, `edit`, and `bash` tools now use Gondolin micro-VMs, including nested CodeMode calls. Docker still packages the trusted bot; it is no longer the only execution boundary between the agent's shell and the bot.

## Boundary and lifecycle

- Pi Durable, model access, authorization, the administration database, and Telegram delivery stay in the trusted bot process. The production Harness is not supplied a `NodeExecutionEnv`.
- Each coding-tool invocation acquires a factory-wide slot, creates a VM, explicitly starts it, executes the operation, and awaits VM close in `finally`. At most four VMs run per bot factory, each with one vCPU and 512 MiB guest memory. VM creation, boot, and policy failures return errors; there is no host fallback.
- Commands default to a 300-second deadline and may request up to 3,600 seconds. File operations have a 300-second deadline. Boot readiness has a separate 30-second bound. Cancellation and owner shutdown close the whole VM, not just the local wait for a command. Image resolution inside the SDK's `VM.create()` is not cancellable: a cancelled setup is drained and its eventual VM closed before the call finishes, without dispatching guest code.
- The host directory `.telegramagent/sessions/<chat-id>/workspace` is the only writable host mount, exposed as `/workspace`. It survives VM disposal and restart. The SQLite database and other chat workspaces are not mounted. Only that chat's approved skill directories are mounted, read-only, under `/skills/<name>`; prompts reference those guest paths.
- `read` uses the active model's image size and byte limits for direct and nested calls. CodeMode receives file text or an image block, which can be passed to `image()`.
- The root disk, `/root`, `/tmp`, installed ad-hoc packages, background processes, and shell state do not survive a tool call. Put scripts, repositories and outputs under `/workspace`. A shell command must encompass any related background work it needs.
- Shell output streams to Durable's bounded output channel. Full output is written inside `/workspace/.sumire-output`, retained only when the result is truncated, and can be read by a later tool call. Operators must budget and clean retained workspace/output storage; this is not a disk quota.
- Old shared `/workdir` content is not copied automatically. An operator may copy reviewed, non-secret project data into an individual workspace while the bot is stopped. Do not mount the old whole workspace, bot home, application directory, Docker socket, credential files, or state directory as a shortcut. Old transcript paths do not authorize host access.

## Network and credentials

Only `bash` VMs receive a network interface. HTTP is rejected: egress must use HTTPS, to an allowlisted public host, with synthetic DNS and internal-range blocking enabled. There are no SSH, raw TCP, ingress, or WebSocket exceptions. Redirects and resolved destination IPs remain subject to Gondolin policy.

The bot uses this fixed HTTPS host allowlist:

```json
["github.com","api.github.com","codeload.github.com","raw.githubusercontent.com","objects.githubusercontent.com","release-assets.githubusercontent.com","registry.npmjs.org","pypi.org","files.pythonhosted.org","dl-cdn.alpinelinux.org","otter.narumi.dev"]
```

The allowlist is not set through environment variables. General public URL reading remains a separate trusted host tool with its existing SSRF checks; it does not grant the guest general network access. Use `read_url_content` with the `load-public-url` skill.

The guest does not inherit the bot's environment, PATH, home or provider credentials. On each shell call:

- The applied GitHub credential is freshly resolved and supplied only to the host's secret substitution policy, scoped to `api.github.com` and `github.com`.
- Existing `OTTER_TOKEN` is scoped only to the CLI's default `otter.narumi.dev` service. A custom Otter service is not implicitly trusted.
- Guest environment entries contain high-entropy placeholders, never those real token values. Authorization and credential identity are rechecked after setup and on outbound requests. No request headers or secret values are logged by this integration.

Secret substitution is not API authorization: an agent with `bash` permission can still use an authorized GitHub/Otter account. A trusted destination that reflects headers can expose a substituted credential. Restrict account permissions and operations, not just hostnames. Bodies, URL paths, SSH, and arbitrary client-side cryptographic signing are not covered by header substitution. Adding a secret destination does not automatically add it to the network allowlist.

## Image and deployment

The dependency is pinned to the published `@earendil-works/gondolin@0.14.0`. Its QEMU-based JavaScript controller is **not** the newer, unreleased native-daemon architecture on the upstream `main` branch. This change does not require or claim to install `gondolind`.

Docker builds a guest image from `apps/bot/resources/gondolin/image.json`, using the SDK-matched sandbox helpers and Alpine 3.23.7. It includes Bash, Node/npm, Python/uv, curl, Git, GitHub CLI, ripgrep, file utilities, ffmpeg, and the root-lockfile's Otter CLI with its license. On ARM64, the build extracts the raw Linux Image from Alpine's EFI zboot kernel and updates the Gondolin manifest before packaging. Without this step, QEMU 7.2 direct boot never reaches guest readiness. The x86-64 kernel is unchanged.

The trusted container includes architecture-matched QEMU, `qemu-img`, and the required iPXE device ROMs; it does not receive a privileged flag or Docker socket. Guest assets are copied into `/opt/gondolin/guest`, the fixed path the bot uses. No sandbox environment variables or GitHub Actions settings are required. A separate cache volume stores Gondolin image metadata and its private TLS CA, never mounted in the guest.

Docker initializes new `gondolin-cache` volumes from the image's `app`-owned `/app/.cache/gondolin` directory. If an existing volume has a root-owned cache directory and Gondolin reports `EACCES` when creating `ssl`, repair the directory from the repository root. This preserves the volume and does not restart the bot.

```sh
docker compose exec -T --user root sumire chown --no-dereference app:app /app/.cache/gondolin
docker compose exec -T sumire test -w /app/.cache/gondolin
```

To build a guest outside Docker, install `cpio`, `lz4`, and `e2fsprogs`, then run from the repository root:

```sh
npx gondolin build --config apps/bot/resources/gondolin/image.json --output ./gondolin-guest
# On ARM64, add --arch aarch64 to the build command. The config defaults to x86_64.
node apps/bot/resources/gondolin/normalize-kernel.mjs ./gondolin-guest
```

When running the bot directly, install QEMU, `qemu-img`, and the required device ROMs, and make the built guest assets available at `/opt/gondolin/guest`. The standalone smoke check can take a different local directory as an argument.

Do not build using real secrets in the image configuration. Review/pin guest package inputs and image checksums for a stricter supply-chain policy; this config pins the Alpine release and SDK/helper version, not every APK dependency.

KVM is not enabled by this change. Without accessible hardware acceleration, QEMU uses TCG and can be substantially slower or incompatible with a particular host/image combination. Granting `/dev/kvm` requires an operator-reviewed Compose override with the device and its group, not `privileged: true`. Validate the exact host, seccomp profile, guest image and backend before rollout. Do not weaken isolation or enable host execution to pass a health check.

## What remains trusted

MCP servers (including stdio processes), URL/media conversion, image preparation/generation, publishing, and other explicitly authorized application tools are still host or external services. They do not become sandboxed because CodeMode's shell runs in a VM. Review their capabilities and credentials separately. Host-side approved mount providers and image preparation remain part of the trusted computing base.

This is not protection against a malicious host account, VMM vulnerabilities, side channels or complete denial of service. Writable mounts retain potentially hostile modifications across calls. Commands with external effects remain replay-unsafe; only reads are replay-safe. No claim of exactly-once effects, independent security audit, or production rollout is made.

## Verification and rollout gate

`tests/gondolin.test.ts` covers real Durable direct/nested dispatch with a mocked VM transport, VM cleanup, failed creation, revocation during setup, late creation after cancellation, shutdown, capacity cancellation, guest path mapping, egress/IP policy, placeholders, and the actual published host provider's symlink rejection. Existing harness/transport fixtures explicitly inject local execution; they do not count as VM execution tests.

On 2026-11-24, root `format:check`, `lint`, `typecheck`, `build`, and `git diff --check` passed. The focused sandbox/skill suite passed 18 tests at default timeouts. A complete bot run passed 2,297 tests across 146 files with `npm --ignore-scripts test --workspace @narumitw/sumire -- --testTimeout=30000 --hookTimeout=30000 --maxWorkers=2`. The other workspaces passed 2,014 tests. Root `npm test` at default 5-second test bounds did **not** pass: the latest constrained-worker attempt had four timeouts in existing bulk notification, chat-directory capacity, and provisional MCP-registration cases. Their source timeouts were not relaxed in the repository. These are successful distinct suite runs, not a clean default all-workspace test run.

Real VM execution and a full Docker image build must also pass before rollout. Earlier ARM64 tests timed out with the bundled guest even after installing the required iPXE ROMs. In a later offline comparison, the same container under QEMU 7.2.22 TCG timed out with Alpine's EFI zboot kernel and passed with the extracted Linux Image. The comparison did not require `/dev/kvm` or a change to the seccomp profile.

The service health check does not boot a VM. Before deploying a built container image, run the offline VM smoke test with the deployment seccomp profile and no bot state, credentials, or container network:

```sh
docker run --rm --init --network none \
  --security-opt "seccomp=$PWD/apps/bot/resources/chromium/seccomp-profile.json" \
  --entrypoint node sumire:local /app/apps/bot/scripts/check-gondolin.mjs
```

For a local guest build, run `sh scripts/install-diagram-design.sh` to install the skill, then run `node apps/bot/scripts/check-gondolin.mjs ./gondolin-guest` after building the bot. This check exercises guest commands and bundled tools, Diagram Design's offline SVG export from its read-only mount, read/write symlink denial, workspace persistence, and fresh rootfs state.

On 2026-11-27, the full ARM64 Docker image built successfully and passed this check on OrbStack using QEMU 7.2.22 TCG and the deployment seccomp profile.

The takeover branch passed this offline check on Linux x86_64: the Docker `gondolin-image` target built guest `5e765c06-afa5-5a98-87ca-0f35ef3e6f35`, and a separate Debian Bookworm test container ran it as a non-root user with QEMU 7.2 TCG and no container network. The full production image build stopped at a Debian package checksum mismatch. This smoke pass does not verify the production image or the staging checks below.

On a staging host, also verify command execution/exit status, read/write/multi-edit and images, truncated-output follow-up reads, per-chat isolation, symlink escape denial for reads and writes, read-only skills, blocked metadata/private destinations and redirects, wrong credential destinations, cancellation with a delayed write, owner shutdown, and absence of residual QEMU children. Measure cold/warm startup, peak memory and command latency. Exercise approved GitHub/Otter reads without logging credentials. Do not merge/deploy on mock evidence alone.

References: [v0.14.0 VM API](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/sdk-vm.md), [VFS](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/vfs.md), [network](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/sdk-network.md), [secrets](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/secrets.md), [security model](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/security.md), [Docker security](https://docs.docker.com/engine/security/).
