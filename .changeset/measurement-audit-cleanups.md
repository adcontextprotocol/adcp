---
"adcontextprotocol": minor
---

Three small cleanups from the measurement schema audit (closes audit findings §3.8 and §3.10; finishes the prose-side work for #3863).

**§3.8 — `attribution-window` dedup.** `optimization-goal.json` previously inlined a partial `attribution_window` shape with `post_click` and `post_view` but no `model`, with `post_click` required. The canonical `core/attribution-window.json` has `post_click`, `post_view`, and `model` with `model` required. Two surfaces describing the same concept with conflicting constraints. Fix:

- `optimization-goal.json` `attribution_window` collapses to `$ref attribution-window.json` so there's one canonical shape.
- `attribution-window.json` `model` becomes optional (was required). Absence means the seller's default attribution model applies (typically `last_touch` per industry convention). Sellers SHOULD populate `model` when committing to a specific methodology. Buyers reading delivery reports get the seller's choice when set; fall back to default when not.

**§3.10 — `dooh_metrics.calculation_notes` description tightening.** Previously a one-liner ("Explanation of how DOOH impressions were calculated") that read like a primary methodology surface. Tightened to clarify it's for **row-specific supplementary context** (a particular daypart's calculation, a venue-mix exception) — the canonical methodology declaration belongs on the measurement vendor's `get_adcp_capabilities.measurement.metrics[]` block where it's discoverable once and inherited across delivery rows. Doesn't deprecate the field — DOOH methodology genuinely has row-level exceptions worth carrying inline.

**#3863 — `forecastable-metric.json` description drift fix.** The description previously claimed `audience_size`, `measured_impressions`, `grps`, `reach`, `frequency` were forecast-only deltas. **Wrong:** `grps`, `reach`, `frequency` are also in `available-metric.json` (have been since their introduction). The actual forecast-only deltas are `audience_size` and `measured_impressions`. Description corrected. Closes the prose-cross-reference half of #3863; the schema-level enforcement of overlap (build-script work, not schema work) is deferred.

**Backwards compatibility.** All three changes are additive or relax existing constraints (the `attribution-window.model` requirement relaxation makes previously-failing payloads valid; previously-valid payloads remain valid). No breaking changes.

Closes audit findings §3.8 and §3.10. Substantially closes #3863 (prose cross-references); build-script overlap enforcement deferred to a follow-up.
