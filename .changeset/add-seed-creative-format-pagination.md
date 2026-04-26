---
"adcontextprotocol": minor
---

feat(compliance): add seed_creative_format scenario and list_creative_formats pagination

Adds `seed_creative_format` to `comply_test_controller` so the compliance harness can pre-populate a deterministic, size-controlled set of creative formats for pagination-integrity storyboards.

**Schema changes (comply-test-controller-request.json, comply-test-controller-response.json):** `seed_creative_format` added to the `scenario` enum in both files. The request schema gains a `params.format_id` string field (required when `scenario = seed_creative_format`) and the response schema's `list_scenarios` enum is extended to match.

**Training-agent implementation:** `seed_creative_format` is handled in `handleComplyTestController` before the SDK dispatcher. Seeded formats are stored in a new `session.complyExtensions.seededCreativeFormats` map and replace the static catalog when non-empty for `list_creative_formats` responses.

**Pagination:** `handleListCreativeFormats` now applies cursor-based pagination (matching the `list_creatives` pattern) and is session-aware to read seeded formats. Non-compliance callers continue to see the full static catalog with pagination applied.

**Storyboard:** `pagination-integrity-creative-formats.yaml` exercises the cursor↔has_more invariant on `list_creative_formats` by seeding two formats and walking pages at `max_results=1`.

Non-breaking: adds a new enum value and optional param. Sellers that don't implement `seed_creative_format` will return `UNKNOWN_SCENARIO`; the storyboard's `controller_seeding: true` signals that support is required for this storyboard to pass. Existing callers of `list_creative_formats` are unaffected — pagination fields are additive to the response.

Closes #3108.
