---
---

fix(compliance): measurement_terms_rejected storyboard — shared idempotency alias + Q3 2026 dates

Hardcoded idempotency_key literals combined with runner-substituted dates (stale May 2026
window) caused IDEMPOTENCY_CONFLICT on every re-run against a long-running seller. Both
create_media_buy steps now share a single $generate:uuid_v4# alias so the scenario
correctly tests that TERMS_REJECTED responses do not cache the idempotency key (per AdCP
idempotency spec). Flight dates advanced to Q3 2026.
