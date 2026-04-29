---
"adcontextprotocol": patch
---

docs(governance): non-normative note on per-finding attribution as the audit surface for internal specialist composition

Doc follow-up to #3015. The merged "One governance agent per account" rationale already explains that internal specialist review (pharma MLR, brand safety, legal, category) composes inside the configured governance agent. This adds one paragraph naming the audit surface that makes the internal decomposition observable: each entry on `check-governance-response.findings[]` carries `category_id` (agent-internal taxonomy — which specialism flagged it) and `policy_id` (the specific policy that triggered). Buyers and sellers see one consolidated decision; per-finding attribution lets them trace which specialist contributed to a denial or condition without the protocol needing to surface multiple agents.

The schema's `category_id` description already points readers at the spec for the composition story; this paragraph completes the round-trip — spec points back at `findings[]` as the audit surface. Non-normative; zero schema impact.

Closes #3433.
