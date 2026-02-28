---
"adcontextprotocol": minor
---

Add compliance fields to creative-brief schema. Unify manifest to format_id + assets.

Add optional `compliance` object to `creative-brief.json` with `required_disclosures` (structured array with text, position, regions, regulation, min_duration_ms, and language) and `prohibited_claims` (string array). Disclosures support per-region requirements via ISO 3166-1/3166-2 codes (country or subdivision). Extract disclosure position to shared `disclosure-position.json` enum with values: prominent, footer, audio, subtitle, overlay, end_card, pre_roll, companion. Creative agents that cannot satisfy a required disclosure MUST fail the request.

Move `creative_brief` and `catalogs` from top-level manifest fields to proper asset types (`brief` and `catalog`) within the `assets` map. Add `"brief"` and `"catalog"` to the asset-content-type enum. Create `brief-asset.json` and `catalog-asset.json` schemas. Move format-level `catalog_requirements` into the catalog asset's `requirements` field within the format's `assets` array. Add `max_items` to `catalog-requirements.json`. The manifest is now `format_id` + `assets`.

Add `supported_disclosure_positions` to `format.json` so formats declare which disclosure positions they can render.

Remove `creative_brief` from `build-creative-request.json` and delete `creative-brief-ref.json`. Remove `supports_brief` capability flag.

Note: `creative_brief` on manifests, `catalog_requirements` on formats, `creative-brief-ref.json`, and `supports_brief` were added during this beta cycle and never released, so these structural changes are not breaking.
