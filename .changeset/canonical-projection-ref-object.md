---
"adcontextprotocol": minor
---

canonical-formats: v1 catalog `canonical:` annotation is now always an object (no bare-string shorthand). Adopter feedback surfaced that bare `canonical: "image"` was lossy for v1 entries whose asset shape doesn't follow the canonical's defaults — most visibly the 8 `display_*_generative` entries that take a text prompt, not image bytes.

**Schema change**

- New `static/schemas/source/core/canonical-projection-ref.json` with required `kind` + optional `asset_source` + optional `slots_override`.
- `format.json#canonical` field now `$ref`s the projection-ref schema instead of the bare `canonical-format-kind.json` string enum.
- No `oneOf [string | object]` fallback — always object. Minimal form is `{ "kind": "image" }`; rich form adds `asset_source` and `slots_override` when the v1 entry doesn't follow the canonical's defaults.

**Catalog re-annotation**

- 33 non-generative v1 catalog entries: `canonical: "image"` → `canonical: { "kind": "image" }` (and same for other kinds). Pure shape change; same projection semantics.
- 8 generative entries (`display_generative`, `display_300x250_generative`, `display_728x90_generative`, `display_320x50_generative`, `display_160x600_generative`, `display_336x280_generative`, `display_300x600_generative`, `display_970x250_generative`): newly annotated with the rich form — `kind: image`, `asset_source: agent_synthesized`, `slots_override: [{ generation_prompt: text, required }]`. v2-aware buyers can now project these correctly: the projected `ProductFormatDeclaration` carries `format_kind: image, asset_source: agent_synthesized, slots: [generation_prompt: text]` — a buyer with a generation prompt can satisfy it; a buyer with image bytes can't.

**Why this solves the "seller says no generative" question.** By declaring `format_kind: image` with default slots (no `asset_source` override), the seller's product requires `image_main: image, required: true`. A generative buyer can't satisfy that contract — opt-out is automatic. To opt INTO generative, the seller declares `asset_source: agent_synthesized` and overrides `slots[]` explicitly. The two-axis model (format_kind = TYPE, asset_source = SOURCE) already existed; the catalog now uses both axes.

**Docs**

- New "v1 → v2 projection via `canonical:` annotation (object shape)" section in canonical-formats.mdx covering both cases, projection rules, the generative-entries example, and the "how does seller say no generative" answer.

**Lint**

- `tests/canonical-format-conventions.test.cjs` now walks the v1 catalog and fails on any bare-string `canonical: "..."` (must be object form). Soft-warns when `slots_override` is set without explicit `asset_source` (projection ambiguity).

Out-of-scope: the `v1-canonical-mapping.json` registry's `v2.canonical` field stays the string enum — registry entries map structural patterns to families and don't need per-entry `asset_source` / `slots_override`. If the registry ever grows generative-pattern entries, we'd revisit.
