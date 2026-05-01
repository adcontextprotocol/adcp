---
---

`signatures/ipr-signatures.json`: backfill two contributors whose `I have read the IPR Policy` comments fired during the window when `scripts/ipr/check-and-record.mjs`'s `LEDGER_REMOTE_PATTERN` was rejecting bare-URL origins (broken since `actions/checkout@v6` switched to credential-helper auth; fixed in #3532). Without this backfill, both signers would need to re-comment to trigger a fresh `issue_comment` run, since the workflow does not replay historical comments.

Entries:
- `erik-sv` (id 39309912) — adcontextprotocol/adcp#3468, comment 4338051086
- `katiecooperco` (id 86127745) — adcontextprotocol/adcp#3484, comment 4338909329 (Katie's earliest signature; #3531 is a re-roll)

Audit performed via comment search for the exact agreement phrase across all repos using the IPR workflow; only these two signers had comments without ledger entries.
