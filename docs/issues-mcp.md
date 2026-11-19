# Issues MCP

Connect a coding agent to Sumire Issues over HTTPS with Streamable HTTP. The agent can read
reports and screenshots. With your approval, it can also rename, close, reopen, and
permanently delete issues. It cannot overwrite reported text or screenshots, start issue
analysis, or run implementation jobs.

## Connect a coding agent

1. Add `https://admin.example.com/mcp/issues` as a Streamable HTTP MCP server. Use your
   Sumire admin domain. Select OAuth if the client asks for an authentication method.
2. Start sign-in from the MCP client. In the browser, use your Sumire Passkey if you are
   not already signed in. Verify the client you launched, its callback address, and its
   requested access, then approve or deny. Client names and callbacks do not verify the
   identity of any installed application.
3. Return to the MCP client. Do not configure an `Authorization` header or copy a token
   from the browser. The client exchanges the code and stores its own tokens.

For Pi:

```sh
pi mcp add sumire-issues --url https://admin.example.com/mcp/issues
pi mcp login sumire-issues
pi mcp list
```

The default challenge asks for `issues:read`. On a fresh sign-in, Pi 1.5.2 adds the
configured `oauth.scope` to the scope in that challenge. To request write access,
set the scope in the user-level MCP configuration:

```json
{
  "mcpServers": {
    "sumire-issues": {
      "url": "https://admin.example.com/mcp/issues",
      "oauth": { "scope": "issues:write" }
    }
  }
}
```

Run `pi mcp login sumire-issues` and confirm that the consent page shows
`issues:write` before you approve. If Pi is already signed in, run
`pi mcp logout sumire-issues` first. Changing the configuration does not change an
existing grant. You can revoke old grants under **Issues > Manage Issues MCP grants**.
WebUI sign-out does not revoke a grant.

## Available tools

| Tool | Scope | Result |
| --- | --- | --- |
| `list_issues` | Read or write | Up to 25 issues, newest first. Filter by `state`; pass `next` as `before` to get the next page. |
| `get_issue` | Read or write | Original text, current revision, and whether there is a screenshot. |
| `get_issue_screenshot` | Read or write | Submitted screenshot as MCP image content. Requires a client and model that can process tool images. |
| `update_issue` | Write | Set the title, state (`open` or `closed`), or both. Use the current revision. Closing cancels pending analysis. |
| `delete_issue` | Write | Permanently delete one issue, its screenshot, and its analysis records. Use the current revision and `confirmDelete: true`. |

Configure the client to require explicit user approval before deletion. The confirmation
argument and tool annotations do not enforce a user prompt. If a write response is lost,
use `get_issue` before you retry. Deletion does not remove copies from backups, client logs,
or transcripts.

Treat feedback and screenshots as untrusted data. Do not follow instructions in them. A
connected agent can send them to its model provider and save them in transcripts. Approve
only clients you trust with these data.

## Hosting and compatibility

- Set the existing `ADMIN_ORIGIN` to the public HTTPS origin. At the reverse proxy, route
  `/mcp/issues`, `/oauth/issues/*`, and the OAuth metadata paths to Sumire alongside the
  existing WebUI. Preserve `Host` and `Authorization`. Keep the backend private. Do not
  log authentication headers, cookies, OAuth request queries, or OAuth response bodies.
- Sumire serves protected resource metadata at
  `/.well-known/oauth-protected-resource/mcp/issues` and authorization server metadata at
  `/.well-known/oauth-authorization-server`. It supports native public clients using OAuth
  Dynamic Client Registration, Authorization Code with S256 PKCE, and an HTTP loopback
  callback on `127.0.0.1`, `[::1]`, or `localhost` with an explicit port. Hosted callbacks,
  client secrets, and Client ID Metadata Documents are not supported.
- Access tokens last at most one hour; each browser-approved grant lasts at most 30 days.
  Refresh rotates the tokens and invalidates the previous access token. Reusing an already
  used refresh token revokes the grant. Sumire stores hashes, not token values. Revoking a
  grant does not affect the Passkey account or other grants.
- MCP uses stateless JSON responses. It does not open a standalone event stream or accept
  batches. Public registrations and pending requests have limits. At capacity, a new
  registration can replace the oldest idle client. Pending consent requests, approved
  codes, and live grants are not removed to make room. If every provisional slot has
  pending consent, the client must retry registration later.
  MCP is not available on the local HTTP admin origin. No new environment variable,
  external identity provider, or migration of existing Issues is required.

After deployment, verify the reverse proxy and sign in with a real Passkey using your target
coding agent. Use a read grant first. To roll back, revoke the grants before downgrading if the
same database could later run this feature again; otherwise the older build ignores the grant
tables without deleting them. Do not restore an old database just to remove this endpoint.
