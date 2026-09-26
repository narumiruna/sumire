# Separate Sumire runtime code from the persistent workdir

## Goal

Run the bot from image-managed `/app` while Pi's writable working directory and a newly created `workdir` volume live at `/workdir`. Rebuilding the image must update the bot while preserving new user files and handling existing chat history explicitly.

## Context

- `compose.yaml` mounts `workdir:/app`, masking the code copied into `/app` by `Dockerfile`; it separately mounts instructions, skills, events, state, and Whisper cache below `/app`.
- `apps/bot/src/startup.ts` locates the repository root from the entrypoint path. `apps/bot/src/config/settings.ts` uses that root for instructions, skills, and session storage; `apps/bot/src/agent/pi-session-factory.ts` also uses it as the Pi tool `cwd` and session `cwd`.
- Pi's installed `SessionManager.continueRecent(cwd, sessionDir)` filters existing sessions by their stored `cwd` when given this explicit chat session directory. Switching from `/app` to `/workdir` without a session decision would stop automatically resuming the `/app` sessions, even though the separate `state` volume retains them.
- The operator reports that Sumire is stopped and `sumire_workdir` has already been removed. Treat contents of that volume (including any `/app/.ssh` files) as unavailable unless an external backup exists; verify on the deployment host before proceeding. The separately mounted `state` volume may still hold old Pi sessions and must be checked independently.
- Deployment builds the image and runs `docker compose up -d --no-build --remove-orphans` (`.github/workflows/deploy.yml`); there is no explicit force-restart. Local development should retain its repository-root tool cwd by default.

## Session decision

The operator chose option 2: start new Pi conversations after changing the cwd to `/workdir`. Do not migrate or delete the old `/app` sessions in the separate `state` volume. The existing reply index must ignore checkpoints from old sessions; a test must confirm this before rollout.

## Architecture

Keep executable code, dependencies, instructions, bundled skills, and the current dedicated state/events/cache mounts under `/app`. Re-create the named `workdir` volume only at `/workdir`; set container `WORKDIR`, the app user's home (`HOME` and passwd entry), and Pi's tool/resource/session `cwd` to `/workdir`. Introduce a separately configurable bot workdir in `Settings` (local default: project root; container: `/workdir`), while preserving project-root paths for bot resources and `.telegramagent` sessions. The absolute `/app/apps/bot/dist/index.js` entrypoint remains image-managed. This separates persistence from deployment; it does **not** sandbox Pi's tools or make `/app` inaccessible by absolute path.

## Plan

- [ ] Confirm on the deployment host that Sumire is stopped, `sumire_workdir` is gone, and the separate `state`, `events`, and `whisper-cache` volumes still exist; inspect only the `state` session headers for `/app` cwd without printing secrets. Back up `state` to protected off-repository storage and verify the backup is readable before deployment. Evidence: operator records the volume inventory and backup/restore-read check without committing or logging private data. Local OrbStack inspection found `sumire_state`, `sumire_events`, and `sumire_whisper-cache`, but not `sumire_workdir` or a running Sumire container; **state backup remains unverified**.
- [x] Verify the accepted fresh-session behavior: `apps/bot/tests/pi-session-factory.test.ts` exercises a stored old-cwd session and a new-cwd session in the same directory; `apps/bot/tests/session-registry.test.ts` confirms stale reply session IDs are ignored. Evidence: focused and full bot tests pass; operator chose new conversations in chat.
- [ ] Change `compose.yaml` to mount `workdir:/workdir` without touching the dedicated `/app` mounts; adjust `Dockerfile` so `/workdir` exists, is writable by the `app` user, and is the process working/home directory. Keep the entrypoint and package paths under `/app`. Evidence: `docker compose config --no-env-resolution --quiet` and `docker buildx build --check .` pass; image/container check remains open until it is safe to build and run without affecting the stopped deployment.
- [x] Separate bot resource root from Pi cwd in `apps/bot/src/config/settings.ts` and `apps/bot/src/agent/pi-session-factory.ts`, with an explicit container workdir and unchanged local default; retain root paths for instructions, skills, state, and cache. Evidence: settings and Pi integration tests pass for tool paths, skill loading, and fresh sessions.
- [x] Update `.env.example`, `apps/bot/README.md`, and deployment instructions for the new path, home/SSH key behavior (old keys require an external backup or regeneration), fresh volume creation, and the session decision. Evidence: `apps/bot/README.md` documents the migration, `docker compose down -v` warning, and `.changeset/separate-bot-workdir.md` bumps `@narumitw/sumire`.
- [x] Verify from the repository root with `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`, plus `git diff --check` and `docker compose config --no-env-resolution --quiet`. Evidence: all commands passed after the code and tests were changed.

## Completion Checklist

- [ ] On a test deployment with a fresh `workdir` volume, rebuild and recreate the container; confirm it runs the new image code, reads instructions/skills from `/app`, writes Pi tool files in `/workdir`, and retains those files across another recreate. Evidence: container path/mount inspection and a bot/Pi smoke test (including `/id` if `BOT_ADMIN_ID` is set).
- [ ] Verify on deployment that old `/app` sessions remain archived and new `/workdir` sessions start without restoring old reply checkpoints; confirm `events`, `state`, and Whisper cache volumes remain mounted and usable. Evidence: fresh-session smoke test and mount inspection.
- [ ] Confirm the production backup, rollout/rollback steps, and any PR changeset with the deployment operator before applying the production migration. Evidence: operator acceptance and recorded deployment result; otherwise leave this checklist item open.

## Rollback / Recovery

The operator has already stopped Sumire and removed `sumire_workdir`; do not assume its files or SSH keys can be recovered. Before rollout, verify and back up the separate `state` volume to protected storage outside the repository; preserve ownership and permissions. A fresh `workdir` volume will be created at `/workdir`, so restore any required files from an external backup or regenerate keys securely. To roll back, use the previous image and Compose configuration: `workdir:/app` would then initialize another fresh volume from the old image, **not** restore the deleted volume's files. If new writes to `state` prevent older code from using it, consider restoring its pre-migration backup after reviewing any messages received since backup. Do not use `docker compose down -v` for rollback.
