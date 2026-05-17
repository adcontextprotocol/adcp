---
"adcontextprotocol": patch
---

Defer `impairment.coherence` wiring on every specialism that exercises the join until the training-agent runner registers the assertion id — both the buy-side (`audience-sync`, `sales-catalog-driven`) and creative-track (`creative-ad-server`, `creative-template`, `creative-generative`) specialisms. The training-agent's storyboard runner currently rejects unregistered assertion ids as fatal errors; declaring the invariant before the runner ships registration drops the `/sales` and `/creative*` tenants below their storyboard floors.

The invariant itself is unchanged — the rule, scope, and docs in `lifecycle.mdx` and `compliance-catalog.mdx` still describe the full forward / inverse / out-of-scope contract. Only the YAML-level invariant declaration is held back, matching the rollout pattern established for `status.monotonic` in #2664 (spec lands first, runner registration ships separately, then specialism wiring re-applies).

Follow-up: re-enable wiring on all five specialisms once adcp-client registers `impairment.coherence`.
