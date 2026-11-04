# Service status notifications

Sumire sends GitHub, OpenAI, Claude, and Cloudflare incidents to selected Telegram users, groups, and channels. Each chat can inherit shared defaults or use its own subscription. Notifications use source text and fixed labels, without a model, Pi tools, or Morsel.

## Setup

1. Open `/admin` and select **Service status**.
2. Select destination chats from the stored directory. Search and pagination cover stored chats, not all Telegram chats.
   - To add an unlisted destination, expand **Add an exact Telegram chat ID**. Use a positive private-user ID or a negative group/channel ID. Usernames and invite links are not accepted.
   - Private recipients must first send `/start` to the bot. Add the bot to groups and permit messages. Channels require bot administrator permission to post messages.
3. Set shared services, minimum impact, component selections, and timing.
4. Use **Edit subscription** or **Per-chat subscription** to set destination overrides. Missing override fields inherit shared defaults. Explicit empty selections do not inherit.
5. Select **Review and save changes**, confirm, and check that the saved revision is applied.
6. Use **Manual test** to confirm a fixed test message to a saved destination. This action works while automatic notifications are disabled. It does not save drafts or enable automatic delivery.
7. After verifying destination rights and the test result, enable automatic notifications and save/apply the change.

Selecting a notification destination does not grant model or tool access. Removing ordinary chat approval does not remove a notification subscription. Remove its destination or source subscription here to stop these notices.

## Settings and inheritance

| Setting | Default | Scope and behavior |
| --- | --- | --- |
| Enable notifications | Off | Shared gate for automatic reads and delivery. Explicit administrator test sends are separate. |
| Destinations | None | Up to 1,000 unique, non-zero safe-integer chat IDs. One subscription per chat. |
| Polling interval | 60 seconds | Shared integer from 60 to 3,600 seconds. One read per needed provider, not per chat. |
| Services | All four | Shared default with per-chat overrides. An explicit empty list sends nothing for that chat. |
| Minimum impact | Minor | Shared default with per-chat overrides: `none`, `minor`, `major`, or `critical`. |
| Components and groups | All | Shared per-provider defaults with per-chat overrides. All, none, and selected IDs are different choices. |
| Daily quiet window | Off | Shared default with per-chat overrides; explicit IANA time zone and start/end times. |
| Group ordinary updates | Off | Shared default with per-chat overrides: off, 60, 300, or 900 seconds. |
| Notify incident updates | On | Shared. Suppressed update transitions are processed without later replay. |
| Notify resolved incidents | On | Shared. Confirmed recovery is sent for previously delivered or deferred active issues. |
| Include scheduled maintenance | Off | Shared. Maintenance is independent of the incident impact threshold. |

The shared service list is a default, not a global permission limit. A chat with an explicit OpenAI subscription can continue to receive OpenAI notices when OpenAI is removed from shared defaults. The worker reads the union of effective source selections. It prunes delivery state against each chat's effective subscription, not that union.

Settings remain in `Policy.statusNotifications` in `.telegramagent/admin.sqlite`. `chatOverrides` can only reference selected destination IDs. Removing a destination also removes its overrides. Old policies default to all components, no quiet hours, no grouping, and no overrides, without resetting successful delivery checkpoints.

A component list can contain at most 128 IDs; all component references across shared defaults and overrides are limited to 512. Full settings requests remain limited to 262,144 UTF-8 bytes. The Web UI checks this limit before review and save. No new environment variable, key, or GitHub Actions value is required.

## Component and region coverage

Selections use stable provider IDs. Groups include their current published descendants, including newly published children. Sumire does not infer products or geography from names. Flat providers remain flat; group metadata is used only when the provider supplies it.

- **All components** includes the provider-wide indicator and component state.
- **No components** excludes that provider's incidents for the subscription.
- **Selected components or groups** uses only associated incidents and selected component status. A provider-wide indicator alone cannot prove that a selected component is down or recovered.
- Incidents without known component associations do not match an explicit selection. This can reduce coverage; choose all components if unclassified incidents must be included.
- Missing selected IDs remain visible as unavailable. A failed or incomplete catalog does not broaden the selection or establish recovery.
- Matched incident parent metadata is retained for later terminal updates that omit components. Missing intermediate ancestry in a nested group stays conservative; it does not invent an association.

Detailed incidents suppress an aggregate notice only when eligible details cover its applicable components and impact. An unrelated or lower-impact incident cannot hide a selected component outage. `degraded_performance` maps to minor, `partial_outage` to major, and `major_outage` to critical. The aggregate uses the highest applicable impact. Unknown component states do not establish recovery.

Component catalogs can be read before automatic delivery is enabled. Reads are cached for 60 seconds; concurrent refreshes share one request. A failed refresh can show the old catalog with a stale/error marker, but the worker does not use that stale response as a successful status observation.

## Quiet hours and grouped updates

A daily quiet window uses an explicit IANA time zone. The editor initially offers `Asia/Taipei` when enabling it. The start is inclusive and the end is exclusive. Overnight windows are supported; equal start/end times are rejected. There is no weekday schedule or critical-impact bypass.

The scheduler uses Node.js 26's native Temporal API. Repeated local-time boundaries use the earlier occurrence. Nonexistent boundaries shift forward by the offset gap. UTC instants determine membership, so a repeated hour does not reopen an ended window. The host time zone does not change the subscription.

During quiet hours, provider reads continue and eligible notices are stored in SQLite. At the end of the window, deferred changes can be sent in bounded summaries. If a qualifying issue improves below the threshold before delivery, the summary shows its highest observed impact separately from its latest lower impact; a minor-only issue cannot qualify for a major subscription. An issue observed both starting and resolving during the window is labeled as having occurred and recovered, not as a new active outage. Polling can still miss an issue that starts and ends between reads.

Outside quiet hours:

- New incidents, severity escalations, and confirmed recoveries are immediate.
- Ordinary updates can use a fixed grouping window from the first pending update. Later updates replace the content and increment the change count without extending that window.
- A recovery replaces an outdated queued active update for that event.
- Grouping remains off for existing subscriptions unless explicitly selected.

One scheduler wakes for provider polling, pending delivery, quiet-window boundaries, or applied settings changes. It does not create one polling loop per chat. Failed sends remain pending and retry after 60 seconds. A failed provider read does not establish recovery or release notices based on that failed observation.

## Persistence and duplicate prevention

All status state uses the existing administration database and its single-process owner:

| Table | Purpose |
| --- | --- |
| `status_deliveries` | Per-chat/provider/event processing checkpoints, content fingerprints, active state, and matched component metadata. |
| `status_pending` | Versioned deferred notifications, latest source content, fixed due times, change counts, and effective-rule fingerprints. |
| `status_source_health` | Last source attempt, success, and failure. |
| `status_delivery_health` | Last destination attempt, success, and failure, including separate manual-test results. |
| `status_meta` | Service schema version and monotonic queue version. Unknown newer schema versions stop status initialization. |

Unchanged acknowledged content is skipped after restart. A queued notification is stored before sending. After success, checkpoint acknowledgement and removal of that sent queue version share one transaction. A newer version admitted during a send remains pending.

An unrelated policy revision does not discard pending work with unchanged effective rules. Changing a subscription cancels its obsolete queued work. Removing a destination/source or disabling automatic delivery removes affected pending notices without reporting delivery or recovery. Inactive checkpoints expire after 30 days. Active incident checkpoints remain until confirmed terminal state or subscription removal.

An incident missing from summary is checked through `/api/v2/incidents/{id}.json`. Only `resolved`, `postmortem`, or `completed` confirms terminal state. HTTP errors, unknown records, malformed responses, and timeouts do not. Recovery scans allow at most 12 missing events per provider/poll, in groups of four, with rotation.

The queue permits at most 100 entries per chat, 10,000 entries globally, 256 KiB of serialized event data per entry, and 16 MiB globally. If admission reaches a limit, the unsent checkpoint is not advanced and recent results show `queue_full`. There is no unbounded incident archive or promise to retain every intermediate update.

Messages remain below 1,000 Unicode code points, with canonical source links and no link previews. Summaries split at complete event boundaries. Source names, bodies, and component lists are bounded. Maintenance timestamps use UTC. Automatic and manual sends share the transport limit: at least 100 milliseconds after a settled attempt, with a five-second timeout for each send.

Telegram delivery and SQLite acknowledgement are not atomic. A crash after Telegram accepts a message but before local acknowledgement can cause a duplicate. Exactly-once delivery is not guaranteed. A failure or timeout can also leave the upstream outcome uncertain; inspect Telegram before manually repeating an uncertain test.

## Manual tests and recent results

**Manual test** uses only saved, applied destinations. The confirmation captures the current revision. A draft-only destination cannot be tested, and a revision conflict requires reloading rather than automatic retry. A confirmed manual test bypasses quiet hours and grouping and can run while automatic notifications are off. It sends fixed test text, does not change incident checkpoints or pending incidents, and grants no chat permissions.

Each destination permits one test attempt per minute, including concurrent requests and restarts. Attempts and outcomes are audited without raw upstream errors. Session expiry, policy changes, request cancellation, and shutdown prevent subsequent sends and interrupt current requests where possible. Telegram cannot recall a message already accepted.

**Recent delivery results** is read-only. Refresh and pagination do not send or retry notices. It shows separate timestamps for the last attempt, success, and failure, fixed diagnostic codes, pending counts, next due times, and source-fetch results. Success means Telegram accepted a message, not that a recipient read it. An old success is not proof of current permission. Results survive restart but are not a full message history.

Authenticated administration APIs are:

- `GET /api/service-status/components?provider=<supported-id>`
- `GET /api/service-status/deliveries?offset=0&limit=100`, with optional `chatId` and `provider` filters
- `POST /api/service-status/test` with `{ "chatId": 42, "revision": 1, "confirm": true }`

Mutations use the existing session, Origin, CSRF, and request limits. Test requests are limited to 4,096 bytes. Unsupported providers, duplicate/unknown filters, invalid destination IDs, and stale revisions are rejected. API results do not contain credentials, raw transport exceptions, or arbitrary provider bodies.

## Source defenses

The reader uses only these public endpoints and their same-origin incident-detail paths:

- <https://www.githubstatus.com/api/v2/summary.json>
- <https://status.openai.com/api/v2/summary.json>
- <https://status.claude.com/api/v2/summary.json>
- <https://www.cloudflarestatus.com/api/v2/summary.json>

Each request rejects redirects and has a 15-second deadline and streamed 2 MiB response limit. Incident links use fixed origins and validated IDs. Upstream page URLs and shortlinks cannot change the request target. Provider content remains untrusted data.

## Upgrade and rollback

1. Before a production upgrade, disable automatic status notifications and apply the change. Stop the service with `docker compose stop sumire` from the repository root.
2. Back up `.telegramagent/admin.sqlite` from the persisted state volume to restricted storage while the service is stopped. Compose stores it at `/app/.telegramagent/admin.sqlite` inside the container. Retain the matching previous source revision/image. Keep backups out of Git and public artifacts.
3. Deploy the new build with the same state volume. Existing processing checkpoints are migrated in place; new pending/result tables are added. Verify applied settings and destination permissions before enabling notifications.
4. To roll back, stop the new service and restore the complete pre-upgrade administration database backup in its original volume, with its original owner and restrictive permissions. Select the matching previous build before restarting. Do not remove conversation storage or the whole state directory.
5. Keep automatic notifications disabled until supported subscriptions are reviewed and a test destination is verified.

The old settings schema is strict and cannot parse new override, component, or timing fields. Running an old binary directly against the upgraded database is not a supported rollback. Do not delete new fields by hand: that can remove restrictions and broaden delivery. If no valid pre-upgrade backup exists, keep the service stopped and recover with a supported build; do not guess a downgrade conversion.

Synthetic tests verify old-table migration, preserved checkpoints, future-schema rejection, and restoration of a stopped pre-upgrade database. They do not prove that an operator has made a production backup.

## External deployment checks

**Telegram administrator:** Use an authorized test destination after deployment. Confirm private-recipient `/start`, group send permission, and channel posting rights. Confirm receipt of the explicit test message and its result in Service status. Local mocks test application behavior, not live Telegram permission or device receipt. Do not enable unverified production destinations or claim live delivery acceptance before this check.

**Deployment operator:** Stop the service, make the restricted database backup, and retain the matching previous build before upgrading production. Verify that the restore procedure and backup are available. Do not upgrade production without this recovery prerequisite.

No live Telegram send, account permission change, or production database operation is performed by local implementation tests. No new GitHub Actions secret or variable is required.
