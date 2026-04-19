---
---

Add experimental status mechanism and codify extensibility policy.

- New page `docs/reference/experimental-status.mdx` defines what experimental means, graduation criteria (≥1 production implementer for ≥45 days OR ≥2 implementers, no open breaking-change issues for 30 days, deliberate graduation PR), 6-week breaking-change notice window, and client guidance.
- `versioning.mdx` carves experimental surfaces out of the 3.x stability guarantees and adds an Extensibility section distinguishing core fields, `ext.{namespace}` additions, and `additionalProperties` containers.
- `get_adcp_capabilities` response gains `experimental_features[]` — sellers implementing experimental surfaces MUST list them; buyers inspect before relying.
- Schemas may annotate surfaces with `x-status: experimental`. No schemas carry the annotation in this change; PR 2 applies it to Brand Rights Lifecycle, Campaign Governance, and TMP.
