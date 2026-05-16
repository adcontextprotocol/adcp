---
---

docs+spec(adagents): SDK ergonomics — field-reference parity, codegen note, size-cap cross-link

Closes #4508. Four small spec/SDK ergonomics fixes from the PR #4504 expert review:

1. **Field-reference parity in `adagents.mdx`.** Added `revoked_publisher_domains[]` and per-`authorized_agents[]` `last_updated` to the canonical Schema Fields section. A buyer-side SDK implementer reading the field reference cold can now find both — previously they only lived in `managed-networks.mdx` and the JSON Schema.

2. **Codegen-gap note + test fixture for `product.publisher_properties`.** The restriction (`allOf: [$ref selector, {not: {required: [publisher_domains]}}]`) is correct JSON Schema but several codegen toolchains (quicktype, datamodel-code-generator, openapi-typescript-codegen) flatten this shape poorly and silently drop the `publisher_domains[]`-rejection constraint. Field description now calls this out so SDK implementers enforce singular-only at runtime. Added three new test cases in `tests/composed-schema-validation.test.cjs` locking the constraint: singular accepted, compact form rejected on both `by_tag` and `all` selectors. 37/37 pass.

3. **Size-cap cross-link in `authoritative_location` schema description.** The two-tier cap (5 MB pointer / 20 MB authoritative second-hop) lived only in `managed-networks.mdx`. Schema description now references it so generated SDK docs don't drop the cap.

4. **Trimmed SDK-runtime sentence from selector field descriptions.** The protocol schema described "Generated SDK types in TS/Py/Java/Go expose both fields as optional; consumers MUST check at runtime" — accurate but SDK-internal. Trimmed to just the XOR rule; the SDK-specific note belongs in SDK docs.

Description-only changes to existing schema fields plus the new test fixtures. Existing files validate unchanged.
