---
"adcontextprotocol": minor
---

Define cross-transport async identity and convergence rules for direct
responses, AdCP polling, A2A tasks, continuations, and webhooks. The contract
separates identifier namespaces, makes terminal settlement and publication
single-winner, binds webhook delivery keys immutably to payloads, requires
recoverable continuation-generation handoffs, preserves legacy composite
atomicity, and advertises webhook retry horizons.
