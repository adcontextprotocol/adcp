---
"adcontextprotocol": patch
---

Clarify asset_id usage in creative manifests

Previously ambiguous: The relationship between `asset_id` in format definitions and the keys used in creative manifest `assets` objects was unclear.

Now explicit:
- Creative manifest keys MUST exactly match `asset_id` values from the format's `assets_required` array
- `asset_role` is optional/documentary—not used for manifest construction
- Added validation guidance: what creative agents should do with mismatched keys

Example: If a format defines `asset_id: "banner_image"`, your manifest must use:
```json
{
  "assets": {
    "banner_image": { ... }  // ← Must match asset_id
  }
}
```

Changes: Updated creative-manifest.json, format.json schemas and creative-manifests.md documentation.
