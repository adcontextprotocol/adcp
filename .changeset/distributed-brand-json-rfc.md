---
---

Draft RFC for distributed brand.json — propose evolving from monolithic house portfolio (one big document containing inline child brand definitions) to a collection of canonical per-brand documents linked by mutual-assertion pointers.

The RFC lives at `docs/brand-protocol/proposals/distributed-brand-json-rfc.mdx` (linked from the brand protocol nav under "Proposals"). Tracking discussion is in [#3409](https://github.com/adcontextprotocol/adcp/issues/3409). Not yet normative — needs spec-owner sign-off before any code or schema changes land.

Key proposed changes (subject to discussion):
- Each brand publishes one canonical brand.json owning its own attributes
- New `house` pointer field for declaring an immediate parent (multi-level chains via recursion)
- New `brand_refs[]` field replacing inline `brands[]` content (pointer-only `{id, domain}`)
- New `house_attributes` block for inheritable house-wide metadata (privacy, compliance, corporate entity)
- Mutual-assertion as the canonical trust primitive — child's `house` must be reciprocated by parent's `brand_refs[]`
- Hosting (static, CDN, brand-agent, AAO-hosted, self-hosted) is independent of the data model and stays an implementation choice

Migration path defined: 3.x accepts both shapes with deprecation warnings; brand-protocol 2.0 (decoupled from AdCP major) cuts over.
