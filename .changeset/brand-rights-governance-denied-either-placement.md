---
"adcontextprotocol": patch
---

Compliance: `brand_rights/governance_denied` now accepts either response to an `acquire_rights` request that arrives without `governance_context`. The brand agent may use the structured `AcquireRightsRejected` arm or reject with `PERMISSION_DENIED`, which `specification.mdx` (Seller enforcement) requires for a request without a governance token. Either way, the existing `update_rights` probe must still prove that no grant was created. Before this change, only the rejection arm passed, so a seller following the spec sentence failed. This is an interim change: the working group still has to choose one placement (#7790). No schema or normative change.
