---
"adcontextprotocol": patch
---

`expected_confirmation_at` on a `submitted` `refine_proposals` response now also covers an `extend_hold`-only request (the experimental `media_buy.hold_extension` surface), not only a finalize-only one. A seller whose hold extension waits on a creator, host or talent agreeing (the same case as a finalize that waits on a person, #8086) SHOULD set it on that response, with the same semantics: an estimate of when the seller expects to resolve the extension, not a commitment and not the successor's `expires_at`. Description and documentation change only; the schema already accepted the field on any `submitted` response.
