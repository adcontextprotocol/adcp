---
---

`forward-merge-3.0.yml` adds a temporary `--ours` allowlist for two files where 3.0.x has a hand-adapted prose-only backport of #3739 and main has the full enum split:

- `docs/building/implementation/error-handling.mdx`
- `static/schemas/source/enums/error-code.json`

Without this rule, every routine forward-merge from 3.0.x → main rediscovers the divergence and fails loud — squash-merges of prior forward-merges (the only merge style this repo allows) don't advance git's merge-base, so the conflict surfaces every time.

Marked as temporary in the workflow comments; remove when 3.1.0 cuts and main no longer has the in-flight enum split. See adcontextprotocol/adcp#3784 / #3789 for cherry-pick context.

Companion update to the auto-PR body so reviewers see the bridge entry exists.
