---
"@adcontextprotocol/adcp": minor
---

canonical-formats: address SDK-team implementor review on PR #3307 with inline normative tightening.

- **v2→v1 projection (IR1)**. Add `canonical_formats_only` boolean to `ProductFormatDeclaration`; required `true` for `format_kind: "custom"` declarations. Add normative producer/consumer rules for dual-emission (`format_ids` + `format_options`) and divergence detection in canonical-formats.mdx. Protocol does not mint synthetic v1 `format_id`s — explicit `canonical_formats_only` is the v2-only marker.
- **Non-projectable v1 SHOULD-warn (IR2)**. v1-canonical-mapping.json now normatively requires SDKs to emit a structured warning (carrying format_id, product_id, resolution-failure reason) when a v1 product can't project to a canonical. Prevents silent inventory shrinkage for v2-only buyers.
- **`format_schema` fetch contract (IR3)**. Pin normative fetch semantics on `format_schema`: https-only transport, hard-fail on digest mismatch, ≤5s timeout, `$ref` sandboxing (same-origin / AAO-mirror / intra-document only; no `file://`; transitive depth ≤8), graceful degradation on 404 / partition, schema-not-valid hard-fail. Documented in both the schema description and canonical-formats.mdx custom-formats section.
- **Codegen-vs-runtime asymmetry (IR6)**. Doc callout that generated TS/Pydantic types lose the `allOf/if/then` conditionals on `format_kind: "custom"` and `result_kind`; runtime Ajv (or equivalent) validation is the gate. Adopters MUST validate at runtime, not rely on the type system.
- **`agent_placement` 3.2-track (IR8)**. Explicit description-level stamp that the tracking macro vocabulary, postback shape, and dedup model are intentionally underspecified for 3.1. Adopters claiming the canonical SHOULD set `runtime_status: 'preview'` or `'declared_only'`. Wire contract for tracking events ships in 3.2.
- **Migration math reality (IR9)**. Realistic-coverage paragraph in canonical-formats.mdx: 15 registry entries at 3.1, ~76% of audited formats fit but require seller or registry action to project, 71+ v1-only out of gate. Dual-read codepath realistic through 3.3; v2-only realistic at 4.x earliest.

Negative-fixture suite expanded: `format_kind: "custom"` now rejects when `canonical_formats_only` is missing or `false`.

Conformance-storyboard track (IR4) and adopter-contract docs for `sponsored_placement` (IR5) filed as follow-up issues against 3.1 GA.
