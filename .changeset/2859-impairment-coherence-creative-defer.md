---
"adcontextprotocol": patch
---

Defer `impairment.coherence` wiring on the three creative-track specialisms (`creative-ad-server`, `creative-template`, `creative-generative`) until the training-agent runner registers the assertion id. The training-agent's storyboard runner currently rejects unregistered assertion ids as fatal errors; declaring the invariant before the runner ships registration causes the `/creative` and `/creative-builder` tenants to fail below their storyboard floors.

Buy-side wiring on `audience-sync` and `sales-catalog-driven` is unaffected and remains active.

The invariant itself is unchanged — the rule, scope, and docs in `lifecycle.mdx` and `compliance-catalog.mdx` still describe creative.rejected as in scope. Only the YAML-level invariant declaration is held back, matching the rollout pattern established for `status.monotonic` in #2664 (spec lands first, runner registration ships separately, then specialism wiring re-applies).

Follow-up: re-enable the creative-* wiring once adcp-client registers `impairment.coherence`.
