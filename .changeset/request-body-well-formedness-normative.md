---
"adcontextprotocol": patch
---

spec(security): promote duplicate-object-keys body-well-formedness to normative step 14 of the request-signing verifier checklist (closes #2523)

Before this change, the request-signing verifier checklist ended at step 13 (replay-cache insert) and treated duplicate-object-keys body rejection as a "known gap pending audit" with text pinning placement, error code, and ordering but no normative requirement. The webhook profile already had step 14 as MUST; the request surface did not.

Parser-differential body attacks (CVE-2017-12635 class) have a larger blast radius on the request surface than on webhooks because request bodies carry spend-committing payloads (`create_media_buy`, `update_media_buy_delivery`). Leaving the MAY/hedged posture on the surface that matters more was the wrong default going into 3.0 GA.

Changes:

- Add step 14 (body well-formedness) to `#verifier-checklist-requests` as a MUST, mirroring the webhook profile. Error code: `request_body_malformed` (distinct from `request_signature_digest_mismatch` — the signature IS valid; the body parses to ambiguous state).
- Add sub-steps 14a (strict-parse requirement) and 14b (logging discipline) that reference the webhook profile's 14a/14b for the per-language escape-hatch enumeration and key-name sanitization rules — profiles share the check, only error-code prefixes differ.
- Update step 13 text to note the insert-before-step-14 ordering rationale (nonce burned on first sighting of cryptographically-valid frame regardless of body shape).
- Resolve the previously-deferred `idempotency_key` duplicate-collision audit: step 14 runs before schema validation and idempotency-cache lookup, so duplicated `idempotency_key` is rejected at step 14 and never reaches the cache. No separate audit layer needed.
- Remove the "known gap" / "tracked in #2523" hedges from the webhook checklist preamble — the two profiles now share step 14 identically (with profile-specific error codes).
- Add `request_body_malformed` to the Transport error taxonomy table.

No change to the legacy HMAC webhook scheme (already MUST-rejects duplicate keys) or to the 9421 webhook profile (already MUST at step 14). The mandatory-signing rollout for requests (#2307) remains on the 4.0 timeline; this change applies the body-well-formedness rule to any 9421-signed request in 3.0.
