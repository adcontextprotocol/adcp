---
"adcontextprotocol": minor
---

Unify metric accountability into a single timestamped contract array
covering both standard and vendor-defined metrics. Reshapes
`package.committed_metrics` and `by_package.missing_metrics` from
string arrays to discriminated object arrays. Closes the audit gap
for vendor metrics (#3519), adds mid-flight contract amendments
(#3518), and supersedes the parallel-array design that shipped
hours ago in #3510.

**Why a unified shape.** AdCP had grown five different metric adjectives
(`available`, `required`, `committed`, `requested`, `missing`) across
two parallel surfaces (standard via the closed `available-metric.json`
enum; vendor via the structured `vendor_metric_extensions`). The contract
layer (committed/missing) is the right place to unify because:

1. Buyer's reconciliation code is simpler — one array walk, one shape
2. The contract is the "agreement reached" — it doesn't matter where
   the metric came from (closed enum vs vendor extension)
3. Audit is symmetric — `missing_metrics` covers everything that was
   committed but not delivered, regardless of metric scope
4. Mid-flight amendments fit naturally — every entry is timestamped, so
   day-1 commitments and mid-flight additions share one shape

The capability layer (`reporting_capabilities.available_metrics` and
`vendor_metrics`) stays separate — capabilities use the closed vocabulary
upstream, contracts use the unified shape because they need timestamps
and vendor scoping.

**Schemas added.**

- `enums/metric-scope.json`: discriminator enum `["standard", "vendor"]`.
  Tags entries in unified metric arrays so consumers can branch on a
  literal string instead of inferring from field presence. Matches the
  existing AdCP discriminator pattern (`refinement_applied`,
  `incomplete[].scope`).

**Schemas reshaped.**

- `core/package.json` `committed_metrics`: was `string[]` from
  `available-metric.json` enum + parallel `committed_vendor_metrics`
  array. Now a single `[{scope, metric_id, vendor?, committed_at}]`
  array covering both. Each entry carries an explicit `committed_at`
  timestamp, so the array also serves as the contract amendment ledger.
  Day-1 entries share `committed_at = create_media_buy.confirmed_at`;
  mid-flight additions appended via `update_media_buy` carry their own
  timestamps. Append-only — sellers MUST reject attempts to modify or
  remove existing entries with `validation_error` (suggested code:
  `IMMUTABLE_FIELD`). The standalone `committed_vendor_metrics` field
  is **deleted**; vendor entries now live in the unified array with
  `scope: "vendor"`.
- `media-buy/get-media-buy-delivery-response.json`
  `by_package[].missing_metrics`: was `string[]`. Now
  `[{scope, metric_id, vendor?}]`, symmetric with `committed_metrics`
  minus the timestamp (the audit channel doesn't need to carry the
  commitment time; it filters by it).
- `missing_metrics` reconciliation rule: filters `committed_metrics`
  to entries where `committed_at < reporting_period.end`, then flags
  any not populated in the report. A metric committed mid-flight is
  audited only from its commitment timestamp forward — matches the
  IAB Open Measurement §4.3 precedent for accountability boundaries
  when measurement starts mid-flight.

**Vendor metric accountability scope.** PR #3492 deliberately scoped
vendor metrics as advisory in v1 ("buyers verify out-of-band via
`measurable_impressions` coverage"). With this PR, the
advisory-vs-accountable distinction moves to the contract layer
rather than the metric scope: any metric (standard or vendor) that
appears in `committed_metrics` is accountable. Sellers who can't
credibly attest to a vendor metric SHOULD NOT stamp it; absence keeps
that metric advisory and reconciliation falls back to coverage plus
out-of-band verification.

**Closes/supersedes.**

- Closes #3518 (mid-flight amendments — every entry has its own
  `committed_at`, so amendments are just new entries; no separate
  `additional_committed_metrics` array needed)
- Closes #3519 (vendor-metric audit symmetry — vendor entries live in
  the unified `missing_metrics` array; no separate
  `missing_vendor_metrics` field needed)
- Supersedes the parallel-array design from #3510. The `string[]`
  shape introduced there merged hours before this PR and had zero GA
  adopters; the breaking change is taking advantage of the open window
  to land the cleaner final shape before adoption hardens.

**Wired in.**

- `core/package.json`: reshape `committed_metrics`, delete
  `committed_vendor_metrics`.
- `media-buy/get-media-buy-delivery-response.json`: reshape
  `missing_metrics` and update the description to declare the
  reconciliation rule (`committed_at < reporting_period.end`).
- `enums/metric-scope.json`: new shared discriminator.
- `docs/media-buy/task-reference/create_media_buy.mdx`: rewrite the
  "Reporting contract on confirmed packages" section with a worked
  example showing day-1 + mid-flight entries.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: update
  `missing_metrics` bullet with the discriminated-shape example.
- `docs/media-buy/media-buys/optimization-reporting.mdx`: update the
  Vendor-Defined Metrics section to reflect that the
  advisory-vs-accountable distinction now lives at the contract layer
  (any committed metric is accountable, regardless of scope).

**Backwards compatibility.** Both `committed_metrics` and
`missing_metrics` are optional. The fields landed in #3472 and #3510
hours before this PR with `string[]` shape; that shape is now
replaced with a discriminated object array. Adopters who jumped on
the `string[]` shape immediately need to update; this is judged
acceptable given the field's optional status, the absence of any GA
implementations, and the meaningful improvement in the final
conceptual model.

**WG review.** This PR involves a v1.x scope shift on vendor-metric
accountability and a breaking reshape of two newly-merged optional
fields. Worth WG visibility before merge.

Refs #3518, #3519. Builds on #3472, #3492, #3510.
