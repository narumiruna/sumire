---
"@narumitw/sumire-admin2": minor
"@narumitw/sumire": minor
---

Add the v2 administration console at `/v2`, a React app styled with the Console theme. It signs in with the existing passkey, lists chats with their effective policy, approves and revokes chat access with undo, and shows the audit trail filtered by actor, operation, outcome, and date. The other sections link back to the v1 console. The bot serves the v2 build, including its bundled woff2 fonts, from `apps/admin2/dist`.
