---
"adcontextprotocol": patch
---

Add `intent` to the `governance-phase` enum so a buyer-side `check_governance` call can express the intent-phase check the campaign-governance spec already mandates (the produced token MUST carry `phase: "intent"`). Previously the enum was `[purchase, modification, delivery]`, so an intent check silently defaulted to `purchase` and the intent/execution token separation was unenforceable at the schema layer. Fixes audit finding T1-4 (NS-GOV-001); guarded by `tests/governance-phase-enum.test.cjs`.
