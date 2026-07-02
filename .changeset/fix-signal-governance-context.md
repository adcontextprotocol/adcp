---
"adcontextprotocol": patch
---

Clarify and enforce governed signal activation: `activate_signal` now documents `governance_context`, signal agents fail closed on governed accounts without a valid approval context, and signal governance compliance checks no longer require the signals tenant to own `sync_plans`.
