---
---

Fix `title` in `error-details/rate-limited.json` from `"RATE_LIMITED Details"` to `"Rate Limited Details"`. The JSON Schema `title` annotation is non-normative; no validation or wire-format change. This corrects the generated TypeScript type name from `RATE_LIMITEDDetails` to `RateLimitedDetails` in downstream codegen consumers (see adcp-client#942 for the SDK alias layer).
