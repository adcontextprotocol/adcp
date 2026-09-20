---
"adcontextprotocol": minor
---

Add optional AdCP 3.x migration fields that make `get_creative_features`
retry-safe and reconcilable without breaking existing implementations. Clients
SHOULD send `idempotency_key`; providers that advertise replay support MUST
honor supplied keys for at least 24 hours. Providers SHOULD emit a stable
`evaluation_id`, which remains stable across replays and async completion when
present. Both fields are planned to become required in AdCP 4.0. Add
deterministic conformance coverage for the recommended keyed and identified
profile, including synchronous, asynchronous, conflicting, and concurrent
retries plus terminal pricing and consumption reconciliation.
