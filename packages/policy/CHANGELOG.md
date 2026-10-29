# @narumitw/sumire-policy

## 0.5.0

### Minor Changes

- 825ca3c: Replace Telegram notification recipients with GitHub mention author usernames. Reply on GitHub only to allowed authors who directly mention the account authenticated by GH_TOKEN. Add bounded polling, isolated Pi Durable generation, persisted response recovery, and delivery authorization checks.
  
  Migrate legacy Telegram ID lists to empty GitHub allowlists under admin schema v5. Remove the Telegram notification-reading tool and update the administration page, setup guidance, and compatibility links.
- 76b6b56: Use the applied managed GH_TOKEN for GitHub notifications and replace the generic recipient variable with a dedicated administration page. Store validated recipient IDs in policy settings with review, application, audit, and conflict recovery. Keep private-chat and tool permission checks before and after notification requests.

## 0.4.1

### Patch Changes

- 9377d61: Separate saved settings from local model setup, add long-list permission filters and fixed editing context, and edit shared model defaults in place. Keep provider authentication, global availability, and chat overrides separate.

## 0.4.0

### Minor Changes

- 6ea8d02: Add skill management to the administration WebUI with discovered descriptions, global availability, shared defaults, and per-chat inheritance or explicit selections. Apply selected skills to each chat’s prompt without changing tool access. Preserve existing policy data and manual removals through persistent first-seen skill registration.

## 0.3.1

### Patch Changes

- b0384ec: Update dependencies and restore compatibility with Pi 1.3 and TypeScript 7. Preserve durable tool output, MCP namespace discovery, and API generation. Remove lint, install, build, and experimental passkey warnings.

## 0.3.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.

## 0.2.1

### Patch Changes

- ae28992: Enable first-seen built-in and MCP tools in global and shared-default permissions. Preserve manual removals, explicit chat overrides, server gates, and chat access. Track registered names persistently and record automatic grants in the audit log. Keep startup available when permission lists are full. Register MCP names before authorization, but count only allowed tools against the runtime metadata limit.

## 0.2.0

### Minor Changes

- 0bd4846: Extract shared management API contracts and policy schemas and rules into private workspace packages. Remove administration frontend imports of bot source, and update dependency builds, Docker stages, and CI.
