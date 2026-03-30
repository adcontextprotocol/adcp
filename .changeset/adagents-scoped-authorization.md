---
"adcontextprotocol": minor
---

Expand `adagents.json` to support richer publisher authorization and placement governance.

This adds scoped authorization fields for property-side `authorized_agents`, including:

- `delegation_type`
- `collections`
- `placement_ids`
- `placement_tags`
- `countries`
- `effective_from`
- `effective_until`
- `exclusive`
- `signing_keys`

It also adds publisher-level placement governance with:

- top-level `placements`
- top-level `placement_tags`
- canonical `placement-definition.json`

Validation and tooling are updated to enforce placement-to-property linkage, placement tag scoping, country and time-window constraints, and authoritative-location resolution. Related docs are updated to explain the stronger publisher authorization model and compare `adagents.json` with `ads.txt`.
