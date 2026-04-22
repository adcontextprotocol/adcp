---
---

Resolve the `format_id` / `signal_ids` entity-id drift cluster (adcp#2763 cluster follow-up to #2768).

Two-part fix:

1. **Lint improvement.** `placeholderFor` now synthesizes shape-valid object placeholders for substitutions that land at object-typed schema locations (including oneOf/anyOf discriminated unions). Previously, a substitution string like `"$context.first_signal_id"` landing at a `oneOf` of object variants produced `{}`, which ajv rejected against every `required`. The runtime resolves those substitutions to concrete objects captured from prior steps, so the lint should treat them as shape-valid. Five false positives across `format_ids`, `format_id`, and `signal_ids` now pass automatically.

2. **Fixture fix.** `specialisms/creative-template/index.yaml#build/build_multi_format` was missing the required `format_id` on `creative_manifest`. Added `{ agent_url, id }` matching the canonical `core/format-id.json` shape.

Allowlist shrinks 35 → 29.
