---
---

Add `LEDGER_DIR` support to `scripts/ipr/check-and-record.mjs` and a reusable `.github/workflows/ipr-check-callable.yml` so AAO repositories beyond adcp can write back to the central signature ledger via a GitHub App installation token. The script defaults `LEDGER_DIR` to cwd — adcp's existing workflow keeps working unchanged. Aligns adcp's concurrency group with the cross-repo group (`adcp-ipr-signature-write`) so signatures from any repo serialize against each other. Adds `governance/ipr-bot-setup.md` documenting the App configuration, secret rotation, revocation, and per-repo adoption steps. Per-repo caller workflows for adcp-client / adcp-client-python / adcp-go / creative-agent ship as separate PRs.
