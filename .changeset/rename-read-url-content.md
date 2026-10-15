---
"@narumitw/sumire-url-tool": minor
"@narumitw/sumire-url-content": patch
"@narumitw/sumire": patch
"@narumitw/sumire-admin": patch
---

Rename the URL-reading tool from `load_public_url` to `read_url_content`. Update bot instructions, skills, documentation, and tests to use the new name. No legacy alias is registered; update direct calls, codemode scripts, and tool allowlists. Existing bot permissions are not transferred automatically: authorize the new name globally and in the effective chat policy through the Web UI.
