---
---

Add `docs/measurement/taxonomy.mdx` — the three-layer measurement model (metrics, verification, attribution) used to frame protocol-design debates.

The verification layer documents AdCP's existing surface end-to-end: discovery via `required_performance_standards` and `vendor_metrics`, commitment via `performance-standard.json` with vendor BrandRef and the tracker-asset MUST, execution via creative-manifest trackers, and reporting via `vendor_metric_values` and `missing_metrics`. Measurement agents are noted as first-class identities via `brand.json` `agents[type='measurement']`.

Includes a worked end-to-end example (third-party DV viewability commitment with SSAI in scope), source-of-truth rule of thumb, four layer-mismatch examples (SSAI, identity loss, AI-content provenance, outcome optimization), a Boundaries section against Signals and Governance, and two narrowed open questions: whether measurement deserves a peer protocol surface and where pre-bid measurement signals belong. Linked from Reference nav alongside `media-channel-taxonomy`. Origin: [#3759 comment](https://github.com/adcontextprotocol/adcp/issues/3759#issuecomment-4361203386).
