---
---

`scripts/ipr/check-and-record.mjs`: replace the `LEDGER_REMOTE_PATTERN` regex with a URL-parser-based check and add `tests/ipr-ledger-remote.test.mjs` pinning the accept/reject matrix. The new `isLedgerRemoteAllowed()` helper (in `scripts/ipr/ledger-remote.mjs`) parses the remote URL with `new URL()` and explicitly checks scheme, host, and normalized path — credentials in userinfo are ignored, default-port https is accepted, and SSH / non-https / wrong-host / wrong-repo URLs are rejected by construction rather than by regex backtracking. Closes the regression-test gap from #3532.
