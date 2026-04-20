---
---

Tighten duplicate-object-key handling on signed webhook bodies from MAY-reject to MUST-reject, close the DoS amplifier in the 9421 verifier-checklist ordering, add per-language strict-parse implementation guidance for both signers and verifiers, and formally flag the parallel request-signing gap to SDK implementers. Closes the parser-differential attack class (CVE-2017-12635 family) on the webhook surface and prevents SDK authors from reading the webhook MUST as exhaustive.

**Spec (`docs/building/implementation/security.mdx`):**

*Legacy HMAC scheme (duplicate-object-keys bullet):*
- MAY → **MUST-reject** on the verifier side. Every body carried on the legacy HMAC scheme is a state-change notification, so the MUST applies unconditionally.
- **Signer-side clause** — signers SHOULD reject duplicate-key input from upstream callers before serialization. Closes the pre-verification parse residual where a signer silently collapses a duplicate-key payload and emits a signed frame whose semantics differ from the caller's intent.
- **Per-language strict-parse enumeration** (non-exhaustive): Python `object_pairs_hook`, Node `secure-json-parse`, Go `json.Decoder` token-walk or `goccy/go-json`/`tidwall/gjson`, Java Jackson `FAIL_ON_READING_DUP_TREE_KEY`, Ruby `Oj.load(strict_mode)`. Called out explicitly because Go `encoding/json` has no strict mode and SDK authors reading a MUST without escape hatches silently ship non-conformant verifiers.

*9421 webhook profile (verifier checklist):*
- **Step reordering** (DoS fix): body-well-formedness moved from 11a to step **14**, AFTER the replay-cache insert at step 13. Previously an attacker holding one `(keyid, nonce, valid-signature, malformed-body)` tuple could replay indefinitely — each replay burning crypto verify + strict-parse because step 11a short-circuited before the replay insert at step 13. The nonce is now burned on first sighting of any cryptographically-valid frame, regardless of body shape. Step 13's rationale expanded inline to document the invariant.
- Step 14 carries the same per-language strict-parse enumeration plus explicit crash-hierarchy language (verifiers SHOULD return `webhook_body_malformed`; crash is conformant-but-suboptimal).
- Preamble fixed: **"two substitutions plus one added step"** (was "three substitutions" — step 14 is an addition, not a substitution).
- Error code `webhook_body_malformed` added to the webhook error taxonomy.

*9421 request-signing profile — explicit known-gap paragraph:*
- New paragraph after the request-verifier-checklist summary: the checklist does NOT include the duplicate-object-keys body-well-formedness check. Request bodies carry `create_media_buy`, `update_media_buy_delivery`, etc. — parser-differential blast radius larger than webhooks' status flip. Extension deferred to [#2523](https://github.com/adcontextprotocol/adcp/issues/2523) pending audit of the error taxonomy and cap-invariant ordering interaction at step 13. Implementers SHOULD adopt the same posture now; the paragraph exists specifically so SDK authors do not read the checklist as exhaustive.

**Test vector (`static/test-vectors/webhook-hmac-sha256.json`):**
- Single-outcome shape: `expected_verifier_action: "reject-malformed"` + `rfc9421_error_code: "webhook_body_malformed"`.
- Vector `description` reduced to one sentence — normative prose (CVE anchor, error-class distinction, MUST framing) moved out of revisable description into the structured `verifier_action_values` enum map and `non_conformant_outcomes` array.
- `verifier_action_values` retains `accept` as documentation-only with an explicit non-conformant note for this fixture.
- `non_conformant_outcomes` enumerates three forbidden modes: silent accept with parser divergence; wrong error class (signature-mismatch for a valid-HMAC body); silent-discard parser modes.

**CI (`tests/webhook-hmac-vectors.test.cjs`):**
- Structural assertions: top-level enum map required; every vector with `expected_verifier_action` uses an enum token; `rfc9421_error_code` matches `webhook_*` taxonomy; **at least one vector MUST carry `expected_verifier_action`** (catches accidental removal that would leave the enum orphaned); **`duplicate-keys-conflicting-values` id MUST exist** with the exact `expected_verifier_action` and `rfc9421_error_code` values security.mdx references (prevents silent rename-drift between the vector and the spec text that cites it).

Closes #2483. Addresses the webhook portion of #2523; request signing, TMP signed bodies, adagents.json manifests, governance-signing remain open in #2523 pending the one-pass audit (now explicitly flagged in security.mdx as a known gap, not a discoverability problem).
