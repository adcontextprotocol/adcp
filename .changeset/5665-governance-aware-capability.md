---
"adcontextprotocol": patch
---

Add `media_buy.governance_aware` capability to `get-adcp-capabilities-response` and gate the `governance_denied` / `governance_denied_recovery` storyboards on it, so sellers without outbound governance consultation grade `not_applicable` instead of false-failing on a `GOVERNANCE_DENIED` they cannot produce. Addresses #5665 (Option A).
