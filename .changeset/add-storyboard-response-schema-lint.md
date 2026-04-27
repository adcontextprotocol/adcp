---
---

Add response-side storyboard schema lint (`scripts/lint-storyboard-response-schema.cjs`) that validates `sample_response` fixtures against `response_schema_ref` using AJV, mirroring the existing request-side lint. Includes shrink-only ratchet allowlist, Node test wrapper, and CI wiring. Implements #2823.
