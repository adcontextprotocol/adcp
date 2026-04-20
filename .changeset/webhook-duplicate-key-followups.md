---
---

Follow-ups to PR #2522's duplicate-key MUST-reject tightening, landing the residuals security review flagged plus a round of expert re-review on this PR. Closes #2545, #2546, #2547.

**Admission-pressure baseline** (`security.mdx` webhook replay dedup sizing):

Previous rule: 3× 24-hr moving avg OR 2× 30-day P95 OR fixed 50-new-keyids-per-5-min ceiling. Review showed (a) 60–90 day attacker ramps drag the 30-day P95 up with them; (b) the fixed 50 ceiling is too loose for high-volume attackers (500 compromised keys at 10 new/5-min would saturate the 10M aggregate cap in ~3.5 days under the threshold); (c) the absolute ceiling is shape-wrong for operators of different sizes (50 is 0.5% of a 10k-keyid verifier, but 2.5× the entire fleet for a 20-keyid verifier). Rule now uses a quadruple-threshold shape, whichever triggers first:

- `3×` the 24-hour moving average (short-window spike)
- `2×` the 30-day P95 (multi-week ramp resistance)
- `1.5×` the 90-day P99 (multi-month ramp resistance — dominant tail over 90 days requires a multi-quarter staged compromise to drift)
- **`max(20 distinct new keyids, 10% of the 30-day unique-keyid count) per 5-minute window`** — auto-scales proportionally with operator size, so a 10k-keyid verifier gets a floor of 1,000 and a 20-keyid verifier gets a floor of 20

Alarm payload MUST name which clause (a/b/c/d) tripped so operator triage responds to the right threat shape. Spec makes explicit these are **defaults** operators SHOULD tune to their own traffic — published normative values themselves would be an attacker oracle.

**Logging discipline at step 14b** (`security.mdx`):

Previous rule: truncate to 64 bytes, replace non-printables with fixed `<non-printable>` placeholder, cap count at 8. Review found three weaknesses, all tightened:

- **Position leak**: the fixed placeholder preserved position within the key name, letting attackers encode bits via placement. Rule now **truncates at the first non-printable** and logs `<sanitized:N>` where N is the truncation byte length — elides position while preserving the "something was wrong here" signal.
- **Truncation too loose**: 64 bytes allows 24 attacker-controlled bytes per key name beyond realistic AdCP field names (which top at ~24 characters: `signed_authorized_agents`). Tightened to **32 bytes**, with explicit "truncate at the last complete UTF-8 codepoint boundary at or below 32" so multi-byte sequences are not split mid-codepoint and invalid UTF-8 does not land in logs.
- **Cap too permissive**: 8 key names × 32 bytes = 256 attacker-controlled bytes per frame, replay-slot-per-frame is meaningful SIEM pressure. Tightened to **4**. Diagnostic value of knowing 4 vs 8 vs 16 colliding keys is near zero.

Signer-side clause now normatively requires the same (a)/(b)/(c) sanitization rules on any signer-surfaced key names — the channel shape is identical even though the wire direction is inverted.

**Signer-side conformance fixtures** (`static/test-vectors/webhook-hmac-sha256.json`):

Restructured from a flat `signer_input_rejection_vectors` array plus `signer_action_values` enum into a top-level `signer_side` object with `action_values`, `rejection_vectors`, and `positive_vectors` sub-fields. The partition makes the signer-side / verifier-side boundary explicit and gives future signer fixtures (canonicalization, serializer drift) a natural home without polluting the top-level namespace.

Rejection vectors expanded from 2 to 4 shape-classes:

- `signer-upstream-duplicate-key-rejection` (top-level)
- `signer-upstream-duplicate-key-deep-nested` (one-level-nested)
- `signer-upstream-duplicate-key-array-contained` (duplicate inside an object inside an array — real-world AdCP payloads put state-change fields in array-contained objects like `packages[]`, `creative_assets[]`, `events[]`; signers that only recurse into plain object values ship the exact attack surface)
- `signer-upstream-duplicate-key-three-deep` (three nesting levels — catches hand-rolled walkers with shallow fixed-depth bounds)

New `positive_vectors` array with `signer-upstream-clean-input` — a well-formed vector with keys unique at every scope that the signer MUST sign. Prevents "reject-everything" signers from trivially passing conformance on the negative fixtures alone.

Two new action tokens in `signer_side.action_values`: `reject-input-before-sign` (was already defined) and `sign-and-emit` (the positive-path action).

**Test harness** (`tests/webhook-hmac-vectors.test.cjs`):

Nine structural assertions for the `signer_side` block — that all three sub-fields exist, that rejection vectors cover the four shape-classes by id (top-level, plain-nested, array-contained, three-deep), that `positive_vectors` has a clean-input case, that `action_values` defines both tokens, that every signer-side vector is well-formed against the enum, and a scope-aware duplicate-key detector (walks JSON tracking object vs array nesting so the check correctly distinguishes duplicate keys at the same object scope from the same key name appearing legitimately in distinct array-contained objects). The detector assertion: rejection vectors MUST have a duplicate at some scope; the clean-input positive vector MUST NOT have one at any scope.

**Two further follow-ups filed as separate issues** (out of scope for this PR):

- **CI enforcement gap**: the spec language "interop harnesses MUST exercise both" is currently exhortation — the repo has no reference-signer harness that loads a signer implementation and asserts the expected action against these fixtures. Filed as follow-up for a dedicated signer-conformance harness PR.
- **Threshold publication as attacker oracle**: publishing specific normative detection thresholds (the 3× / 2× / 1.5× / 20 / 50 numbers) gives attackers concrete values to tune against. The current spec frames the published values as defaults operators SHOULD override, but the stronger shape — move concrete thresholds to a non-normative operator guide and state only the structural shape (four-threshold OR, with categories) in the normative spec — is a larger discussion worth its own PR.
