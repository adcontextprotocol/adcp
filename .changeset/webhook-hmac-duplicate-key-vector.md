---
---

Tighten duplicate-object-key handling on signed webhook bodies from MAY-reject to MUST-reject, for both the legacy HMAC scheme and the RFC 9421 webhook profile. Closes the parser-differential attack class (CVE-2017-12635 family) that the previous MAY clause permitted by spec.

**Spec (`docs/building/implementation/security.mdx`):**
- Legacy HMAC scheme, duplicate-object-keys bullet: verifiers **MUST** reject bodies containing duplicate object keys after HMAC verification succeeds, returning a structured malformed-body error (distinct from signature-mismatch — the signature IS valid; the body is malformed). Previously a MAY with a SHOULD for state-change bodies. Every body carried on the legacy HMAC webhook scheme is a state-change notification, so the MUST applies unconditionally to this scheme.
- RFC 9421 webhook verifier checklist (previously 14 checks, now 15): new step **11a** (body well-formedness) runs after `content-digest` verification succeeds and before the replay-cache check. Verifiers MUST reject duplicate-key bodies with `webhook_body_malformed`. The step explicitly requires a parse mode that exposes duplicate keys (strict-parse), not a last-wins/first-wins default that silently discards them.
- New error code `webhook_body_malformed` added to the webhook error taxonomy, distinct from `webhook_signature_digest_mismatch` (the signature IS valid; the body is malformed).
- Verifier-checklist preamble updated: three substitutions from the request-signing checklist instead of two (added the 11a body-well-formedness check, which the request-signing profile does not carry — that surface is covered by #2523 follow-up audit).

**Test vectors (`static/test-vectors/webhook-hmac-sha256.json`):**
- Vector `duplicate-keys-conflicting-values`: `raw_body={"event":"creative.status_changed","creative_id":"creative_123","status":"approved","status":"rejected"}`. Conflicting values (not identical) so the parser-differential attack surface is actually testable — the CVE-2017-12635 class requires divergent values, not duplicates.
- Single-outcome shape: `expected_verifier_action: "reject-malformed"` plus `rfc9421_error_code: "webhook_body_malformed"`. Replaces the dual-outcome `acceptable_outcomes` / `recommended_outcome` shape from the prior revision — with MUST-reject, there is no dual-outcome world.
- `verifier_action_values` enum map documents both tokens; the `accept` token is preserved as documentation-only so SDK harnesses have a stable definition, but a verifier that returns `accept` on this fixture is explicitly non-conformant.
- `non_conformant_outcomes` array names the three forbidden failure modes: silent accept with parser divergence, returning signature-mismatch for a valid-HMAC body, and using a last-wins/first-wins parser that discards duplicate keys before detection.

**CI (`tests/webhook-hmac-vectors.test.cjs`):**
- Structural assertions: `verifier_action_values` map present with both enum keys defined; every vector carrying `expected_verifier_action` uses a token from the enum; `rfc9421_error_code`, when present, matches the `webhook_*` error taxonomy pattern. A typo now fails CI instead of shipping silently.

Closes #2483. Addresses the webhook portion of #2523; other signed-body surfaces (request signing, TMP signed bodies, adagents.json manifests) remain open in #2523 pending the one-pass audit that issue calls for before extending MUST-reject to them.
