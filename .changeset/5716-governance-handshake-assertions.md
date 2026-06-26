---
"adcontextprotocol": patch
---

Strengthen the `governance_approved` and `governance_conditions` storyboards so they actually verify the governance handshake. Both previously asserted only `response_schema`, so a seller that never consulted its registered governance agent still passed. Each terminal `create_media_buy` step now asserts `envelope_field_present: governance_context` — a token only a seller that called `check_governance` can echo — and both scenarios are gated on `media_buy.governance_aware` (mirroring `governance_denied` / `governance_denied_recovery`), so sellers without outbound governance consultation grade `not_applicable` instead of false-failing. Addresses #5716.
