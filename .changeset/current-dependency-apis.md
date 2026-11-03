---
"@narumitw/sumire-admin": patch
"@narumitw/sumire": patch
"@narumitw/sumire-contracts": patch
"@narumitw/sumire-github-notifications": patch
"@narumitw/sumire-imagegen": patch
"@narumitw/sumire-login": patch
"@narumitw/sumire-pi-polymarket": patch
"@narumitw/sumire-pi-url-reader": patch
"@narumitw/sumire-policy": patch
"@narumitw/sumire-progress": patch
"@narumitw/sumire-runtime-config": patch
"@narumitw/sumire-url-reader": patch
---

Update workspace dependencies, including Pi 1.5.0 and Polymarket 0.16.0. Import TypeBox directly, preserve typed string enums with Pi's updated schema helpers, and regenerate the Polymarket catalog with the current TypeScript compiler.

Migrate the bot to Durable conversation observations while preserving progress delivery and the full active transcript. Keep nested tool results in session completion events. Preserve message completion events and direct tool results when a bulk commit exceeds the bounded observation window. Keep literal HTML entity spellings unchanged with the updated Markdown tokenizer.

Update the bundled curl-impersonate library to v2.3.2 with verified Linux archive checksums. This matches the Chrome profiles required by impers 0.1.3.

Back up durable storage before deployment. Pi 1.5 upgrades `pi.live` documents; rollback requires the matching pre-upgrade state.
