---
---

docs: Policy Registry sync and versioning guidance (#3140)

- Expand "Temporal enforcement" section in policy-registry.mdx with a worked effective_date transition example, explicit requires_human_review + effective_date independence note, and sunset detection guidance (inspect resolved_policies / policies_evaluated; no push notification)
- Add version pinning section to specification.mdx explaining policy-ref version field vs. unversioned plan-level policy_ids, with protocol-silence caveat on mid-campaign re-resolution semantics
- Add additive-only Warning block to specification.mdx policy resolution section clarifying custom_policies cannot relax registry-sourced policies
- Fix schema mismatch in sync_plans.mdx and specification.mdx: custom_policies and shared_exclusions examples were plain strings; schema requires PolicyEntry objects (policy_id, enforcement, policy text)
- Update field table descriptions for custom_policies and portfolio.shared_exclusions in sync_plans.mdx
