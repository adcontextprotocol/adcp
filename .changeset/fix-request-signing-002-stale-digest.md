---
---

Fix stale `Content-Digest` and `Signature` in request-signing test vector `positive/002-post-with-content-digest.json` (issue #2335). The shipped digest was not the SHA-256 of the body bytes, so verifiers that recompute at verifier checklist step 11 rejected the vector. Recomputed digest against the 22-byte body `{"plan_id":"plan_001"}`, updated `expected_signature_base`, and re-signed with `test-ed25519-2026`. Also updated `negative/018-digest-covered-when-forbidden.json`, which reused the stale values — the intended failure mode is at step 6 (coverage policy), but keeping downstream fields valid prevents lenient verifiers from reporting the wrong error.
