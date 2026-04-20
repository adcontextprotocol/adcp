---
---

Tighten duplicate-object-key handling on signed webhook bodies from MAY-reject to MUST-reject (verifier AND signer sides), close the DoS amplifier in the 9421 verifier-checklist ordering, correct per-language strict-parse guidance with library-specific pitfalls, add logging-discipline and cross-keyid admission-pressure rules, and pin the request-signing taxonomy to prevent divergent implementations shipping ahead of #2523. Closes the parser-differential attack class (CVE-2017-12635 family) on the webhook surface.

**Spec (`docs/building/implementation/security.mdx`):**

*Legacy HMAC scheme (duplicate-object-keys bullet):*
- Verifier-side: MAY → **MUST-reject**. Every legacy HMAC webhook body is a state-change notification, so the MUST applies unconditionally.
- Signer-side: SHOULD → **MUST** reject duplicate-key input from upstream callers before serialization. A silently-collapsing signer emits a cryptographically-clean frame whose semantics differ from caller intent; the verifier cannot detect upstream divergence from the wire, so the MUST applies at the signer even though it is unverifiable from the wire. Signer-side conformance is expected to be enforced by out-of-band audit / interop testing, as in COSE and JOSE.
- Strict-parse enumeration compressed to a one-sentence pointer to the canonical list at step 14 of the webhook verifier checklist (avoids phrasing drift between two copies).

*9421 webhook profile (verifier checklist):*
- Body-well-formedness moved from 11a → step **14**, AFTER the replay-cache insert at step 13. Step 13's rationale expanded inline documenting the invariant — nonce burned on first sighting of any cryptographically-valid frame, regardless of body shape — so a captured `(keyid, nonce, valid-signature, malformed-body)` tuple cannot be replayed to burn crypto-verify CPU per retry.
- **Strict-parse enumeration corrected** with library-specific accuracy: `tidwall/gjson` removed (query library, not a validator); `goccy/go-json` requires explicit `DisallowDuplicateKey()` decoder option (not default); `secure-json-parse` by default targets prototype-pollution keys not data-key duplicates (callout added); Node stream parsers (`stream-json`, `jsonparse`) recommended as the idiomatic strict path.
- **Logging discipline**: verifiers SHOULD NOT log full request body bytes on a `webhook_body_malformed` rejection (log `keyid`, nonce, byte length, and duplicate-key names only). Prevents an attacker with a compromised signer key from forcing attacker-chosen bytes into defender logs at scale for SIEM poisoning / credential exfiltration follow-on.
- New error code `webhook_body_malformed` in the webhook error taxonomy.
- Preamble reframed: "two **parameter substitutions** and one **additional check unique to the webhook profile** (step 14, body well-formedness)" — frames the asymmetry as a policy choice that will collapse back to a shared checklist once #2523 lands, not arithmetic. Implementations SHOULD gate step 14 behind a profile flag, not fork the verifier code.

*9421 request-signing profile — tightened known-gap paragraph:*
- Previously recommended implementers "adopt the same posture." Now **mandates the exact shape**: insert step 14 after step 13's replay-cache insert; error code `request_body_malformed` (mirroring `webhook_body_malformed` under the `request_*` prefix, distinct from `request_signature_digest_mismatch`); same strict-parse and logging-discipline rules. Vendor-custom codes, alternate placements, or logging-full-bodies behavior MUST NOT ship in the interim.
- Pinning the taxonomy now closes the compat-break window that would otherwise open between shipping implementations and #2523's formal spec edit.

*Webhook replay dedup sizing — new admission-pressure rule:*
- **New-keyid admission pressure** (MUST track, SHOULD alert). Verifiers MUST track the rate of cache entries admitted from previously-unseen `keyid`s per unit time. Distinguishes the distributed-compromise attack shape — N compromised signer keys each well within the per-keyid cap (step 9a) but collectively saturating the aggregate cache — from legitimate traffic, which the per-keyid cap alone cannot detect. Operators SHOULD alert when new-keyid admission exceeds an operator-defined threshold (e.g., 3× 24-hour moving average, floored at 5 distinct new keyids / 5 minutes). Alarming fires *before* the aggregate cap triggers, not after — once `webhook_signature_rate_abuse` fires on the aggregate cap, every legitimate signer is already being rejected.

**Test vector (`static/test-vectors/webhook-hmac-sha256.json`):**
- Single-outcome shape: `expected_verifier_action: "reject-malformed"` + `rfc9421_error_code: "webhook_body_malformed"`.
- Vector `description` is one sentence pointing at security.mdx, `verifier_action_values`, and `non_conformant_outcomes`. All normative detail lives in the structured fields, not in revisable prose.
- `verifier_action_values` enum retains `accept` as documentation-only with an explicit non-conformant note for this fixture.
- `non_conformant_outcomes` enumerates three forbidden modes: silent-accept with parser divergence; wrong error class; silent-discard parsers.

**CI (`tests/webhook-hmac-vectors.test.cjs`):**
- Structural assertions for the single-outcome shape: enum map required; every vector with `expected_verifier_action` uses an enum token; `rfc9421_error_code` matches `webhook_*` taxonomy pattern; at least one vector must carry `expected_verifier_action` (catches accidental removal leaving enum orphaned); `duplicate-keys-conflicting-values` fixture must exist by id with exact `expected_verifier_action` and `rfc9421_error_code` values security.mdx references (prevents silent rename-drift).

Closes #2483. Addresses the webhook portion of #2523 (request signing, TMP signed bodies, adagents.json manifests, governance-signing remain open there). The request-signing known-gap paragraph in this PR pins the error code, step placement, and logging discipline implementers MUST mirror until #2523's formal spec edit lands — interim implementations will drop in cleanly rather than breaking at merge.
