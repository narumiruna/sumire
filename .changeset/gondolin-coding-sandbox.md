---
"@narumitw/sumire": minor
---

Run production coding tools and nested CodeMode calls in disposable Gondolin micro-VMs instead of the bot's host environment. Persist only per-chat workspaces, mount approved skills read-only, mediate scoped credentials and HTTPS egress, and close VMs on completion/cancellation. Include a guest image and document breaking host-path compatibility, remaining trusted MCP capabilities, and required real-VM staging validation. For public URLs, use `read_url_content`; the bot no longer offers the host-only `load-url-content` CLI skill.
