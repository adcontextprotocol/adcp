---
"adcontextprotocol": patch
---

Compliance: the `deterministic_testing` storyboard now declares a top-level `context.account` (`acmeoutdoor.example` buying through `pinnacle-agency.example`, sandbox). Its pre-flight product and pricing-option seeds, and controller calls that author no account identity, now resolve to the account that consumes those fixtures. Before this, the storyboard named no owner while also provisioning a separate `test.example` account through `sync_accounts`. Runners that fail closed on that ambiguity refused to seed, and the others seeded under their run-scoped default identity. The `test.example` provisioning step is unchanged.
