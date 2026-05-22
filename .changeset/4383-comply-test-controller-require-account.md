---
"adcontextprotocol": minor
---

`comply_test_controller`: `account.sandbox: true` is now **required** on every controller request. The follow-up to #4382 / #3755 — sample_request blocks across all 25 controller call-sites in the storyboard suite have been swept to include the field, and the request schema's `required` array now lists `account` alongside `scenario`. Schema examples updated to match.

Lint coverage is automatic: the existing `lint-storyboard-sample-request-schema.cjs` runs ajv against every storyboard sample_request, so any new `comply_test_controller` step that omits `account.sandbox: true` fails CI with `required@/:account` and is blocked without an allowlist entry. No new lint code needed — the schema tightening is the gate.

This operationalizes the (Sandbox) verdict's defense-in-depth: the seller-side persisted-record check is the load-bearing gate, and now the wire format enforces it too. Closes #4383.
