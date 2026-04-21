---
---

Compliance storyboards: fix spec-shape bugs surfaced while porting the
training agent onto @adcp/client 5.4.

Seven storyboards had request shapes that failed strict Zod validation
against the spec-generated schemas. None were being caught at build time
because our schema validator doesn't cross-check sample_request payloads
against the generated Zod — they'd fail only when an agent runs the
storyboard.

**Fixes:**

- `sync_creatives` `creatives[]` used a legacy `content: { media_url: "…" }`
  shape instead of the spec's `assets: { <asset_id>: <typed-asset> }` keyed
  pattern-property structure (`core/creative-asset.json`). Affected:
  - `protocols/media-buy/scenarios/pending_creatives_to_start.yaml`
  - `protocols/media-buy/creative-reception.yaml` (the `creative_sales_agent`
    storyboard, which also lacked the schema-required `creatives[].name`
    field)

- Text assets used `text: "…"` instead of the spec's `content: "…"` required
  field on `core/assets/text-asset.json`. Fixed 8 occurrences across:
  - `specialisms/creative-template/index.yaml` (3 sites)
  - `specialisms/creative-generative/index.yaml` (5 sites)

- Image assets omitted `width`/`height`, both required by
  `core/assets/image-asset.json`. Inferred from URL suffixes where the
  file name encoded dimensions (`…-300x250.jpg`), otherwise used common
  creative sizes (1200×628 for hero/native). Fixed 9 occurrences across:
  - `specialisms/creative-template/index.yaml` (3 sites)
  - `specialisms/creative-generative/index.yaml` (3 sites)
  - `specialisms/sales-social/index.yaml` (1 site)
  - `protocols/creative/index.yaml` (2 sites)
  - `protocols/media-buy/creative-reception.yaml` (1 site, combined with
    the name fix above)

- `create_media_buy` `packages[].catalogs[]` used `catalog_type: "product"`
  instead of the spec's `type` field (`core/catalog.json`). Fixed 2
  occurrences in:
  - `specialisms/sales-catalog-driven/index.yaml`

**Not addressed here:**

- `measurement_terms_rejected.yaml`'s `makegood_policy.available_remedies` —
  the storyboard YAML is correct (sends `["credit"]`). The SDK-level Zod
  rejection observed during the training-agent storyboard run traces to the
  SDK's request-builder path, not the storyboard shape. Filed as a
  separate investigation.

**Follow-up recommendation:**

Add a build-time check that parses every `sample_request:` in every
storyboard through its declared `schema_ref`'s generated Zod. This
category of bug (storyboard shape drifting from spec) is worth catching
once at CI time rather than seven times across downstream agent runs.
