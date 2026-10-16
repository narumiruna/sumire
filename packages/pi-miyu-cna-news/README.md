# Pi Miyu CNA News

Host-bound Pi tool for CNA news queries through `@miyuyo_bot` in the current Telegram group.

## API

Create one `MiyuCnaNews` instance with a `MiyuTransport`. The host supplies `sendMessage(chatId, text, signal)` and forwards authorized Telegram messages to `await handleMessage(message)`.

Await `client.createTool({ id: currentChatId, type: currentChatType })` and register its result with Pi only when it returns a tool. It returns `undefined` outside a group or when `miyuyo_bot` membership is not confirmed. The model supplies only `query`; it cannot select a different chat.

The transport must implement `hasMiyuyoBot(chatId, signal)`. The host must verify current group membership and return `false` for absent or unknown membership. Do not infer membership from old messages. Telegram member lookup needs a numeric user ID; this package does not assume that a bot username can be passed to `getChatMember`. The host must supply the member lookup or maintain an authoritative membership index.

The tool sends:

```text
@miyuyo_bot 使用 CNA MCP 今日台灣重要新聞
```

## Contract

- Only group and supergroup contexts with confirmed `miyuyo_bot` membership receive a tool.
  - Membership is checked again before sending. If Miyu has left or the check fails, no request is sent.
  - The host must refresh tool registration after membership changes. This package does not receive membership updates automatically.
- The host must authorize the chat and tool before execution. This package does not provide access control or Telegram polling.
- Forward replies before normal message processing or per-chat turn queues. A `true` return from `handleMessage` means the host must consume the message without starting another model turn.
- A result must be a non-empty text message from the bot username `miyuyo_bot`, in the same chat, with `reply_to_message.message_id` equal to the sent request ID.
  - Anonymous chat senders, forwarded copies without that sender identity, unrelated replies, and captions do not complete the request.
  - The first matching reply completes the request. Edited replies and multipart aggregation are not supported.
- One request can wait per group. Different groups can run independently.
- The 120-second deadline includes sending and waiting. Cancellation aborts the transport signal and removes the waiter. The transport must honor that signal to stop network activity.
- Reply routing waits for the send operation to return its message ID before matching. An early reply is not sent to a second model turn. Sending failure, cancellation, and timeout also release pending reply routing.
- Reply text is untrusted source data, not instructions.

## Deployment limits

Confirmed membership is necessary but not sufficient. Telegram must also deliver the mention and reply between the bots. Group membership or disabled privacy mode alone does not prove bot-to-bot delivery. Verify delivery in the target group. If Telegram does not deliver bot messages, this transport cannot retrieve an answer and the tool times out.

The package does not contact CNA MCP directly. It does not poll Telegram or store bot credentials. The Sumire bot integrates the package through its Telegram adapter and session factory. A live delivery check is still required; see the [bot setup](../../apps/bot/README.md#miyu-cna-news-tool).

## Checks

From the repository root:

```bash
npm run test --workspace @narumitw/sumire-pi-miyu-cna-news
npm run typecheck --workspace @narumitw/sumire-pi-miyu-cna-news
npm run build --workspace @narumitw/sumire-pi-miyu-cna-news
```
