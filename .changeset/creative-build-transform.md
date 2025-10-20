---
"adcontextprotocol": minor
---

Align build_creative with transformation model and consistent naming

**Breaking changes:**
- `build_creative` now uses `creative_manifest` instead of `source_manifest` parameter
- `build_creative` request no longer accepts `promoted_offerings` as a task parameter (must be in manifest assets)
- `preview_creative` request no longer accepts `promoted_offerings` as a task parameter (must be in manifest assets)
- `build_creative` response simplified to return just `creative_manifest` (removed complex nested structure)

**Improvements:**
- Clear transformation model: manifest-in → manifest-out
- Format definitions drive requirements (e.g., promoted_offerings is a format asset requirement)
- Consistent naming across build_creative and preview_creative
- Self-contained manifests that flow through build → preview → sync
- Eliminated redundancy and ambiguity about where to provide inputs

This change makes the creative generation workflow much clearer and more consistent. Generative formats that require `promoted_offerings` should specify it as a required asset in their format definition, and it should be included in the `creative_manifest.assets` object.
