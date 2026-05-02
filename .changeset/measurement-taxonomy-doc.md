---
---

Add `docs/measurement/taxonomy.mdx` — the three-layer measurement model (metrics, verification, attribution) used to frame protocol-design debates.

The verification layer documents AdCP's existing surface end-to-end: discovery via `required_performance_standards` and `vendor_metrics`, commitment via `performance-standard.json` with vendor BrandRef and the tracker-asset MUST, execution via creative-manifest trackers, and reporting via graduated standard scalars (e.g., `delivery-metrics.viewability`) plus `vendor_metric_values` for non-graduated vendor metrics. Measurement agents are first-class identities discoverable via `brand.json` `agents[type='measurement']` (the BrandRef anchor), with the metric catalog served by the agent's `get_adcp_capabilities` response under the `measurement` block.

Two doctrinal additions surfaced through a corpus-wide schema audit and a working session on PR #3576 / issue #3848:

- **Graduated verification metrics** — names a maturity gradient (Tier 1 graduated with closed enum entry + dedicated delivery scalar + qualifier slot; Tier 2 vendor-extended via `vendor_metrics`/`vendor_metric_values`; Tier 3 asserted free-form). Viewability is the canonical Tier 1 metric today; the patterns that support it (qualifier slot, dedicated delivery scalar, performance-standard binding) are reusable templates for future graduations.
- **The atomic unit `(metric_id, qualifier)`** — names the row-level symmetry across `committed_metrics` / `missing_metrics` (#3576) and `metric_aggregates` (#3848). Reconciliation collapses to a join on `(metric_id, qualifier)`. Contract qualifier is closed; delivery qualifier is a deliberate superset for path-level transparency disclosures.

Also flags the attribution-derived hybrid in `available-metric.json` (ROAS, CPA, conversions, conversion_value, units_sold) — seller-reported values whose underlying event of truth is buyer-attested, surfaced through delivery for ecosystem compatibility but read as "attribution surfaced through delivery" rather than pure metrics.

Includes a worked end-to-end example (third-party DV viewability commitment with SSAI in scope), source-of-truth rule of thumb, four layer-mismatch examples (SSAI, identity loss, AI-content provenance, outcome optimization), a Boundaries section against Signals and Governance, and two narrowed open questions on whether measurement deserves a peer protocol surface and where pre-bid measurement signals belong. Linked from Reference nav alongside `media-channel-taxonomy`. Origin: [#3759 comment](https://github.com/adcontextprotocol/adcp/issues/3759#issuecomment-4361203386).
