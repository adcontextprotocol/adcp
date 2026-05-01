---
---

`ipr-agreement.yml` (adcp's own IPR workflow) now mints an installation
token from the `aao-ipr-bot` GitHub App and uses it for both the checkout's
persisted git credentials and the signature-recording script's API calls.

**Why.** The `IPR signatures` branch ruleset on `main` requires PR + status
checks for direct pushes, with bypass granted to org admins, repo admins,
and the `aao-ipr-bot` App (integration `3500425`). The default
`secrets.GITHUB_TOKEN` authenticates as `github-actions[bot]` (integration
`15368`), which is not in the bypass list. Every push to append to
`signatures/ipr-signatures.json` was being rejected with `GH013:
Repository rule violations`, leaving the `IPR Policy / Signature` commit
status pending and blocking PR merges (#3687, plus earlier signers
backfilled in #3636).

The cross-repo callable workflow `ipr-check-callable.yml` already uses
this App-token pattern — adcp's own per-repo workflow just never got
converted. This brings the two into alignment.

**Secrets required (already configured at the org level).**
`IPR_APP_ID` and `IPR_APP_PRIVATE_KEY`.
