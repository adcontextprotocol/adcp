---
"adcontextprotocol": patch
---

spec(errors): wire-placement guidance for `GOVERNANCE_DENIED` and `GOVERNANCE_UNAVAILABLE`

`error-code.json` defined the codes' semantics but didn't say WHERE in the response they appear. Different storyboards interpreted differently — issue #3914 surfaced one mismatch where the brand-rights compliance storyboard expected `expect_error: code: GOVERNANCE_DENIED` even though `acquire_rights` already has a first-class `AcquireRightsRejected` discriminated arm with `reason`. Adopters returning the spec-correct Rejected shape were failing the storyboard.

The `enumDescriptions` for both codes now state placement explicitly:

- **`GOVERNANCE_DENIED`** — structured business outcome, not a system error. When the task response defines a structured rejection arm (e.g., `AcquireRightsRejected`), that arm is the canonical denial shape — populate `status: "rejected"` + `reason`, do NOT additionally emit the code in `errors[]` or `adcp_error`, and do NOT flip transport-level failure markers. When the task has no rejection arm (e.g., `create_media_buy` returns the `Error` arm), populate `errors[].code` AND `adcp_error.code` per the two-layer model and DO flip transport markers.
- **`GOVERNANCE_UNAVAILABLE`** — system error, governance call failed at all. Always populate both layers with the code and flip transport markers. Sellers MUST NOT use a structured rejection arm for unavailability even when the task offers one — the buyer's recovery semantics differ (retry-with-backoff vs. restructure-or-escalate).

The contrast resolves the question the storyboard mismatch surfaced: thrown adcp_error is reserved for governance-call failure modes (parallel to `GOVERNANCE_UNAVAILABLE`), not for adopter-controlled denials.

The MUST NOT against dual-emission isn't a behavior change — `AcquireRightsRejected` and `CreativeRejected` already declare `not: { required: [errors] }` at the schema layer, so emitting `errors[]` alongside a rejection arm was already a schema violation. The doc-comment makes the rule discoverable from the error code without changing what conformant senders produce.

Also adds a parallel storyboard-authoring note in `error-handling.mdx`: when the task response has a discriminated rejection arm, assertions should use `check: field_value, path: "status", value: "rejected"` rather than `check: error_code`. The existing `error_code` guidance is correct for tasks without a rejection arm; the new note covers the rejection-arm path that surfaced via #3914.

Closes the doc-comment item on #3918; companion to #3914 (storyboard fix is separate work).
