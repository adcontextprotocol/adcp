---
---

Inline the `@authority` Host-header-derivation rule in the request-signing verifier checklist step 10, mirroring the fix to the webhook-side checklist. The rule already exists in the profile's canonicalization section (`security.mdx` line 799) and the error code `request_target_uri_malformed` already fires on authority-vs-`@target-uri` mismatch — but a verifier implementer working from the checklist alone could miss it and silently accept a cross-vhost replay (attacker intercepts a TLS-terminated request and replays to a second vhost on the same verifier pool: same cert SAN, different `Host`).

Also expand the error-taxonomy row for `request_target_uri_malformed` to cover both the syntactic-malformation case (already described) and the authority-mismatch case (already normative in the profile, now visible in the table).

No wire-schema change. Conformant verifiers already applying the profile's `@authority` rule remain conformant.

Follow-up to PR #2467 which made the parallel fix on the webhook-verifier side.
