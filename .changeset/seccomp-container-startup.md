---
"@narumitw/sumire": patch
---

Allow `faccessat2` in the Chromium seccomp profile to restore startup with current ARM64 container runtimes while retaining the deny-by-default policy and browser sandbox. Recreate the container to apply security policy file changes and wait for its healthcheck before reporting deployment success.
