# Passkey login

## Goal

Replace Telegram Web Login for the administration WebUI with WebAuthn passkeys. Retain HTTPS, the bootstrap `BOT_ADMIN_ID`, session controls, and chat access boundaries. Do not change provider OAuth or Telegram `/login`.

## Architecture

The private `/admin` command can issue a five-minute setup link only when the configured administrator has no passkey. Store only the token hash. Put the token in a URL fragment and remove the fragment before network requests. Require same-origin JSON requests, one-use browser-bound challenges, user verification, exact origin, RP ID, and verified signatures. Consume setup tokens in the registration transaction. No public first-user registration is allowed. Existing passkeys prevent further bootstrap links.

## Plan

- [x] Add the server and browser WebAuthn libraries and verify their contracts.
- [x] Add an additive database migration for passkeys and pending challenges. Revoke old Telegram sessions. Preserve policies, provider state, and transcripts.
- [x] Replace the WebUI login endpoints and page. Remove Telegram Web Login bootstrap settings. Make `/admin` issue setup links before first registration and ordinary links afterward.
- [x] Test registration, authentication, replay, expiry, browser binding, unauthorized setup, signature/origin/RP/user-verification checks, counters, migration, and the browser flow.
- [x] Update setup and recovery guidance and changesets. All five required root checks passed. The root suite passed 1,339 tests across 91 files. All 11 browser tests passed, including a Chromium virtual-authenticator registration and sign-in. The Docker image build and offline HTTPS smoke passed on the runtime image.
- [x] Publish the implementation and record its commit. Commit `b3632d8` is pushed to PR #90.
- [ ] After deployment, the administrator must register and use a real device passkey on the configured HTTPS domain. Verify denied setup and login, recovery, and matching image/state rollback.

## Rollback / Recovery

Back up administration state before upgrade. The new schema must refuse older binaries; rollback needs the matching old database backup. If all copies of the passkey are lost, a trusted operator must stop the bot, back up state, remove passkey credentials, pending setup/challenges, and sessions, then restart and use `/admin` to enroll again. Do not delete policies or transcripts. The task does not change a running production service or production credentials.

## Completion Checklist

- [x] All source changes and regression tests pass the required checks.
- [x] The published change includes setup and recovery instructions in `docs/admin-webui.md`.
- [x] Record validation limits. Real device enrollment and production administrator acceptance require the administrator and deployment access. Fixtures do not prove these checks. No production bot, credentials, or state volume was changed. `npm audit` still reports the pre-existing Handlebars critical advisory; there is no new advisory in the added dependencies.
