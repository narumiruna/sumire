# Service status notifications

Sumire can send GitHub, OpenAI, Claude, and Cloudflare service incidents to multiple Telegram users, groups, and channels. Notifications use source text and fixed labels. They do not use a model, Pi tools, or Morsel.

## Setup

1. Open `/admin` and select **Service status**.
2. Select the services to monitor.
3. Select destination chats from the stored directory. Search and pagination cover the stored directory, not all Telegram chats.
   - To use an unlisted destination, expand **Add an exact Telegram chat ID** and add its numeric ID. Use a positive ID for a private user or a negative ID for a group or channel. Usernames and invite links are not accepted.
   - Private recipients must first send `/start` to the bot. A bot cannot start a private conversation.
   - Add the bot to each group and permit it to send messages.
   - For channels, make the bot an administrator with permission to post messages.
4. Set the notification filters and enable notifications.
5. Select **Review and save changes**, then confirm the review. Only the current, successfully applied revision can send notifications. An enabled subscription with no sources or destinations sends nothing.

Notification destinations are independent of chat approval. Selecting a destination does not authorize model requests or tools. Removing ordinary chat approval does not remove a notification destination; remove it on **Service status** to stop these notices.

## Settings

All selected destinations use the same service and filter settings.

| Setting | Default | Behavior |
| --- | --- | --- |
| Enable notifications | Off | Stops all status reads and sends when disabled. |
| Services | All four | GitHub, OpenAI, Claude, and Cloudflare can be selected separately. |
| Destinations | None | Up to 1,000 unique, non-zero safe-integer Telegram chat IDs. |
| Polling interval | 60 seconds | Integer from 60 to 3,600 seconds. The next poll starts after the previous poll finishes and this delay expires. |
| Minimum impact | Minor | `none`, `minor`, `major`, or `critical`. `none` includes informational incidents. |
| Notify incident updates | On | Sends changes to active incidents already delivered to that destination. |
| Notify resolved incidents | On | Sends confirmed recovery only to destinations with a previously delivered active issue. |
| Include scheduled maintenance | Off | Includes maintenance notices independently of the minimum incident impact. |

The Web UI offers common polling intervals and preserves other valid saved intervals. Settings are stored in `Policy.statusNotifications` in `.telegramagent/admin.sqlite`. Existing policies default to disabled notifications. No new environment variable, API key, or deployment secret is required.

## Data and delivery

The reader uses these fixed endpoints:

- <https://www.githubstatus.com/api/v2/summary.json>
- <https://status.openai.com/api/v2/summary.json>
- <https://status.claude.com/api/v2/summary.json>
- <https://www.cloudflarestatus.com/api/v2/summary.json>

Each request rejects redirects and has a 15-second deadline and a streamed 2 MiB response limit. Incident links are built from the fixed source origin. Upstream links cannot change the request target. Source text remains untrusted data.

Eligible detailed incidents take precedence over aggregate notices only when they cover the aggregate impact and each affected component's impact. Maintenance components require maintenance details. Filtered, lower-impact, or unrelated incidents do not suppress aggregate alerts. Degraded page or component status can otherwise produce an aggregate notice. This supports providers that omit incident arrays, including OpenAI. Component impact mapping is deterministic: `degraded_performance` is minor, `partial_outage` is major, and `major_outage` is critical. The aggregate uses the highest component or page impact. Maintenance-only components are excluded unless maintenance is enabled.

- The first active poll sends current eligible issues, not historical resolved incidents.
- A change in title, body, status, impact, affected components, or maintenance schedule can produce an update. Changes only to timestamps or array order do not.
- An incident that disappears from summary remains active until `/api/v2/incidents/{id}.json` confirms a terminal status: `resolved`, `postmortem`, or `completed`.
  - HTTP failures, malformed data, missing records, and timeouts do not establish recovery.
  - Each provider has at most 12 missing-incident checks per poll, in groups of four. A rotating scan gives later records a turn.
- An aggregate notice recovers only when a successful summary has a healthy page indicator and explicitly operational components. Maintenance components can be excluded by the maintenance setting. Unknown component states do not establish recovery.
- Unchanged notices are not sent again after a restart. Each destination has a separate acknowledgement in the `status_deliveries` table.
- A failed send does not acknowledge delivery. A later poll retries the latest available state for that destination. It does not replay every intermediate update.
- Disabling update or recovery notices consumes those transitions without sending them. Enabling them later does not replay suppressed history.
- Removed destination or source checkpoints are deleted on the next poll with applied settings. Inactive checkpoints expire after 30 days. Active incident checkpoints remain until confirmed recovery.

Each message is plain text, below 1,000 Unicode code points, with a canonical source link. Long source text and component lists are shortened. Maintenance times use UTC. Link previews are disabled. The worker waits at least 100 milliseconds after each successful or failed send attempt before the next attempt. It uses a monotonic clock, so wall-clock changes do not shorten this interval. Each send has a five-second timeout. A failure at one provider or destination does not acknowledge another destination. Failures appear in service logs; saved settings do not prove Telegram delivery permission.

Settings changes are checked before new reads and sends. A one-second guard cancels in-flight work if the applied revision changes. A request already accepted by Telegram cannot be recalled. Disablement or shutdown prevents later sends but does not delete messages already delivered.

## Limits and recovery

Polling is not an event archive. An incident that starts and ends between polls can be missed. Provider publication delays and failed polls can delay notices. General bot startup still requires the existing bootstrap configuration, but notifications themselves do not require a configured model.

Only one bot process can own the administration database. Telegram sends and SQLite acknowledgement are not atomic. A crash after Telegram accepts a notice but before its acknowledgement is committed can cause a duplicate after restart. Failed sends do not provide exactly-once delivery.

Disable **Service status** to stop new sends. Keep the administration database and its delivery table during an upgrade or rollback. The table is additive and does not replace conversation or policy storage.

## Deployment verification

Local tests use mock provider responses and Telegram transports. Live Telegram delivery is not verified without an authorized destination. Before enabling production notifications, the Telegram administrator must check private-recipient consent, group membership, and channel posting rights. A stored chat name or saved subscription is not evidence of those rights. Deployment needs no new GitHub Actions secret or variable.
