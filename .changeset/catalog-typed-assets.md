---
"adcontextprotocol": minor
---

Add typed catalog assets, field bindings, and feed field mappings.

**Typed assets on vertical catalog items**: `hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`, and `app` item schemas now support an `assets` array using `OfferingAssetGroup` structure. Enables buyers to provide typed image pools (`images_landscape`, `images_vertical`, `logo`, etc.) alongside existing scalar fields, so formats can declare which asset group to use for each platform-specific slot rather than relying on a single `image_url`.

**Field bindings on format catalog requirements**: `catalog_requirements` entries now support `field_bindings` — explicit mappings from format template slots (`asset_id`) to catalog item fields (dot-notation path) or typed asset pools (`asset_group_id`). Supports scalar field binding, asset pool binding, and repeatable group iteration over catalog items. Optional — agents can still infer without bindings.

**Feed field mappings on catalog**: The `Catalog` object now accepts `feed_field_mappings` for normalizing external feeds during `sync_catalogs` ingestion. Supports field renames, named transforms (`date`, `divide`, `boolean`, `split`) with per-transform parameters, static literal injection, and placement of image URLs into typed asset pools. Eliminates the need to preprocess every non-AdCP feed before syncing.
