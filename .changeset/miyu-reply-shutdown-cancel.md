---
"@narumitw/sumire": patch
"@narumitw/sumire-pi-miyu-cna-news": patch
---

Stop polling intake before sending the shutdown notice. Reject queued inputs cancelled during tool refresh. Consume matching non-text and late Miyu reply parts without starting another model turn, using a bounded recent-request index.
