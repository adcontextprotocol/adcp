---
---

docs(compliance): document specialism naming triplet and unclaimed-specialism grading behavior

AdCP specialisms appear under three casings depending on context — kebab-case on the wire (`capabilities.specialisms[]`), snake_case as storyboard category IDs, and prose in storyboard titles. The mapping was already in the compliance-catalog naming-conventions table but the "unclaimed = no tracks" failure mode was not documented anywhere.

Added a `<Warning>` callout to the "How to claim" section of `docs/building/compliance-catalog.mdx` (immediately after the runner steps list) explaining that an agent wiring all required tools for a specialism but omitting the kebab-case ID from `capabilities.specialisms[]` will receive "No applicable tracks found" — a silent fail at the track level.

Updated the `specialisms` field description in `static/schemas/source/protocol/get-adcp-capabilities-response.json` to state that values MUST be kebab-case and that omitting an ID silently skips the specialism's tracks in the compliance runner. No wire-format or schema-structure changes.

Docs-only. No protocol spec bump.
