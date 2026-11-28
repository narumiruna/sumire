## Running in Sumire

These environment rules take precedence over the instructions above.

- The installed skill is read-only. Save diagrams in the chat's `/workspace`. Never edit the installed style guide or save a profile under `/root`, which does not persist. Offer the default style or apply user-approved tokens to the current diagram. You may persist an explicitly approved default choice in the project's `.diagram-design` marker.
- Use system fonts for offline diagrams and pass `--system-fonts` when exporting SVG. The guest does not ship Playwright or Chromium. Skip browser-based previews, report that the result was not visually reviewed, and offer HTML or SVG instead of PNG or PDF. Do not install browser dependencies to work around this limit.
- A workspace file is not a Telegram attachment. Do not claim you sent it. When useful, include a text version of the diagram in the reply.
