---
"adcontextprotocol": minor
---

canonical-formats: publisher-scoped format catalog via `adagents.json` `formats[]` + `placement-definition.json` `format_options[]`. Resolves #4620 in-PR (was filed as a follow-up; pulled in because the wire shape is the same vocabulary PR #3307 already establishes).

- **`adagents.json` top-level `formats[]`** carries publisher-authoritative `ProductFormatDeclaration` entries. Optional `applies_to_property_ids` / `applies_to_property_tags` scope each declaration to a subset of the file's `properties[]`. Single source of truth for "what formats does this publisher support" — eliminates the N-copies-on-N-products drift surface.
- **`placement-definition.json` `format_options[]`** lets a placement reference a `capability_id` from the file's top-level `formats[]` OR carry an inline `ProductFormatDeclaration`. Parallel to existing v1 `format_ids[]`; both supported during the migration window.
- **`list_creative_formats` (media-buy) gains `publisher_domain` + `property_id` filters**. SDKs resolve the question "what formats does Meta support" by fetching `<publisher_domain>/.well-known/adagents.json` first, then the AAO community-registry mirror at `https://creative.adcontextprotocol.org/translated/<platform>/adagents.json` as fallback, returning `formats[]` directly. No product traversal required.
- **Community-registry pattern (normative for unadopted platforms)**. For platforms that haven't adopted AdCP (Meta, TikTok, Snap, Pinterest, etc.), AAO publishes community-maintained `adagents.json` at the mirror namespace. When the platform later adopts AdCP and publishes its own `adagents.json` with `formats[]`, the platform-hosted file takes precedence and the mirror entry deprecates. Documented on `product-format-declaration.json#v1_format_ref` and reflected in the Meta Reels worked example.
- **Reference fixture** at `static/examples/adagents/community/meta.json`: Instagram + Facebook + WhatsApp properties, Meta Reels / Feed Image / Stories Video / Feed Carousel format declarations with `applies_to_property_ids` scoping, four placements wired to formats via `capability_id`.
- **Meta Reels worked example rewritten** in `docs/creative/canonical-formats.mdx` showing where each Reels feature lives (canonical params, slot narrowing, platform extensions, BrandRef brand_kit_override), the community-registry hosting pattern, and how a seller's product references the catalog declaration by `capability_id`.
- **Registry shrink**: `v1-canonical-mapping.json` drops the last literal entry (`meta_reels`). The registry is now seven pure-structural fallbacks; platform-specific formats project via the platform's own (or community-mirror) `adagents.json` `formats[]` rather than enumerated registry literals. Honors the canonical-formats parametrization principle.
- **`v1_format_ref.agent_url` convention extended**: IAB-standard → `https://creative.adcontextprotocol.org`; platform-adopted → platform's agent_url; platform-unadopted → `https://creative.adcontextprotocol.org/translated/<platform>`. Keeps v1 namespace converged regardless of which side hosts the catalog.

Closes #4620, #4652.
