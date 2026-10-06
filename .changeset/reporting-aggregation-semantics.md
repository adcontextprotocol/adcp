---
"adcontextprotocol": minor
---

Add optional `aggregation_semantics` to reporting report-definition metrics (new `contract_version` 1.2), keeping the legacy `aggregation` string required. Defines `additive` (report-period only), `recomputable_ratio` (numerator, denominator, `zero_denominator` of `null`, `zero`, or `omitted`, optional multiplier), `non_additive_unique` (unit and pinned `deduplication_identity`), and `opaque` kinds with explicit comparability fields, treats legacy strings without semantics as unsafe for generic aggregation, and adds six executable aggregation-semantics vectors under `test-vectors/reporting-reconciliation/`. Semi-additive, modelled, and last-value kinds are deferred.
