---
---

spec(compliance): correct `measurement_terms_rejected` idempotency narrative

The narrative on the `media_buy_seller/measurement_terms_rejected` storyboard told implementers the buyer "retries the same `create_media_buy` `idempotency_key` with an adjusted payload." That contradicts the spec — reusing a key against a different body MUST yield `IDEMPOTENCY_CONFLICT`. The sample payloads in the fixture already use distinct keys (`measurement-terms-probe-aggressive-v1` / `measurement-terms-probe-relaxed-v1`); only the prose was wrong. Rewrite the narrative to match the spec and the actual sample payloads.

Refs adcontextprotocol/adcp-client#1586.
