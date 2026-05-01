---
---

`scripts/ipr/check-and-record.mjs`: make the credentials portion of `LEDGER_REMOTE_PATTERN` optional. The previous regex `[^/@]+@?` required a username segment before `@`, which only matches URLs that embed credentials (e.g. `https://x-access-token:TOKEN@github.com/...`). When the checkout uses a credential helper instead, the bare URL `https://github.com/adcontextprotocol/adcp` failed the assertion and the script refused to push, blocking signature recording from `issue_comment` runs in caller repos. New pattern `(?:[^/@]+@)?` accepts both shapes while still rejecting other repos, hosts, and SSH URLs.
