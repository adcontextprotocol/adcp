---
"adcontextprotocol": patch
---

Patch the 3.0.x compliance fixtures for the reported AgenticAdvertising.org
compliance suite failures: `media_buy_state_machine` and
`measurement_terms_rejected` now use forward-looking Q3 2026 windows, the
universal idempotency missing-key vector no longer depends on a same-day May
flight, the state-machine fixture keeps the existing 3.0.x `status` response
assertions, and the compliance build rejects stable or duplicate generated
idempotency keys on mutating storyboard steps.
