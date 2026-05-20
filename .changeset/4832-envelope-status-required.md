---
"adcontextprotocol": minor
---

spec(envelope): `status` is REQUIRED on every task response envelope.

The protocol envelope (`core/protocol-envelope.json`) now declares `status` in its `required` array, formalizing the wire contract the docs and conformance storyboards already assume. Every task response — including synchronous read-only metadata calls like `get_adcp_capabilities` — MUST carry a top-level `status` field. Synchronous calls emit `status: "completed"`; async calls emit `submitted`, `working`, `input-required`, etc. per the task-status enum.

**Why this is a wire-shape clarification, not a new requirement.** The docs (`sdk-stack.mdx`, `mcp-response-extraction.mdx`, `webhooks.mdx`, `error-handling.mdx`) already treat envelope `status` as a canonical protocol-layer field. The `v3_envelope_integrity` conformance storyboard already asserts presence via `envelope_field_present`. The schema design just left `status` declared but not required on the envelope, which let SDKs ship without emitting it on some sync responses. This change closes that ambiguity.

**Resolves #4832** — adopter (`@adcp/sdk@7.7.0`, production seller) hit `v3_envelope_integrity/no_legacy_status_fields` failure because the SDK's auto-registered `get_adcp_capabilities` handler builds the response payload without setting `status`. The storyboard was correct; the envelope contract just wasn't formalized in schema.

**Adopter impact.** Agents shipping responses without top-level envelope `status` are now non-conformant per the schema. The single broadly-distributed gap is `@adcp/client`'s auto-registered `get_adcp_capabilities` (tracked separately); other tools that go through the v6 handler pipeline already carry `status` because the SDK threads the envelope around typed platform returns. Adopters using raw-handler patterns (deprecated v5) should audit their responses and add `status: "completed"` to any sync response missing it.

**Phased follow-ups (not in this PR):**
- SDK companion in `adcp-client`: emit `status: "completed"` on the auto-registered `get_adcp_capabilities` handler (and audit any other sync helper that builds responses without the v6 pipeline).
- Per-task schema fold: extend each of the 64+ task response schemas (`create-media-buy-response.json`, `sync-creatives-response.json`, etc.) to `$ref` `protocol-envelope.json` in addition to `version-envelope.json`. Mechanical cleanup that lets per-task `response_schema` validators catch envelope omissions directly, without relying on the separate `envelope_field_present` storyboard check. Targeted for the 3.1 cycle ahead of GA.
