---
"adcontextprotocol": minor
---

Add typed asset requirements schemas for creative formats

Introduces explicit requirement schemas for every asset type with proper discriminated unions. In `format.json`, assets use `oneOf` with `asset_type` as the discriminator - each variant pairs a specific `asset_type` const with its typed requirements schema. This produces clean discriminated union types for code generation.

- **image-asset-requirements**: `min_width`, `max_width`, `min_height`, `max_height`, `formats`, `max_file_size_kb`, `animation_allowed`, etc.
- **video-asset-requirements**: dimensions, duration, `containers`, `codecs`, `max_bitrate_kbps`, etc.
- **audio-asset-requirements**: `min_duration_ms`, `max_duration_ms`, `formats`, `sample_rates`, `channels`, bitrate constraints
- **text-asset-requirements**: `min_length`, `max_length`, `min_lines`, `max_lines`, `character_pattern`, `prohibited_terms`
- **markdown-asset-requirements**: `max_length`
- **html-asset-requirements**: `sandbox` (none/iframe/safeframe/fencedframe), `external_resources_allowed`, `allowed_external_domains`, `max_file_size_kb`
- **css-asset-requirements**: `max_file_size_kb`
- **javascript-asset-requirements**: `module_type`, `external_resources_allowed`, `max_file_size_kb`
- **vast-asset-requirements**: `vast_version`
- **daast-asset-requirements**: `daast_version`
- **promoted-offerings-asset-requirements**: (extensible)
- **url-asset-requirements**: `protocols`, `allowed_domains`, `macro_support`, `role`
- **webhook-asset-requirements**: `methods`

This allows sales agents to declare execution environment constraints for HTML creatives (e.g., "must work in SafeFrame with no external JS") as part of the format definition.
