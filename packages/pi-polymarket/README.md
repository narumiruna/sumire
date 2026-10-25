# Pi Polymarket

Pi tools backed by [`@polymarket/client`](https://github.com/Polymarket/ts-sdk/tree/main/packages/client) **0.14.0**. Requires Node.js 26 or newer.

The package exposes all **123 action methods** of the published default client. It does not execute model-supplied code. Public queries work without a wallet. Trading requires an authenticated client supplied by the host.

## Load the public extension

From the repository root:

```bash
npm ci
npm run build --workspace @narumitw/sumire-pi-polymarket
pi -e ./packages/pi-polymarket
```

This private workspace is not published to npm. Sumire bundles the public tools in each chat's Pi Durable runtime. Administrators must approve their tool names in the existing global and per-chat policies; deployment does not grant access automatically. The bot does not supply an authenticated client or enable trading.

## Tools

| Tool | Client operations |
| --- | --- |
| `polymarket_api` | Discover actions, exact SDK signatures, request schema hints, and handle methods. |
| `polymarket_discovery_query` | Search; markets, events, tags, series, sports, profiles, and comments. |
| `polymarket_market_data_query` | Order books, prices, spreads, price history, trades, holders, and open interest. |
| `polymarket_analytics_query` | Leaderboards, builder trades, and volumes. |
| `polymarket_account_query` | Positions, portfolio value, activity, PnL, account trades, and notifications. |
| `polymarket_account_execute` | Delete notifications. |
| `polymarket_rewards_query` | Market rewards, earnings, and order scoring. |
| `polymarket_wallet_query` | Trading approval state and collateral return plans. |
| `polymarket_wallet_execute` | Approvals, asset transfers, position split/merge/redemption, and collateral return execution. |
| `polymarket_orders_query` | Open orders, order details, and settlement status. |
| `polymarket_orders_execute` | Create/sign orders, submit orders, and cancel orders. |
| `polymarket_subscriptions_query` | Open public or authenticated SDK subscriptions. |
| `polymarket_perps_query` | Instruments, tickers, order books, candles, funding, trades, and registration. |
| `polymarket_perps_execute` | Open trading sessions, deposit, withdraw, transfer collateral, and revoke credentials. |
| `polymarket_rfq_query` | Wait for a combo fill. |
| `polymarket_rfq_execute` | Open RFQ sessions, request combo quotes, and accept quotes. |
| `polymarket_session_keys_query` | List session keys. |
| `polymarket_session_keys_execute` | Authorize and revoke session keys. |
| `polymarket_handle` | Continue pagination, transactions, streams, RFQ sessions, and Perps sessions. |

Authenticated-only tools and signatures are registered only when the host supplies `secureClient`. Perps APIs are experimental upstream.

## Call an action

First inspect its SDK signature:

```json
{ "method": "fetchOrderBook" }
```

Send this to `polymarket_api`. It returns the tool name, description, positional arguments, and request schema hints. Then call `polymarket_market_data_query`:

```json
{
  "action": "fetchOrderBook",
  "args": [{ "tokenId": "<token-id>" }]
}
```

`args` contains positional SDK arguments, not an extra wrapper around a single request. The SDK validates request values. Schema hints stop at nested type references; they are not a replacement for upstream types. No arguments are parsed as code.

Client selection defaults to `public`. Set `client` to `secure` to use the host account. Actions shared by both clients use the same signature unless `polymarket_api` lists a separate secure signature. Secure account methods can omit the account address.

Encode each `bigint` as an object with exactly one field:

```json
{ "$bigint": "1000000" }
```

For amounts that the SDK defines in six-decimal base units, this is one unit. Do not use this encoding for decimal-string prices or sizes unless the SDK signature requires `bigint`.

## Pagination and live handles

SDK pagination remains lazy. `listMarkets`, for example, returns:

```json
{
  "handle": "<opaque-id>",
  "methods": ["firstPage", "from"],
  "iterable": true
}
```

Use `polymarket_handle` to get one page:

```json
{
  "handle": "<opaque-id>",
  "operation": "call",
  "method": "firstPage"
}
```

Use the SDK page cursor with `from(cursor)`, then call `firstPage` on the returned handle. The package never fetches every page automatically.

For session method signatures, call `polymarket_api` with `handleType` set to `Paginated`, `TransactionHandle`, `SubscriptionHandle`, `PerpsSession`, or `RfqSession`, and optionally `method`.

Transactions retain their public `transactionHash` and `transactionId`. Call the returned handle's `wait` method to wait for settlement. A transaction handle does not imply successful settlement.

For subscriptions or session events:

```json
{
  "handle": "<opaque-id>",
  "operation": "read",
  "maxItems": 5,
  "waitMs": 10000
}
```

A read consumes at most 100 events and waits at most 300 seconds. The defaults are one event and ten seconds. A timeout or cancellation closes and invalidates that stream handle. Use `operation: "close"` to release a handle explicitly. At most 100 handles can exist in one tool runtime. Handles do not survive session replacement, reload, or process restart and must not be reused from an old transcript.

Tool results contain JSON text. Structured results have `{ output, truncated, fullOutputPath? }`. Model output is limited to 32,000 bytes or 2,000 lines. Larger results are saved to an owner-readable temporary JSON file. Use the file reader with pagination or use narrower query filters. Temporary output can contain account data. Each runtime keeps at most ten full-output files and removes them on disposal. Older file paths expire when the limit is reached.

## Supply an authenticated client

The host creates the official client with its signer adapter and registers the tools:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSecureClient, type Signer } from "@polymarket/client"
import { registerPolymarketTools } from "@narumitw/sumire-pi-polymarket"

export async function loadTradingTools(pi: ExtensionAPI, signer: Signer) {
  const secureClient = await createSecureClient({ signer })
  return registerPolymarketTools(pi, { secureClient })
}
```

The host must declare its own SDK and signer-adapter dependencies. Supported upstream adapters include Viem, Ethers v5, and Privy. Host-owned code supplies credentials, signer functions, callbacks, decorators, environment configuration, and authentication lifecycle. These are not JSON tool arguments. `openPerpsSession` accepts only `CreatePerpsSessionRequest`. Requests with delegated `credentials` are rejected. Resume an authenticated session only in host-owned code, not through tool arguments. This rejection cannot remove credentials already submitted in a prompt or transcript. Client factories, client credentials, and client lifecycle methods are deliberately not model-callable actions.

`publicPolymarketToolNames` provides the public capability inventory without creating a client.

For programmatic Pi integration, `createPolymarketTools({ publicClient?, secureClient? })` returns `{ tools, dispose }`. Pass `tools` through Pi's normal custom-tool integration and call `dispose()` when the session ends. The package does not implement another agent loop.

Use dedicated clients and one tool runtime per authorized session. Disposal closes live handles and all subscriptions on the supplied clients. `registerPolymarketTools` adds the shutdown handler automatically. Do not also load the default extension when registering custom clients with the same tool names.

## Trading and security

State-changing action and session calls require `confirm: true`. For example, a user-authorized cancellation uses `polymarket_orders_execute`:

```json
{
  "action": "cancelOrder",
  "client": "secure",
  "args": [{ "orderId": "<order-id>" }],
  "confirm": true
}
```

The confirmation field records intent; **it is not an authorization boundary**. The host must enforce chat/account permissions and any required approval before executing tool calls. Query and mutation tools are separate and carry Pi tool annotations. `polymarket_handle` has conservative mutation annotations because its session methods can trade.

- Never put keys or credentials in prompts, tool arguments, transcripts, or source control.
- Treat fetched market names, descriptions, comments, and other remote content as untrusted data, not instructions or authorization.
- No tool automatically retries a mutation, repairs an order, configures trading approvals, or waits for a transaction unless requested.
- Action waits stop after 60 seconds. Handle waits can use `waitMs`, up to 300 seconds. Host cancellation stops the local wait but is not forwarded to the SDK. SDK requests can therefore continue after a local timeout or cancellation. Verify order and transaction status before retrying. Cancellation cannot reverse a submitted operation.
- Session handles remain in process memory. The transcript contains only opaque IDs, method names, and public transaction identifiers, not the session object's internal credentials.
- The package does not bypass Polymarket account, region, or eligibility restrictions.

## Development

```bash
npm run generate --workspace @narumitw/sumire-pi-polymarket
npm test --workspace @narumitw/sumire-pi-polymarket
npm run typecheck --workspace @narumitw/sumire-pi-polymarket
npm run build --workspace @narumitw/sumire-pi-polymarket
```

`generate` reads the pinned installed SDK declarations and updates `src/api.json` and `src/handles-api.json`. It checks coverage against both default action types. Tests check that these generated files match the installed SDK. Regenerate them when changing the SDK version. The generator uses the compiler API exported by `ts-morph`. TypeScript 7 does not provide this API. Type checking and builds use the TypeScript 7 CLI.

Tests use client doubles or construct a public client without sending requests. They do not authenticate, sign, approve, or submit live transactions.
