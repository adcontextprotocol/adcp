# Machine-readable brand guideline constraints in `brand.json`

**Status**: Accepted for schema draft

**Decision**: `brand.json` should grow first-class fields for brand-guide rules that agents can enforce mechanically, while keeping `visual_guidelines.restrictions[]` for broad prose guardrails.

## TL;DR

Add one logo-selection field on `logos[]` plus three optional fields under `visual_guidelines`:

- `logos[].slots[]` for renderer-facing logo selection, such as `logo_card_light`, `logo_card_dark`, `profile_mark`, and `co_brand_lockup`.
- `format_options[].params.slots[].logo_slots[]` for connecting a creative-format `asset_group_id: "logo"` slot to the same logo-slot enum.
- `format_options[].params.slots[].required_logo_slots[]` for declaring which logo slots need explicit coverage.
- `color_constraints[]` for allowed/forbidden color pairings and "accent only" rules.
- `logo_usage_rules[]` for machine-readable minimum size, clear space, and slot/context-specific placement constraints.
- `mark_lockups[]` for co-brand, partner, and secondary-mark lockup rules: ordering, spacing, separator/keyline, and size ratios.

Keep `restrictions[]` for broad prose guardrails. Do not add fields for durable asset URLs, agents, operator authorization, or trademark registrations; those already exist in `brand.json` and were simply absent from the source PDFs that triggered this review.

## Problem

The real-brand guideline stress test showed good coverage for most identity material:

- Colors, typography, tone, and voice map cleanly.
- Photography guidance maps cleanly to `visual_guidelines.photography`.
- Logo asset selection maps partly to `logos[].orientation`, `logos[].background`, `logos[].variant`, and `logos[].usage`.
- Iconography, motion, and broad restrictions map to existing `visual_guidelines` fields.

Three rule types still collapse into prose:

1. **Color pairing matrices.** A guide can say "yellow is accent only, never a background" or "do not pair these two palette colors." Today that goes into `restrictions[]`, so an agent cannot query the palette and mechanically filter invalid foreground/background choices.
2. **Logo slot and usage semantics.** `logos[].usage` is human-readable. A renderer should not have to infer whether a logo is intended for a light card, dark card, profile mark, or co-brand lockup from prose or tags. A creative agent building a CTV end card also cannot reliably enforce per-logo minimum size, clear space, or "never on photography without knockout" constraints. A canonical format that asks for `asset_group_id: "logo"` also needs a way to say which renderer-facing logo slots are acceptable for that asset group.
3. **Co-brand and secondary-mark lockups.** Partner mark ordering, keyline spacing, and optical size ratios are currently prose. This is the clearest structural gap because those rules are layout instructions, not just narrative guidance.

## Non-goals

- Do not make source-PDF omissions look like schema gaps. If the source guide lacks durable HTTPS logo assets, `agents`, `authorized_operators`, or `trademarks[]`, that is missing source data.
- Do not replace `restrictions[]`. Generative systems still need prose guardrails for high-level brand judgment.
- Do not model every design-system rule. This proposal targets rules that agents can enforce before rendering or when selecting assets.

## Schema change

Add definitions to `static/schemas/source/brand.json` and expose them on `visual_guidelines`.

```jsonc
{
  "visual_guidelines": {
    "color_constraints": [
      {
        "color": { "kind": "name", "name": "market_yellow" },
        "applies_to": ["accent"],
        "forbidden_on": [{ "kind": "surface", "surface": "background" }],
        "severity": "must",
        "description": "Market yellow is accent only and must not be used as a dominant background."
      }
    ],
    "logo_usage_rules": [
      {
        "logo_id": "primary_horizontal",
        "logo_variant": "primary",
        "slots": ["logo_card_light", "marketplace_listing"],
        "minimum_size": { "height": "18px" },
        "clear_space": "1x cap height",
        "forbidden_contexts": ["photography_without_knockout", "yellow_background"],
        "severity": "must"
      }
    ],
    "mark_lockups": [
      {
        "lockup_type": "co_brand",
        "ordering": "brand_first",
        "separator": { "type": "keyline", "color": { "kind": "name", "name": "text" }, "width": "1px" },
        "min_gap": "1x clear space",
        "partner_max_optical_weight_ratio": 1,
        "description": "Separate partner marks with a keyline and keep partner marks optically no larger than the brand mark."
      }
    ]
  }
}
```

### `color_constraints[]`

Use for rules that filter color selection:

```jsonc
{
  "color": { "kind": "name", "name": "market_yellow" },
  "applies_to": ["accent"],
  "allowed_on": [{ "kind": "surface", "surface": "accent" }],
  "forbidden_on": [{ "kind": "surface", "surface": "background" }, { "kind": "surface", "surface": "text" }],
  "never_pair_with": [{ "kind": "name", "name": "lettuce_green" }],
  "contexts": ["digital", "print", "ctv_end_card"],
  "severity": "must",
  "description": "Market yellow is accent only."
}
```

`color` and list entries use a `color_ref` shape:

- `{ "kind": "name", "name": "primary" }` references a key in `colors`.
- `{ "kind": "value", "value": "#FFD449" }` references a literal color.
- `{ "kind": "surface", "surface": "background" }` references a usage surface rather than a palette value.

### `logo_usage_rules[]`

Use for constraints that agents can check when selecting or placing a logo:

```jsonc
{
  "logo_variant": "primary",
  "logo_id": "primary_horizontal",
  "logo_url": "https://assets.example/logos/primary.svg",
  "slots": ["logo_card_light", "nav_header", "marketplace_listing"],
  "contexts": ["display", "ctv_end_card"],
  "minimum_size": { "height": "18px" },
  "clear_space": "1x cap height",
  "allowed_backgrounds": [{ "kind": "name", "name": "white" }, { "kind": "name", "name": "linen" }],
  "forbidden_backgrounds": [{ "kind": "name", "name": "market_yellow" }],
  "forbidden_contexts": ["photography_without_knockout"],
  "severity": "must"
}
```

This does not deprecate `logos[].usage`; it makes the enforceable subset queryable.

When multiple logo usage rules match, consumers should apply the most specific binding first:

1. `logo_id`
2. `logo_url`
3. `slots`
4. `logo_variant`
5. `logo_tags`

If multiple rules at the same specificity conflict, treat `severity: "must"` as blocking and surface the conflict for approval rather than choosing silently.

### Bridge to `asset_group_id: "logo"`

Keep the two concepts separate, but connect them explicitly:

- `asset_group_id: "logo"` says the creative manifest has a logo asset group.
- `logo_slots[]` on that format slot says which brand logo slots are acceptable for the surface.
- `required_logo_slots[]` on that format slot says which logo slots need explicit coverage before a builder should consider the slot complete.
- `logos[].slots[]` says which renderer-facing slots each brand logo variant supports.

For example, `responsive_creative` can keep a single canonical `logo` asset group while declaring:

```jsonc
{
  "asset_group_id": "logo",
  "asset_type": "image",
  "required": true,
  "min": 1,
  "max": 5,
  "logo_slots": ["logo_card_light", "logo_card_dark", "marketplace_listing", "ad_end_card"],
  "required_logo_slots": ["logo_card_light", "logo_card_dark"]
}
```

Downstream selection algorithm:

1. Read the format slot with `asset_group_id: "logo"`.
2. Resolve slot hints from the product wire shape: `format_options[].params.slots[].logo_slots[]` on products, or `adagents.json` `formats[].params.slots[].logo_slots[]` in publisher catalogs.
3. Filter `brand.json` `logos[]` to assets whose `slots[]` intersects the declared `logo_slots[]`.
4. Check `required_logo_slots[]`. If a required slot has no matching logo, surface a validation warning or approval mapping; do not guess from `usage` prose.
5. Apply `visual_guidelines.logo_usage_rules[]` for the chosen slot, including minimum size, clear space, allowed backgrounds, and forbidden contexts.
6. If no `logo_slots[]` hint exists, fall back to `background`, `orientation`, and `variant`, then to `usage` prose only for human review or soft warnings.

The enum lives at `/schemas/enums/logo-slot.json`, so implementers do not have to guess at slot strings.

### `logos[].slots[]`

Use `slots[]` for the renderer-facing answer to "which logo should I use here?" This is distinct from creative-format asset slots (`asset_group_id: "logo"`), which say a manifest contains a logo asset. `logos[].slots[]` says which brand logo variant is appropriate for a particular UI or creative placement.

Initial canonical values, defined in `/schemas/enums/logo-slot.json`:

- `logo_card_light`
- `logo_card_dark`
- `profile_mark`
- `favicon`
- `app_icon`
- `social_profile_mark`
- `nav_header`
- `footer`
- `email_header`
- `watermark`
- `ad_end_card`
- `co_brand_lockup`
- `marketplace_listing`

Consumers should not guess from `tags[]` when a slot is declared. The fallback order is:

1. Match `logos[].slots[]` to the requested slot.
2. Apply `logo_usage_rules[]` for that slot.
3. Fall back to `background`, `orientation`, and `variant`.
4. Fall back to `usage` prose only for human review or soft warnings.

### `mark_lockups[]`

Use for co-brand, partner, sponsor, program, or secondary-mark lockups:

```jsonc
{
  "lockup_type": "co_brand",
  "ordering": "brand_first",
  "contexts": ["partner_campaign", "sponsored_content"],
  "separator": {
    "type": "keyline",
    "color": { "kind": "name", "name": "text" },
    "width": "1px"
  },
  "min_gap": "1x clear space",
  "brand_min_optical_weight_ratio": 1,
  "partner_max_optical_weight_ratio": 1,
  "description": "Brand mark appears first; partner marks must not exceed the brand mark's optical weight."
}
```

This is intentionally about layout constraints, not legal approval. Rights and authorization still belong in the brand protocol rights tasks and brand/operator authorization model.

## Why optional additive fields

These fields are not needed by every brand. A small brand can keep publishing `colors`, `logos`, and `restrictions[]`. A mature brand system with detailed guideline PDFs can add the structured fields incrementally. Existing consumers that ignore them remain valid.

Because `visual_guidelines` already allows extension properties, adding named fields is non-breaking. Naming them in the schema gives SDKs and agent builders a stable place to look.

## Fixture evidence

The fictional fixtures in `static/examples/brand-json/` exercise both the current schema and the proposed fields:

- `riverton-kitchen-guidelines.json`: QSR-style palette, logo, photography, and accent-only color constraints.
- `kiran-learning-trust-guidelines.json`: foundation-style photography, mark rules, and co-brand lockup constraints.

Both validate against `static/schemas/source/brand.json` and are covered by `npm run test:examples`.

## Brand-book ingestion workflow

The same fields support an automated "brand guide PDF to draft `brand.json`" workflow, but the extraction pipeline needs two distinct asset sources. A model that reads the PDF can identify logo intent and usage rules, but it should not be treated as the source of original asset bytes.

Recommended ingestion pipeline:

1. Extract PDF text by page for names, colors, typography, tone, restrictions, and page-level evidence.
2. Extract embedded image objects with deterministic IDs such as `pdf_image_0001`.
3. Render selected pages and crop candidate regions for vector/page-art assets that do not appear as embedded images. This is especially important for primary logos, marks, color swatches, and logo variant specimens.
4. Assign every candidate a stable local `asset_id`, source page, extraction method, crop box when applicable, dimensions, and file path.
5. Ask a multimodal model to classify candidates by `asset_id`, not to "extract images" directly. The model output should map candidate IDs to proposed `logos[]`, `assets[]`, color swatches, typography samples, photography examples, misuse examples, and `visual_guidelines` rules.
6. Validate every returned `asset_id` against the manifest. Treat model-reported counts and summary fields as advisory, not authoritative.
7. Save the result as a draft with source evidence and review status. Do not publish until durable HTTPS asset URLs, operator authority, and any rights/trademark evidence are present.

This produces two useful evidence layers:

- **Semantic evidence**: page references and extracted rules, such as "this is the primary wordmark for dark logo cards" or "this color is accent only."
- **Asset evidence**: concrete candidate files that reviewers can approve, replace, or reject before publishing.

Ingestion systems should store candidate metadata separately from published `brand.json` fields. A candidate crop can suggest:

```jsonc
{
  "asset_id": "candidate_logo_0007",
  "source_page": 15,
  "extraction_method": "rendered_page_crop",
  "crop_box": { "x": 303, "y": 202, "width": 522, "height": 240 },
  "proposed_logo": {
    "id": "primary_wordmark_dark_card",
    "variant": "wordmark",
    "background": "dark-bg",
    "slots": ["logo_card_dark", "marketplace_listing"]
  },
  "review_status": "needs_review"
}
```

Only after review and durable hosting should it become a `logos[]` entry with a real HTTPS `url`.

### Multimodal crop coordinates

When using a multimodal model to identify page regions, implementations should not assume returned boxes are native rendered-image pixels. Some models return normalized coordinates. Ingesters should record the coordinate space explicitly and verify crop results with a second vision or image-quality pass before presenting candidates as usable logo assets.

Minimum review checks for a logo candidate:

- The crop contains the intended mark, not a solid background, text label, or guideline annotation.
- The crop is centered and has acceptable clear space.
- The candidate is not a misuse example, mockup, duplicate, mask, or alpha fragment.
- The candidate's `slots[]` and `background` are consistent with the surrounding guide text.
- The candidate has or can be replaced by a durable, authorized hosted asset URL.

## Open questions

1. Should lockups support multiple partner marks explicitly now, or start with aggregate partner constraints and add per-partner modeling later?
2. Should `severity` stay at `must` / `should`, or align to a broader policy-enforcement vocabulary in a later release?
