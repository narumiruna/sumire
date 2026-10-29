# @narumitw/sumire-github-notifications

## 0.2.0

### Minor Changes

- 825ca3c: Replace Telegram notification recipients with GitHub mention author usernames. Reply on GitHub only to allowed authors who directly mention the account authenticated by GH_TOKEN. Add bounded polling, isolated Pi Durable generation, persisted response recovery, and delivery authorization checks.
  
  Migrate legacy Telegram ID lists to empty GitHub allowlists under admin schema v5. Remove the Telegram notification-reading tool and update the administration page, setup guidance, and compatibility links.
- 316f0d5: Add bounded read-only GitHub notification tools that share the applied encrypted GH_TOKEN with GitHub CLI. Manage private Telegram recipients on a dedicated administration page with validated policy storage, review, application, and conflict recovery. Preserve normal tool permissions for direct and codemode execution.

### Patch Changes

- ffa6896: Refresh managed GitHub credentials before enabled mention polls. Keep disabled-policy and cancellation checks around credential resolution.
  
  Save per-account scan continuations after complete pages. Recheck the saved page boundary before continuing. Restart a moved boundary without advancing the original cutoff. Resume bounded scans after restart and keep the original cutoff until the full scan completes.
  
  Recognize HTML comment delimiters only outside code so literal code does not hide a later direct mention.
- 9a7860e: Keep issue and PR body reply identities stable when unrelated thread activity changes updated_at. Check the bounded comment history for an existing body reply marker.
  
  Skip unavailable sources by structured HTTP status. Keep ordinary delivery failures local to one pending item and retain its saved answer for retry. Preserve access and cancellation checks before later work.
- 76b6b56: Use the applied managed GH_TOKEN for GitHub notifications and replace the generic recipient variable with a dedicated administration page. Store validated recipient IDs in policy settings with review, application, audit, and conflict recovery. Keep private-chat and tool permission checks before and after notification requests.
- f17ecad: Scan five GitHub notifications per operation. Even five PRs with three complete ten-page source histories stay below the existing 200-request limit. Keep the ten-page poll bound, saved page continuations, and outbox delivery. Document the smaller notification batches.
- fab0c1a: Isolate source pagination limits to the affected GitHub thread during mention discovery. Discard its incomplete sources, return a skipped-thread count, and keep other threads and saved replies moving. Preserve all other scan failures and bounded reply-marker checks.
