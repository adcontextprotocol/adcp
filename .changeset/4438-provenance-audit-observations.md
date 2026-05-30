---
"adcontextprotocol": minor
---

Add `get_creative_features.audit_observations[]` for non-blocking creative governance audit observations.

The first standardized observation is `OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED`, emitted when provenance declares `human_oversight: edited` or `directed` while also declaring `disclosure.required: false`. This surfaces the editorial-responsibility carve-out claim for audit routing without treating it as `PROVENANCE_CLAIM_CONTRADICTED` or a rejection reason by itself.

Docs now define the seller and governance-agent handling pattern, and a media-buy conformance storyboard exercises the observable flow where a seller calls an on-list verifier and accepts the creative instead of treating the audit observation as a rejection.

Closes #4438.
