---
"adcontextprotocol": patch
---

Clarify that exhausting the rate-limit trip runner without observing a
`RATE_LIMITED` response is a coverage gap reported with
`skip_result.reason: not_applicable` and
`skip_result.detail: rate_limit_not_triggered`, not a seller conformance
failure.
