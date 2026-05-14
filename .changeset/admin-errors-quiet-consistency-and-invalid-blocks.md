---
"adcontextprotocol": patch
---

Stop two recurring `#admin-errors` log streams:

- `network-consistency-reporter`: null-guard `extractDeclaredProperties` so brand rows with `brand_manifest IS NULL` no longer crash the worker with `Cannot read properties of null (reading 'brands')`. The outer org-selection query now filters `brand_manifest IS NOT NULL`, and the per-org loop drops manifest-less brands before picking `brands[0]`.

- `announcement-trigger`: surface Slack's `response_metadata.messages` (the only place validation errors name the offending block/field) in the thrown `Error.message`, and add a redacted block-shape summary (per-block type + text/url/alt lengths) to the failure log. Bare `Slack API error: invalid_blocks` lines now carry actionable detail. Capped at 1KB to bound log size for pathological Slack responses, and `imageUrlLength` is only logged when the scheme is `https`. Header text is also clamped to Slack's 150-char `plain_text` cap so over-long `organizations.name` values can't push the header past the limit.
