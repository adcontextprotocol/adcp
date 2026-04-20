---
---

Two named error codes and one explicit rule on the webhook verifier checklist:

- **`webhook_mode_mismatch`.** Upgrade the "buyers MUST alarm, not silently downgrade" rule to MUST reject with the new stable code when the signature mode on a received webhook does not match the mode the buyer registered with (`authentication.credentials` present vs absent). Alarm-without-reject leaves the payload accepted by the mismatched scheme; the 401 + stable code lets sender-side retry logic route mismatch to incident response rather than replay identically.
- **`webhook_target_uri_malformed` on step 10.** Inline the `@authority` derivation rule that already exists in the request-signing profile but was easy to miss when implementing from the webhook checklist alone: verifiers MUST derive `@authority` from the as-received HTTP `Host` header (or HTTP/2+ `:authority` pseudo-header), NOT from reverse-proxy routing state, and reject with `webhook_target_uri_malformed` if the canonicalized `@authority` does not byte-match the authority component of the canonical `@target-uri`. Closes the cross-vhost replay vector (attacker intercepts a TLS-terminated webhook and replays to a second vhost on the same verifier pool: same cert SAN, different `Host`).
- **Retry-semantics paragraph broadened** from `webhook_signature_*` to `webhook_*` so the two new structural codes are covered by the terminal-failure + incident-routing guidance.

Extracted from PR #2433 as a standalone editorial + taxonomy fix. No wire-schema change; no client-side breakage for implementations that already verified correctly.
