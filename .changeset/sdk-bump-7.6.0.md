---
"adcontextprotocol": patch
---

Bump `@adcp/sdk` from ^7.3.0 to ^7.6.0. The SDK now registers the `impairment.coherence` storyboard assertion (adcontextprotocol/adcp-client#1801) and emits a `not_applicable` hint for inverse-rule deferred families (#1810), unblocking the wiring on all five specialisms that exercise the cross-resource join — `audience-sync`, `sales-catalog-driven`, `creative-ad-server`, `creative-template`, `creative-generative`. The transient deferral introduced earlier in this PR is reversed.

Storyboard floors re-baselined to capture the SDK's new storyboards (+2 per tenant typical) and the `/governance` step-skip reclassification (−2 passing steps, +4 clean). Same pattern as the SDK 7.0.0 bump in #4465.

No spec changes — the `impairment.coherence` rule, scope, and docs land in this PR's earlier assertion changeset.
