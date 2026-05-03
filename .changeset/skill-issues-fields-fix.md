---
---

docs(skill): correct `issues[]` field names + split spec-optional from SDK-synthesized

Follow-up to #3927. Three corrections to `skills/call-adcp-agent/SKILL.md`:

1. **Casing.** `error.json` defines the wire field as `schema_id` (snake_case, line 54). #3927 documented it as `schemaId` — that shape is `@adcp/sdk`-normalized and breaks Python/Go/raw-HTTP callers reading the literal JSON. Renamed to `schema_id` in prose and the symptom-fix table; called out the SDK casing variance separately.

2. **Category split.** `schema_id` and `discriminator` are spec-optional wire fields per `error.json`. `hint` and `allowedValues` are NOT in `error.json` — they're synthesized client-side by `@adcp/sdk` after parsing. Grouping all four under "implementation-dependent fields a validator may opt into" told non-TS callers to look for fields no AdCP seller emits. Split into two clearly-labeled tiers: spec-optional (sellers MAY emit) vs SDK-side enrichment (your SDK adds these locally, irrespective of seller).

3. **Recovery order.** Restored `pointer` + `keyword` + `variants` as the unconditional one-step path; treats `discriminator` / `hint` / `schema_id` as shortcuts when present rather than required first reads. The previous front-loading made callers branch on optional fields that are absent on the long tail.

Also fixed `discriminator` field shape in prose and table: items are `{property_name, value}` per `error.json:65-71`, not `{field, value}`.

Doc-only. No wire-format change. Not for cherry-pick to `3.0.x` — `schema_id` and `discriminator` were added to `error.json` in #3875 (main only) and are not in 3.0.x's wire schema.
