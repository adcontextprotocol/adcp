---
"adcontextprotocol": patch
---

fix(compliance): `measurement_terms_rejected` — UUID-aliased idempotency_keys + spec-aligned narrative

The `media_buy_seller/measurement_terms_rejected` storyboard shipped hardcoded `idempotency_key` literals on both `create_media_buy` steps. Combined with runner-side dynamic `start_time` substitution (the runner shifts stale dates forward to keep the buy future-dated), this produced **same key + different body** on every run against a long-running seller deployment, arming the spec-mandated `IDEMPOTENCY_CONFLICT` on the seller side. Switch to `$generate:uuid_v4#…` aliases so each run mints fresh keys (matches the established pattern across the storyboard suite).

Also rewrites the narrative, which previously told implementers the buyer "retries the same `create_media_buy` `idempotency_key` with an adjusted payload" — a direct spec violation — to describe minting a fresh key for the retry.

Closes #4219. Refs adcontextprotocol/adcp-client#1586.
