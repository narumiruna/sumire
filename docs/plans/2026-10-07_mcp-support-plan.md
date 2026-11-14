# MCP support plan

## Goal

Provide authorized MCP capabilities with bounded execution, isolated chat resources, redacted results, and no automatic replay of side effects.

## Status and evidence

Implementation and review fixes are present in `apps/bot/src/agent/mcp-*.ts` and their tests. The original plan records passing root gates and live Firecrawl search smoke. Later Basic-auth fixes record 1,116 passing root tests and 110 focused tests.

Browser fixes `0cbda8e` and `5ce8fc3`, the Chromium wrapper, and the non-root seccomp profile supersede the original blanket sandbox-startup blocker. [Chromium deployment notes](../../apps/bot/resources/chromium/README.md) record sandbox-enabled launch evidence. That evidence does not establish successful MCP public-page snapshot/screenshot acceptance.

Current Compose mounts `mcp.docker.json`; desktop uses `mcp.json`. MCP is enabled by default and the old enable flag is removed. No checks were rerun during documentation cleanup.

## Plan

- [x] Implement configuration, discovery, exposure/authorization, redaction, transport lifecycle, and direct/nested recovery with regression tests.
- [x] Record historical root checks, Firecrawl smoke, package changes, and browser-startup follow-ups.
- [ ] Run and record the full public-page Chrome MCP snapshot/screenshot smoke in an isolated sandbox-capable deployment. Full end-to-end acceptance remains unverified.

## External Handoff

The deployment operator must provide an approved host with compatible user namespaces, seccomp configuration, and Chromium. Follow [Chromium in Docker and live verification](../../apps/bot/README.md#chromium-in-docker-and-live-verification). Expected result: Chrome MCP opens a public non-sensitive page, returns a page snapshot and screenshot, and the explicit Playwright path succeeds.

Record only sanitized actual MCP/browser versions, platform, arguments, and outcomes. Historical Firecrawl success does not verify current credentials or Chrome operation; any new Firecrawl request requires separate approval. Do not claim full MCP deployment acceptance until the outstanding smoke passes. Do not disable the sandbox or use privileged mode to bypass a failure.

## Completion Checklist

- [ ] Record passing Chrome public-page snapshot/screenshot and deployment smoke evidence.
- [ ] Retain version/platform details, Firecrawl evidence, and remaining deployment limits before deleting this plan.

## Rollback / Recovery

Use current tool/MCP policy and a compatible image/configuration to restrict the capability. Preserve state and inspect uncertain remote effects before an authorized retry. Do not automatically resend interrupted calls or restore the removed enable flag. MCP processes have the bot user's permissions; they do not inherit the URL reader's public-target defenses.
