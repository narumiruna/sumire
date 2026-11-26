# Gondolin coding sandbox

Sumire's production `read`, `write`, `edit`, and `bash` tools now use Gondolin micro-VMs, including nested CodeMode calls. Docker still packages the trusted bot; it is no longer the only execution boundary between the agent's shell and the bot.

## Boundary and lifecycle

- Pi Durable, model access, authorization, the administration database, and Telegram delivery stay in the trusted bot process. The production Harness is not supplied a `NodeExecutionEnv`.
- Each coding-tool invocation acquires a factory-wide slot, creates a VM, explicitly starts it, executes the operation, and awaits VM close in `finally`. At most four VMs run per bot factory, each with one vCPU and 512 MiB guest memory. VM creation, boot, and policy failures return errors; there is no host fallback.
- Commands default to a 300-second deadline and may request up to 3,600 seconds. File operations have a 300-second deadline. Boot readiness has a separate 30-second bound. Cancellation and owner shutdown close the whole VM, not just the local wait for a command. Image resolution inside the SDK's `VM.create()` is not cancellable: a cancelled setup is drained and its eventual VM closed before the call finishes, without dispatching guest code. Prebuild images to avoid downloads during requests.
- The host directory `.telegramagent/sessions/<chat-id>/workspace` is the only writable host mount, exposed as `/workspace`. It survives VM disposal and restart. The SQLite database and other chat workspaces are not mounted. Only that chat's approved skill directories are mounted, read-only, under `/skills/<name>`; prompts reference those guest paths.
- `read` uses the active model's image size and byte limits for direct and nested calls. CodeMode receives file text or an image block, which can be passed to `image()`.
- The root disk, `/root`, `/tmp`, installed ad-hoc packages, background processes, and shell state do not survive a tool call. Put scripts, repositories and outputs under `/workspace`. A shell command must encompass any related background work it needs.
- Shell output streams to Durable's bounded output channel. Full output is written inside `/workspace/.sumire-output`, retained only when the result is truncated, and can be read by a later tool call. Operators must budget and clean retained workspace/output storage; this is not a disk quota.
- Old shared `/workdir` content is not copied automatically. An operator may copy reviewed, non-secret project data into an individual workspace while the bot is stopped. Do not mount the old whole workspace, bot home, application directory, Docker socket, credential files, or state directory as a shortcut. Old transcript paths do not authorize host access.

## Network and credentials

Only `bash` VMs receive a network interface. HTTP is rejected: egress must use HTTPS, to an allowlisted public host, with synthetic DNS and internal-range blocking enabled. There are no SSH, raw TCP, ingress, or WebSocket exceptions. Redirects and resolved destination IPs remain subject to Gondolin policy.

`BOT_SANDBOX_ALLOWED_HOSTS` is an optional JSON array. An empty value uses this reviewed default:

```json
["github.com","api.github.com","codeload.github.com","raw.githubusercontent.com","objects.githubusercontent.com","release-assets.githubusercontent.com","registry.npmjs.org","pypi.org","files.pythonhosted.org","dl-cdn.alpinelinux.org","otter.narumi.dev"]
```

Set `[]` to deny all mediated egress. A supplied array replaces, rather than extends, the defaults. Exact names and `*.example.com` patterns are supported; a bare `*` and URL strings are rejected. Add only destinations needed by approved work. General public URL reading remains a separate trusted host tool with its existing SSRF checks; it does not grant the guest general network access. Use `read_url_content` with the `load-public-url` skill. The bot does not load the package's `load-url-content` CLI fallback because its dependencies are not bundled in the guest.

The guest does not inherit the bot's environment, PATH, home or provider credentials. On each shell call:

- The applied GitHub credential is freshly resolved and supplied only to the host's secret substitution policy, scoped to `api.github.com` and `github.com`.
- Existing `OTTER_TOKEN` is scoped only to the CLI's default `otter.narumi.dev` service. A custom Otter service is not implicitly trusted.
- Guest environment entries contain high-entropy placeholders, never those real token values. Authorization and credential identity are rechecked after setup and on outbound requests. No request headers or secret values are logged by this integration.

Secret substitution is not API authorization: an agent with `bash` permission can still use an authorized GitHub/Otter account. A trusted destination that reflects headers can expose a substituted credential. Restrict account permissions and operations, not just hostnames. Bodies, URL paths, SSH, and arbitrary client-side cryptographic signing are not covered by header substitution. Adding a secret destination does not automatically add it to the network allowlist.

## Image and deployment

The dependency is pinned to the published `@earendil-works/gondolin@0.14.0`. Its QEMU-based JavaScript controller is **not** the newer, unreleased native-daemon architecture on the upstream `main` branch. This change does not require or claim to install `gondolind`.

Docker builds a guest image from `apps/bot/resources/gondolin/image.json`, using the SDK-matched sandbox helpers and Alpine 3.23.7. It includes Bash, Node/npm, Python/uv, curl, Git, GitHub CLI, ripgrep, file utilities, ffmpeg, and the root-lockfile's Otter CLI with its license. The trusted container includes architecture-matched QEMU, `qemu-img`, and the required iPXE device ROMs; it does not receive a privileged flag or Docker socket. Guest assets are copied into `/opt/gondolin/guest`; Compose supplies this path as `BOT_SANDBOX_IMAGE`. A separate cache volume stores Gondolin image metadata and its private TLS CA, never mounted in the guest.

For a local non-Compose development environment, install QEMU plus `qemu-img` and select an image with `BOT_SANDBOX_IMAGE`. To build the same custom image, install `cpio`, `lz4`, and `e2fsprogs`, then run from the repository root:

```sh
npx gondolin build --config apps/bot/resources/gondolin/image.json --output ./gondolin-guest
# On arm64, add --arch aarch64; the checked-in config defaults to x86_64.
# Set BOT_SANDBOX_IMAGE to the resulting absolute directory in the trusted environment.
```

Do not build using real secrets in the image configuration. Review/pin guest package inputs and image checksums for a stricter supply-chain policy; this config pins the Alpine release and SDK/helper version, not every APK dependency.

The GitHub deployment workflow writes the optional repository variables `BOT_SANDBOX_IMAGE` and `BOT_SANDBOX_ALLOWED_HOSTS` to `.env`; Compose passes them to the bot. No new GitHub secret is required. Empty variables use the built image and default host policy.

KVM is not enabled by this change. Without accessible hardware acceleration, QEMU uses TCG and can be substantially slower or incompatible with a particular host/image combination. Granting `/dev/kvm` requires an operator-reviewed Compose override with the device and its group, not `privileged: true`. Validate the exact host, seccomp profile, guest image and backend before rollout. Do not weaken isolation or enable host execution to pass a health check.

## What remains trusted

MCP servers (including stdio processes), URL/media conversion, image preparation/generation, publishing, and other explicitly authorized application tools are still host or external services. They do not become sandboxed because CodeMode's shell runs in a VM. Review their capabilities and credentials separately. Host-side approved mount providers and image preparation remain part of the trusted computing base.

This is not protection against a malicious host account, VMM vulnerabilities, side channels or complete denial of service. Writable mounts retain potentially hostile modifications across calls. Commands with external effects remain replay-unsafe; only reads are replay-safe. No claim of exactly-once effects, independent security audit, or production rollout is made.

## Verification and rollout gate

`tests/gondolin.test.ts` covers real Durable direct/nested dispatch with a mocked VM transport, VM cleanup, failed creation, revocation during setup, late creation after cancellation, shutdown, capacity cancellation, guest path mapping, egress/IP policy, placeholders, and the actual published host provider's symlink rejection. Existing harness/transport fixtures explicitly inject local execution; they do not count as VM execution tests.

On 2026-11-24, root `format:check`, `lint`, `typecheck`, `build`, and `git diff --check` passed. The focused sandbox/skill suite passed 18 tests at default timeouts. A complete bot run passed 2,297 tests across 146 files with `npm --ignore-scripts test --workspace @narumitw/sumire -- --testTimeout=30000 --hookTimeout=30000 --maxWorkers=2`. The other workspaces passed 2,014 tests. Root `npm test` at default 5-second test bounds did **not** pass: the latest constrained-worker attempt had four timeouts in existing bulk notification, chat-directory capacity, and provisional MCP-registration cases. Their source timeouts were not relaxed in the repository. These are successful distinct suite runs, not a clean default all-workspace test run.

Real VM execution and a full Docker image build must also pass before rollout. The checked-in custom guest configuration successfully built on arm64 (SDK 0.14.0 helpers, build ID `4efbfc80-f82d-5038-90d4-7531b916c862`); that is guest-image build evidence, not a complete Docker build or successful VM run. In this development environment (Linux arm64, no `/dev/kvm`, Debian QEMU 7.2.22 extracted into a private tools directory), the published `alpine-base:0.4.0` image emitted boot but did not complete guest exec: default VFS readiness timed out after 60 seconds; without VFS, boot completed but `uname` did not return within five seconds. Both attempts awaited VM close. The custom image then exposed a missing iPXE ROM in the private test installation; after providing those ROMs, its VFS readiness still timed out after 30 seconds. The Docker runtime now explicitly installs `ipxe-qemu`, including with `--no-install-recommends`. This is a host/backend/image compatibility blocker, **not** successful smoke-test evidence and not a diagnosed Gondolin root cause.

After building the bot, run `BOT_SANDBOX_IMAGE=/absolute/guest/path node apps/bot/scripts/check-gondolin.mjs` on a staging host. This offline check exercises actual guest commands and bundled tools, read/write symlink denial, workspace persistence, and fresh rootfs state without using real credentials. It fails if any guest command fails, including Otter, Git, or GitHub CLI.

The takeover branch passed this offline check on Linux x86_64: the Docker `gondolin-image` target built guest `5e765c06-afa5-5a98-87ca-0f35ef3e6f35`, and a separate Debian Bookworm test container ran it as a non-root user with QEMU 7.2 TCG and no container network. The full production image build stopped at a Debian package checksum mismatch. This smoke pass does not verify the production image or the staging checks below.

On a staging host, also verify command execution/exit status, read/write/multi-edit and images, truncated-output follow-up reads, per-chat isolation, symlink escape denial for reads and writes, read-only skills, blocked metadata/private destinations and redirects, wrong credential destinations, cancellation with a delayed write, owner shutdown, and absence of residual QEMU children. Measure cold/warm startup, peak memory and command latency. Exercise approved GitHub/Otter reads without logging credentials. Do not merge/deploy on mock evidence alone.

References: [v0.14.0 VM API](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/sdk-vm.md), [VFS](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/vfs.md), [network](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/sdk-network.md), [secrets](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/secrets.md), [security model](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/security.md), [Docker security](https://docs.docker.com/engine/security/).
