---
---

Three follow-ups to PR #2522's duplicate-key MUST-reject tightening, landing the residuals security review flagged before close.

**Admission-pressure baseline anchor** (#2545, `security.mdx` webhook replay dedup sizing):

The prior rule alerted when new-keyid admission exceeded "3× the 24-hour moving average, floored at 5 distinct new keyids / 5 minutes." A patient attacker staging keys over multi-week ramp-up dragged the 24-hour moving average up with the attack — by the time traffic reached attack-worthy volume, "3× baseline" absorbed the attack into normal. Rule now uses a triple-threshold shape, whichever triggers first:

- `3×` the 24-hour moving average (short-window spike)
- `2×` the 30-day P95 (long-window ramp-up resistance — dominant tail is baseline, not the attack ramp)
- fixed ceiling of **50 distinct new keyids per 5-minute window** (sparse-traffic verifier floor — sub-threshold attacks that never trip the ratio rules still trip the ceiling)

Operators MAY raise the fixed ceiling for high-volume onboarding periods with documented justification and floor-to-baseline afterward. The triple shape is the operational norm for rate-anomaly detection (CloudWatch CWA baseline rules, Loki drift detection).

**Signer-side conformance fixtures** (#2546, `static/test-vectors/webhook-hmac-sha256.json`):

The signer-side MUST ("signers MUST reject duplicate-key input from upstream callers before serialization") was introduced in PR #2522 but had no companion fixture for interop harnesses. Two new vectors in a new `signer_input_rejection_vectors[]` array:

- `signer-upstream-duplicate-key-rejection` — top-level duplicate (`{"status":"approved","status":"rejected"}`)
- `signer-upstream-duplicate-key-deep-nested` — nested duplicate (`{...,"result":{"media_buy_id":"mb_001","media_buy_id":"mb_evil"}}`). A signer that only checks top-level keys would silently pass a shallow-check fixture and ship the exact nested parser-differential the rule is meant to prevent — the nested vector catches that gap.

New top-level `signer_action_values` enum map defines `"reject-input-before-sign"` so downstream harnesses resolve the action token from a single source of truth. Test harness adds five new structural assertions including a byte-level check that the fixture's `signer_input_body` actually contains duplicate keys (prevents a future edit from breaking the fixture's probing power without CI noticing). Security.mdx duplicate-object-keys clause now references both fixtures and mandates interop harnesses exercise both.

**Key-name logging sanitization** (#2547, `security.mdx` step 14b):

Step 14b told verifiers to log duplicate key names as diagnostic signal, but did not constrain how. An attacker holding a compromised signer key could construct `{"<arbitrary-bytes>":1,"<arbitrary-bytes>":2}` frames and land attacker-chosen bytes in defender SIEM logs at scale — smaller channel than full-body logging but non-zero and well-precedented as a log-injection vector (newline/ANSI-sequence/control-char injection into parsers and terminal viewers). Step 14b now mandates three sanitization rules before logging duplicate key names:

- Truncate each key name to at most **64 bytes** (realistic JSON schema field names are well under; anything longer is attack signal, not schema)
- Replace non-printable characters, control characters, and ANSI escape sequences with a fixed placeholder (`<non-printable>`)
- Cap the number of duplicate key names logged per rejection at **8**, emitting `<...N more>` if exceeded

These constraints close the attacker-controlled-byte channel without losing the diagnostic value of knowing which key(s) collided.

Closes #2545, #2546, #2547.
