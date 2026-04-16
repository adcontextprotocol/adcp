---
---

Give Addie GitHub read access. Added `get_github_issue` (fetch issue or PR by number, with optional comments) and `list_github_issues` (search/filter issues) covering any `adcontextprotocol/*` or `prebid/*` repo. `get_github_issue` is always-available across all tool sets since users paste GitHub links in any conversation; `list_github_issues` is in the `knowledge` set.

Hardening: untrusted issue/comment content is wrapped in `<untrusted-github-content>` boundary tags with an inline data-not-commands warning; body truncated to 4KB, comments to 1KB × 10; `list_github_issues` rejects `repo:`/`org:`/`user:`/`is:` qualifiers in `query` (prevents search-API allowlist bypass); repo-name regex requires alphanumeric leading char; 403 rate-limit vs auth errors are distinguished so Addie can respond usefully.
