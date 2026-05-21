---
"adcontextprotocol": minor
---

spec: fold `protocol-envelope.json` into per-task response schemas

Closes #4878. Companion to #4876 (envelope `status` REQUIRED) — that PR locked the contract on the envelope schema; this PR cascades it to every per-task response schema so per-task `response_schema` validators catch envelope omissions directly, without relying on the separate `envelope_field_present` storyboard check.

**What changed.** 64 task response schemas now `$ref` `core/protocol-envelope.json` in their `allOf` chain alongside the existing `core/version-envelope.json` ref. Two schemas without an existing `allOf` (`brand/search-brands-response.json`, `creative/validate-input-response.json`) had `allOf` added with both envelope refs for consistency.

**Carve-outs.**
- `core/pagination-response.json`, `core/catalog-events-response.json` — nested helpers, not task responses. Excluded.
- `governance/check-governance-response.json`, `governance/report-plan-outcome-response.json` — body-level `status` enum (`approved`/`denied`/`conditions` and `accepted`/`findings` respectively) collides with envelope `status` (task-status enum) on MCP flat serialization. Excluded; tracked as a separate spec issue.

**What this catches in adopter shape.** Pre-3.1-GA, any response shape lacking top-level envelope `status` now fails its own per-task `response_schema` validator, not just the universal `envelope_field_present` storyboard step. Validators integrated against the per-task schema (typed-SDK codegen, request-replay tooling, schema-aware test fixtures) gain envelope coverage for free.

**Cleanup also applied.** 25 schema examples in the affected response schemas were updated to include `status: "completed"`. 62 JSON blocks in the docs (across 27 `.mdx` files) were updated likewise. Test fixtures in `tests/composed-schema-validation.test.cjs` and `tests/example-validation-simple.test.cjs` were updated to include `status` on the relevant cases — surface-aligned with the schema fold so the test suite continues to assert what conformant adopters MUST send.

**SDK companion (filed separately as #4877).** `@adcp/client`'s auto-registered `get_adcp_capabilities` handler needs to emit `status: "completed"` for adopter responses to remain conformant; that's the going-forward fix in the SDK repo.

**Body-status conflict tracked as follow-up.** The two carve-outs (`check_governance`, `report_plan_outcome`) need their body discriminator field renamed (e.g. `verdict` / `decision`) ahead of 3.1 GA. Filing as a separate spec issue.
