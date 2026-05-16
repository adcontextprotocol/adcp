---
"@adcontextprotocol/adcp": minor
---

canonical-formats: second expert-review pass on PR #3307 — wire-level concerns, security hardening, auto-promote-stable, and narrowing semantics.

Triaged from 5 expert reviews (ad-tech-protocol-expert, adtech-product-expert, code-reviewer, docs-expert, security-reviewer) plus a second SDK-implementor review. Items merged into 4 blocks of inline fixes; 3 follow-up issues filed (#4591 scope extended, #4592, #4599).

## Block A — security hardening on `format_schema` fetch

- **SSRF deny-list** (normative): RFC 1918 / loopback / link-local / CGNAT / RFC 6761 special-use rejected; cloud metadata endpoints (169.254.169.254, metadata.google.internal, kubernetes.default.svc) explicitly forbidden; resolved IP pinning to defeat DNS rebinding.
- **No HTTP redirects** on these fetches — open redirects on same-origin paths are a free SSRF primitive.
- **1 MiB response cap**, enforced during streaming.
- **Schema-compile DoS controls**: keyword count ≤10 000, `$ref` count ≤256, `pattern` regex via re2 or per-pattern timeout, per-manifest validation budget ≤250 ms.
- **Digest format pinned**: `sha256:` + 64 lowercase hex.
- **`$ref` sandbox**: same-origin (after RFC 3986 §6 normalization) / AAO mirror / intra-document JSON Pointer only; cross-origin and `file://` rejected.
- **Transport rules apply to BOTH** `format_schema` (load-bearing) AND `platform_extensions` (informational) — shared fetch path can't drop to the weakest bar. `platform-extension-ref.json` `uri` gets `pattern: "^https://"` for defense-in-depth.

## Block B — wire-level load-bearing concerns

- **B1 per-slot `consumed_for_production` boolean** on `_base.json#slots`: dispatch hint for build_creative and v1↔v2 translators so they know which slots are render-verbatim vs production-consumed (host-read script vs MP3 file, brief vs generative video, catalog feed vs SKU placement). Without this the dispatch table lives in adopter code and every SDK gets it slightly different.
- **B2 SHOULD-warn surfaces via `errors[]` envelope**, not logger-only. Two new error codes added to `error-code.json`: `FORMAT_PROJECTION_FAILED` (v1 format can't project to canonical) and `FORMAT_DECLARATION_DIVERGENT` (dual-emitted format_ids + format_options disagree). Both non-fatal — sellers don't flip transport failure markers.
- **B3 open-enum guidance** on `canonical-format-kind.json`: consumers MUST treat the enum as open; unknown `format_kind` values MUST be retained on the in-memory object and SHOULD be treated as `runtime_status: declared_only` for routing. Prevents every future canonical from being a breaking change for older SDKs.
- **B4 `validate_input` request renamed to discriminated `targets[]`**, mirroring the response shape. Eliminates wire-shape collision between request `format_ids: string[]` and `Product.format_ids: FormatId[]`.

## Block C — auto-promote-stable + correctness + narrowing semantics

- **C1 6-canonical Track-A promotion to `stable` at 3.1 GA**: `image`, `display_tag`, `video_hosted`, `video_vast`, `audio_hosted`, `audio_daast` — re-encodings of IAB/VAST/DAAST that round-trip cleanly through `v1-canonical-mapping.json`. 5 canonicals stay Track-B preview (`html5` lossy round-trip, `image_carousel` no v1 mapping entry, `sponsored_placement` adapter-contract dependency #4592, `responsive_creative` algorithmic, `agent_placement` 3.2-track per IR8). Each Track-A canonical carries `default: "stable"` on its own `status` field overriding `_base.json`'s `default: "preview"`.
- **C2 negative-test AJV** now constructed with `discriminator: true` matching the positive suite's strict-mode config.
- **C3 new `format_kind: "custom"` fixture** (`nytimes_homepage_takeover_custom.json`) covers the riskiest oneOf branch with `canonical_formats_only: true` + `format_shape` + `format_schema`.
- **C5 positive controls** added for `canonical_formats_only` on non-custom branches (Track-B canonicals MAY ship as v2-only).
- **C6 (N1) formal "narrows" definition** in canonical-formats.mdx: parameter-by-parameter subsumption rules (scalar containment, enum subset, range inclusion, asymmetric narrowing, conflict detection) so SDKs implementing dual-emission divergence detection don't each invent their own.
- **C7 (N3) `canonical_parameters` drift contract**: hand-authored values MUST satisfy the narrows relation against v1 `requirements`; SDKs SHOULD lint-time check and emit `FORMAT_PROJECTION_FAILED` on divergence. Producers SHOULD prefer to omit and let SDKs derive the v2 shape from v1 `requirements` + `assets[*]` rather than hand-author both shapes.
- **C8 (N7) `asset_group_id` alias collision precedence**: v1 `assets[*]` declaration order is authoritative; first slot wins; subsequent collisions dropped and surfaced via `FORMAT_PROJECTION_FAILED` with structured `error.details`.
- **C9 (N8) `declared_only` SHOULD-filter by default** on buyer SDKs (opt-in to surface); without the default filter the value is a doc string adopters ignore.

## Block D — docs structural pass (selective)

- **TL;DR block hoisted to top of canonical-formats.mdx**: 6/11 stable at GA, v1 stays first-class, 71+ v1-only at GA, Phase 4 codegen is the gating dep. Cold-read reader gets the load-bearing facts in the first 60 seconds instead of buried at line 880.
- **Codegen-vs-runtime promoted to H2** (was buried as H3 under Migration).
- **Naming-note tightened**: doc body uses "canonical formats" consistently; "v1↔v2" reserved as schema-description shorthand only.

## Follow-up issues filed (GA-blocking but not 3.1-beta-merge-blocking)

- **#4591 extended** with the (canonical × production_source) storyboard matrix scope (N5 from second implementor review).
- **#4592** sponsored_placement adapter-contract docs (IR5 from first round).
- **#4599** v2→v1 demotion synthetic format_id docs note (N2 from second implementor review).

## Test coverage

- 14 positive canonical-formats fixtures (added 1 custom-shape fixture)
- 15 negative product-format-declaration fixtures (added 2 for `canonical_formats_only` semantics on non-custom)
- All schema tests pass under `discriminator: true` strict mode
