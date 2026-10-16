# @narumitw/sumire-pi-miyu-cna-news

## 0.2.0

### Minor Changes

- 8cfb372: Add a standalone Pi CNA news tool that mentions miyuyo_bot in a host-bound Telegram group and matches its direct reply. Expose the tool only with confirmed Miyu membership, and recheck membership before sending. Connect the tool to bot startup, per-input tool refresh, authorized Telegram transport, and reply routing.

### Patch Changes

- 0b5ad82: Stop polling intake before sending the shutdown notice. Reject queued inputs cancelled during tool refresh. Consume matching non-text and late Miyu reply parts without starting another model turn, using a bounded recent-request index.
