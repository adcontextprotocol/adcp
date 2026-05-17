---
"adcontextprotocol": minor
---

canonical-formats: address round-3 expert review (protocol, product, code, docs, security) + adopter feedback on v1↔v2 multi-size projection.

**Wire-shape changes**

- **`v1_format_ref` is now an array** of one or more `format_id` objects (was: single object). Always-array shape — single-ref is `[{...}]`. Enables multi-size v2 declarations to project to multiple v1 named formats without forcing the lossy single-rep emission the SDK implementor surveyed flagged. All existing fixtures wrapped.
- **Multi-size fan-out (normative).** A multi-size `image`/`html5`/`display_tag` declaration SHOULD carry one `v1_format_ref[]` entry per size in `params.sizes[]`. SDKs MAY (non-normative) fan out automatically by catalog lookup. NYTimes Homepage fixture demonstrates: each format_options entry now declares 3 v1 refs (300×250, 728×90, 970×250).
- **Size-mode mutex at schema layer.** `image`/`html5`/`display_tag` now enforce exactly-one-of fixed/multi-size/responsive via `allOf: [oneOf: [...]]` rather than prose-only. SDKs running plain JSON Schema validation now catch combinations that previously slipped past.
- **`placement-definition.format_options[]` capability-only branch** drops `additionalProperties: false`. Adopters attaching placement-local fields (`display_name`, etc.) no longer get opaque "matched no anyOf branch" errors; buyer SDKs treat extras as placement-level overrides on the resolved declaration.
- **`adagents.json#superseded_by` field**: AAO community-mirror entries set this when a platform adopts AdCP, pointing buyer SDKs at the platform-hosted file. Mirror SHOULD continue serving ≥1 minor release with `superseded_by` set for migration-signal symmetry.
- **`ProductFormatDeclaration.seller_preference`**: optional `preferred | accepted | discouraged` soft hint on multi-format products. Buyer agents respect when their own constraints don't override. Addresses the "agency traffickers pick blindly" friction.
- **`list_creative_formats` response `source` field**: enum `publisher | aao_mirror | agent_derived` labels which tier of the resolution chain produced the formats list. Two SDKs querying the same agent for the same publisher now have consistent telemetry signal.

**New error codes**

- `FORMAT_CAPABILITY_UNRESOLVED` — broken `capability_id` reference in `placement.format_options[]`. Same-file resolution scope; closes off capability_id squatting across publisher boundaries.
- `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` — emitted ALONGSIDE the partial v1 emission (not in place of it) when `v1_format_ref[]` count < `sizes[]` count. Ratifies the adopter-implemented diagnostic.

**Docs**

- New "Where to declare a format" decision matrix (publisher catalog vs product inline vs placement) + `applies_to_property_ids` (property-level support) vs `placements[].format_options[]` (placement-level binding) explicit disambiguation.
- New "Format discovery (resolution order)" section with normative three-tier walk (publisher / aao_mirror / agent_derived), SSRF-contract pointer to `format_schema`, identity-confusion callout (mirror URL is format-shape namespace, NOT seller identity), platform-adoption cutover via `superseded_by`, and community-mirror trust/governance gap (single-trust-anchor concern, 3.2 hardening tracked separately).
- Meta Reels worked-example tone fixes — historical "category error in earlier drafts" / "is gone now" framing removed; statements positive. Logo / brand-name claims clarified ("Meta auto-overlays from linked Page — auth context outside AdCP; brand_kit_override exists for formats whose seller-side renderer overlays brand").
- Cut the redundant single-size HTML5 comparison block from the IAB display worked example.
- Mirror domain migration note: `mirror.adcontextprotocol.org` → `creative.adcontextprotocol.org/translated/` (the earlier subdomain was never provisioned). Documented on `product-format-declaration.json#v1_format_ref`.

**SKILL.md gap closed**

- Both `skills/adcp-creative/SKILL.md` and `skills/adcp-media-buy/SKILL.md` now carry a canonical-formats stanza covering `format_kind`, `format_options`, `capability_id`, `v1_format_ref` (array), size-mode flexibility, community-mirror discovery, `seller_preference`, the conversion-tracking boundary (event_log NOT format), and the new error codes. Coding agents consuming SKILL.md to generate adagents.json + product fixtures now produce canonical-formats-shaped output rather than v1-shaped.

**Lint tightening**

- `tests/canonical-format-conventions.test.cjs`: `UNADOPTED_PLATFORMS` derived from `static/examples/adagents/community/*.json` filenames (no manual list to maintain); regex tightened to https-only (was https?); warning+pass output dedup'd.

**Out-of-scope (filed as follow-ups elsewhere)**

- GAM/Prebid extractor script for `formats[]` population (long-tail publisher adoption).
- `OWNERS` files per community-mirror translation + freshness threshold that degrades authority in buyer SDK.
- Signed-body + transparency-log hardening for the community-mirror trust anchor (tracked as 3.2 follow-up).
