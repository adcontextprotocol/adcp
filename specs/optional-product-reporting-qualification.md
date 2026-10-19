# Catalog delivery reporting qualification for #8254

Status: **held implementation draft**, not a completed fix. The source patch and
its patch changeset must not merge while the qualification failures below remain.
[#8254](https://github.com/adcontextprotocol/adcp/issues/8254) stays open. Brian's
2026-10-19 chat approved the catalog direction and separately authorized the
future-minor declarations track; it did not supply eligible GitHub approval,
WG ratification, a path-gate exception, or release authorization.

## Concrete partial implementation

- `media_buy_seller/advanced_delivery_reporting` now covers format breakdown.
- `media_buy_seller/time_based_delivery_reporting` independently covers the
  `time_based_views` metric. Absence of either companion cannot suppress the other.
- Both prepare one sandbox account, fully paginate validated wholesale discovery,
  and use discover-only product and scoped fixed-CPM pricing resolution. Parent
  eligibility includes usable pricing, so an earlier auction-only product cannot
  conceal a later usable product. No product or pricing fixture is seeded.
- A completed scan without a qualifying product is a `fixture_unsatisfied` coverage
  gap projected `not_applicable`, never a pass or proof of nonsupport. Seeded-only,
  brief-only, non-CPM, auction-only and non-guaranteed-incompatible catalog paths
  remain coverage limitations. Controller/wholesale/tool gates do not prove an
  optional reporting feature.
- Create/report calls retain a sandbox account snapshot independent of mutable
  controller response extraction. The public caller must configure the matching
  existing `options.brand`; absent configuration is a preserved qualification
  failure, not evidence against the seller.
- Format assertions retain schema, requested buy/package identities, exact
  cardinalities, metric narrowing, a possibly empty format array, required
  truncation and applied-sort metadata, and the requested limit. No particular
  format kind, nonempty observations, true truncation, time threshold or basis is
  manufactured. The bounded one-row request checks applied sort metadata; it does
  not establish multi-row sorting or correct selection from an unobserved larger
  population. Broader sort coverage must preserve the actual protocol semantics.
- Baseline narrowing remains independently graded by
  `metric_container_subsumption`; that source and its accounting/floors are unchanged.

## Merge-blocking qualification evidence

| Hold | Executable observation / required resolution |
| --- | --- |
| Selected commercial context | A native fixed-CPM product declares `min_spend_per_package: 5000`; the authored budget 1000 is correctly rejected. Current identity bindings expose no selected commercial snapshot. Derive a valid budget from that same selected pricing option; do not skip the failure or choose arbitrary illustrative amounts. |
| Conditional time accountability | A package explicitly commits `time_based_views`, the commitment predates the report period end, and its declared final measurement window is mature. Dropping both the values and `missing_metrics` currently passes the draft. Reconcile the actual product window, create commitment and report condition; unavailable/unmatured/uncommitted metrics must retain their legal omission behavior. |
| Public caller brand | SDK 15.9.5's request enrichment substitutes `test.example` unless public `options.brand` or `brand_manifest` is set. A seller may correctly reject this mismatch with the qualified sandbox account. Configured public tests pass; unconfigured callers preserve raw failure. Targeted hosted full/standalone callers can use existing `options.brand`. Public `comply()` has one run-level brand, and `routeStoryboard` cannot set per-storyboard brand options: heterogeneous authored identities need separate orchestration/qualification. A declared test kit alone is not `options.brand`; seller responses and untrusted caller context must not choose the sandbox identity. |
| Standalone bindings | Public `runStoryboardStep` does not prepare the fixture graph or restore its binding state. Hosted registry/Addie steps pass ordinary context; passing a product ID alone is not selected metadata/provenance. Full-run success does not qualify standalone. |
| Discovery disposition | Transport/protocol/schema/pagination failure stays a raw failed SDK step and never becomes `fixture_unsatisfied`; SDK 15.9.5 labels the synthetic step `comply_test_controller`, so existing hosted policy projects `setup_gap`. Preserve both pieces of evidence and resolve any required accounting correction through its owner; this patch does not silently change disposition. |

The collection prerequisite proposal in #8259 separately specifies a bounded
matcher, same-selection snapshots/witnesses, namespace-aware set equality and
full/standalone state parity. None of those APIs is implemented here. New
seller-wide declarations remain isolated future-minor work in
[#8333](https://github.com/adcontextprotocol/adcp/pull/8333).

## Reproduction and baseline delta

```bash
node --test --test-timeout=30000 tests/optional-product-reporting.test.cjs tests/optional-product-reporting-public.test.cjs
```

**44 tests pass** on the unchanged SDK 15.9.5 dependency. They execute the actual
revised source and the actual hosted `classifyComplianceStep`, covering no-match,
independent later-page support, advertised-but-broken paths, discovery/pagination
failure, legal reporting variations, mandatory fields and metric narrowing.
The public test file uses the real MCP transport through public
`transport.trustedFetchFn`, including sandbox isolation and adversarial controller
responses. Counterexample tests intentionally reproduce the held behavior:
their success proves reproducibility, not merge readiness.

A controlled comparison loaded the actual original storyboard at main
`c2f01a50f2133b016fc73ca74019c4c021f2256e` and the revised source through public
`loadStoryboardFile` and `runStoryboard`, using the same native catalog and
hosted classifier. Historical product/pricing seeds were accepted without
inventing native support; new sandbox/no-bid test oracles were not retroactively
applied to old source. Counts below are raw passed/failed/skipped SDK steps;
synthetic preparation passes are not seller conformance passes.

| Native catalog | Original combined scope | Draft format | Draft time |
| --- | --- | --- | --- |
| Neither feature | 3 / 1 / 3 | 1 / 0 / 1, coverage gap | 1 / 0 / 1, coverage gap |
| Format only | 3 / 1 / 3 | 6 / 0 / 0 | 1 / 0 / 1, coverage gap |
| Time only | 3 / 1 / 3 | 1 / 0 / 1, coverage gap | 6 / 0 / 0 |
| Both; legal three-second in-view, image rows, no truncation | 6 / 1 / 0 | 6 / 0 / 0 | 6 / 0 / 0 |

For each successfully exercised draft scope, hosted disposition is five passed
steps and one not-applicable preparation step. Each no-match scope yields one
not-applicable row and an explicit coverage gap. The original combined discovery
failure projects one failed and three dependency-failed rows (plus one passed
and two preparation not-applicable); with both features its old hardcoded
threshold/basis/truncation/format-kind assertions reject otherwise legal data.
These controlled deltas do not claim a green training-agent matrix, qualification
for every commercial offer, or 3.2.x compatibility. No required-phase, step or
clean-storyboard floors have changed.

Independent protocol/product/code/security reviews support this draft for human
review only; agent notes do not satisfy eligible GitHub or path approvals.
Authoritative exact-head CI and all qualification holds must be satisfied before
ordinary merge. Draft CI may skip the authoritative storyboard matrix; a skipped
matrix must never be described as green execution.

## Release and maintenance boundary

Main first; only after a qualified main merge prepare a separate reviewed 3.2.x
backport against its actual pinned SDK and schemas. At the audited maintenance
head the dependency is **14.0.0-rc.53**, distinct from main's 15.9.5. The 44/19
main-pin probes are not maintenance qualification and no pin may be upgraded
to make a backport pass. No SDK/dependency/lockfile
upgrade, declaration field, controller refusal contract, production write,
publication or immutable artifact modification is part of this draft.

Read-only audit on 2026-10-19: 3.2.x was
`71d877e69cf112128053cb38441e4a46f2f0fa40`; open draft Version Packages
[#8274](https://github.com/adcontextprotocol/adcp/pull/8274) targeted 3.2.x at
`e4c6b30c4f6ed16589efc61d29becbe825a5c1fb`, preparing 3.2.6. A source/patch-changeset
merge is release-relevant under `.github/workflows/release.yml`; its Changesets
step runs `npm run version` and refreshes `changeset-release/3.2.x` as a draft,
including generated candidate compliance/schema/protocol artifacts. That concrete
side effect needs the user's separate maintenance merge disposition. The earlier
#8302-only draft-refresh authorization does not extend to #8254. No maintenance
merge or Version Packages mutation has been performed.
