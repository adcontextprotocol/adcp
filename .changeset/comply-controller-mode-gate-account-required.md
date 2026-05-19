---
"adcontextprotocol": patch
---

Fix `universal/comply-controller-mode-gate.yaml` lint failure: sample_request was missing the required `account: { sandbox: true }` field. The storyboard tests the live-mode denial path (seller resolves auth → live account → returns FORBIDDEN), which is unrelated to the `account.sandbox` payload claim — but the payload still needs to be schema-valid as defense-in-depth before reaching the per-account gate. Added the `account` block plus an explanatory comment.

No behavioral change to the storyboard's assertions — the denial path was already being tested correctly; only the schema-drift gate now passes.
