---
---

Introduce `negative_path` attribute for storyboard steps to distinguish `schema_invalid` (skip lint, default) from `business_rule` (schema-valid payload, validate anyway) negative-path tests. Updates `isNegativeStep` in the request-schema lint, documents the field in `storyboard-schema.yaml`, tags all 32 `expect_error: true` steps in the corpus, and fixes pre-existing fixture drift in content-standards and signal-marketplace storyboards. Implements #2824.
