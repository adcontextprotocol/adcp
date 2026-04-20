---
---

Three tightenings to close the cross-vhost replay vector on the request-signing side, mirroring the webhook-side fix in PR #2467.

- **Checklist step 10** inlines the `@authority` derivation rule (already load-bearing in the profile's canonicalization section) so a verifier implementer working from the checklist alone cannot miss it.
- **Profile `@authority` canonicalization** (the canonical rule) now pins the `:authority` (HTTP/2+) vs `Host` (HTTP/1.1) source precedence and requires byte-equality when both are present on the as-received request. Pick-one behavior across HTTP/2→HTTP/1.1 translating intermediaries was a silent downgrade surface — RFC 7540 §8.1.2.3 requires equivalence but does not require intermediaries to strip the source header, so verifiers MUST reject `request_target_uri_malformed` on divergence. The canonicalized value MUST byte-for-byte match the authority component of the canonical `@target-uri` (the load-bearing safety gate, because `Host` itself can be rewritten in transit).
- **Error-taxonomy row** for `request_target_uri_malformed` expanded to cover both the syntactic-malformation case (already described) and the authority-mismatch case (already normative in the profile, now visible in the table).

No wire-schema change. No new error codes. Conformant verifiers already applying the profile's `@authority` rule remain conformant.
