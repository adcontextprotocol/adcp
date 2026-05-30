---
"adcontextprotocol": minor
---

feat(compliance): add typed JCS non-finite controller error

Adds `JCS_NON_FINITE_NUMBER` to the comply-test-controller `ControllerError.error`
enum for digest-mode `query_upstream_traffic` responses that cannot be RFC
8785/JCS-canonicalized because the parsed JSON-like value tree contains a
non-finite numeric value (`NaN`, `+Infinity`, or `-Infinity`).
Runner-output and storyboard contracts now state that this case grades the
affected upstream_traffic digest validation as `not_applicable` and contributes
to `validations_not_applicable`, not `steps_failed`.

Closes #5069.
