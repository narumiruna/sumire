---
"@narumitw/sumire-url-reader": minor
"@narumitw/sumire-pi-url-reader": minor
"@narumitw/sumire": patch
---

Rename the URL library and CLI to `@narumitw/sumire-url-reader` and `sumire-url-reader`, and rename the Pi integration to `@narumitw/sumire-pi-url-reader`. Move both URL skills into the Pi package and resolve the CLI through its declared library dependency. Update bot imports, Docker stages, and CI paths. Keep `read_url_content`, skill names, loader behavior, and source metadata unchanged. Hosts must update package imports and use the Pi package's `urlReaderSkillsPath` instead of the former skill path exports.
