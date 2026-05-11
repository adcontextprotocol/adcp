---
"adcontextprotocol": patch
---

Collapse the `key_reuse_conflict` phase of `universal/idempotency.yaml` into
`replay_same_payload` as a fourth step. The conflict step deliberately shares
the `$generate:uuid_v4#replay_key` alias with the replay steps so the seller
receives one cached entry that the conflict request probes with a different
body. With adcp-client#1658's phase-boundary alias reset, the conflict step
must live in the same phase as the replay steps — a separate phase mints a
fresh UUID and the seller treats the request as new, defeating the
IDEMPOTENCY_CONFLICT assertion. Companion to adcp-client#1657 / #1658; no
behavior change for sellers, only restructures the storyboard so the runner
fix is safe to land.
