---
"adcontextprotocol": minor
---

Require brand-scoped state to survive across agent process instances. Add normative "State persistence and horizontal scaling" section to protocol architecture: state keyed by `(brand, account)` MUST survive across agent replicas, and implementations MUST support read-your-writes for that state.

Compliance docs add a "Production readiness" section telling sellers to run storyboards against ≥2 agent instances before claiming compliance — single-instance success is not sufficient. Multi-instance compliance mode rotates requests across replicas for any storyboard that contains a step marked `stateful: true`, which already identifies the write→read sequences that fail on in-process-only implementations.
