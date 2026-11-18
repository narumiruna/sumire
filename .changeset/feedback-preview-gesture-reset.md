---
"@narumitw/sumire-admin": patch
---

Clear active pointer and gesture state before image preview unmounts the feedback canvas, so returning to editing cannot reuse an old gesture or overwrite an earlier redaction.
