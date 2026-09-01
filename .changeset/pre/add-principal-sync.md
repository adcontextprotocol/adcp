---
"adcontextprotocol": minor
---

Add the experimental principal layer: the `sync_principal` task for a party's (buyer agent or operator identity) standing configuration with a seller and the side-effect-free `get_principal` read task. Includes reusable reporting destinations with per-pattern normative proof (file write-probe, warehouse commit verification, dataset-share recipient acceptance), destination suspension and revocation semantics with an advertised halt interval, retained superseded and revoked destination generations in readback, two-sided negotiation through `reporting_destination_offerings` capability advertising, capability-change webhook compatibility, optimistic concurrency with cross-task version coherence, principal-scoped idempotency, principal isolation, and credential-free destination setup state. Interactive clients such as Claude do not have to register as buyer agents, but must propagate a stable delegated user identity.
