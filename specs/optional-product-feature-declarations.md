---
title: Seller-wide optional product-feature commitments
class: normative
status: proposed
date: 2026-10-23
refs: ["#8254", "PR #8428", "PR #8336", "PR #8259", "PR #8376", "DR-0001", "DR-0009", "DR-0010"]
dissent: Human/WG decision outstanding; agent review is not ratification
---

## Decision

**Nonoperative future-minor proposal.** No capability/controller wire,
implementation assignment, release train or WG decision is adopted here.
The memo, schemas, examples and executable model are isolated proposal evidence.
A DR number and decision provenance require human review. Kickoff authorization,
source scenario IDs and merges of related work do not ratify this proposal.

Recommend **eight** optional booleans under `media_buy.features`, with no defaults:

| Proposed field | Qualifying native sandbox offer | Independent core consumer |
| --- | --- | --- |
| `supports_collection_selection` | Selectable; at least two distinct domain-qualified pairs | `collection_selection`: strict subset and undeclared-selector rejection |
| `supports_collection_default_materialization` | Any collection mode; at least one pair | `collection_default_materialization`: concrete full-bundle default |
| `supports_fixed_bundle_enforcement` | Omitted/false selection flag; at least two pairs | `fixed_bundle_enforcement`: full set accepted, strict subset rejected |
| `supports_fixed_bundle_restatement` | Omitted/false selection flag; at least one pair | `fixed_bundle_restatement`: exact full-set restatement |
| `supports_cross_publisher_collection_restatement` | Any collection mode; at least one cross-publisher pair | `owner_sold_channel_carriage`: full set and selector boundaries |
| `supports_cross_publisher_collection_subset` | Selectable; at least two TOTAL pairs, including a cross-publisher pair | `owner_sold_channel_subset`: strict subset retains the external pair |
| `supports_format_breakdown` | Product `reporting_capabilities.supports_format_breakdown: true` | `advanced_delivery_reporting`: requested format breakdown |
| `supports_time_based_views` | Product metrics include `time_based_views` | `time_based_delivery_reporting`: metric accountability/narrowing |

Consumer IDs above have the `media_buy_seller/` prefix. They identify independently
qualified behavior; their existence does not adopt these declaration fields.

The earlier six-field draft grouped fixed restatement with enforcement and
ordinary declared carriage with selectable carriage subset. Those need different
fixture promises. A fixed one-pair supporter cannot provide a genuine strict
subset; a fixed or one-pair cross-publisher supporter cannot prove selectable
cross-publisher subset behavior. One smaller prepared offer must not certify the
larger path, and a missing larger fixture must not suppress smaller-path coverage.
This revision replaces the **unpublished provisional**
`supports_fixed_collection_bundles` with separate enforcement/restatement fields
and adds the subset commitment. Cross-publisher field names describe structural
restatement/subset behavior instead of the earlier provisional owner/channel
wording; the historical source IDs stay unchanged. This renames no published
field and needs no alias.
The eight-field choice is an exact recommendation for WG review, not adopted policy.

All promises are existential, never claims that every product supports a feature.
False means no seller-wide promise, not product nonsupport. A product's own
obligations remain binding even when another rollup is absent/false. Thus a
selectable offer still owes default/readback behavior, an enforcement offer owes
full-set acceptance, and a cross-publisher subset offer still owes selector boundaries.
Independent booleans do not grant permission to violate related product MUSTs.

The two optional readers, `collection_selection_readback` and
`collection_default_materialization_readback`, inherit the matching fixture scope
but have their own root `get_media_buys` gate. They need no new declaration.
A missing reader leaves core create coverage intact; an advertised broken reader
fails. A read requires trusted successful create history and exact buy/package/
product/committed-selector identity. Failed-step context is not proof of success.
No new compulsory reader, portable grant, cross-request trust or retired-catalog
state guarantee is implied.

These direct collection paths do not imply hosted collection lists, collection
cards, placement selection, property reporting, delivery modes or authorization.
Format/time promises are independent; baseline requested-metric narrowing stays
independently graded. In `get_products.filters.required_features`, the shared
feature fields select **sellers**, never qualifying products or fixture mutation.

## Rationale and authority

Catalog-only applicability cannot certify seeded-only/brief-only supporters
whose initial wholesale catalogs have no qualifying product. A generic
`seed_product` echo does not establish native support. The proposal adds an
explicit native-support and controlled-fixture promise, rather than turning seed
refusal into an unsupported-feature negotiation mechanism.

- [DR-0001](../governance/decisions/DR-0001-conformance-assertions-normative-basis.md): grade only schema/normative obligations; this proposal is not operative authority.
- [DR-0009](../governance/decisions/DR-0009-additional-properties-default-true.md): preserve existing object boundaries. `media-buy-features.json` permits unknown **boolean** keys, not arbitrary unknown objects.
- [DR-0010](../governance/decisions/DR-0010-fixture-handles-and-resolution.md): pin seller-issued identities and whole graphs; supported discovery/setup failures are terminal; exhausted unavailable strategies leave visible coverage gaps.
- [Product](../static/schemas/source/core/product.json), [collection selection](../static/schemas/source/core/collection-selection.json), [targeting](../static/schemas/source/core/targeting.json) and [reporting capabilities](../static/schemas/source/core/reporting-capabilities.json) remain product authority.
- [Delivery request](../static/schemas/source/media-buy/get-media-buy-delivery-request.json), [metrics](../static/schemas/source/core/delivery-metrics.json) and [controller](../docs/building/by-layer/L3/comply-test-controller.mdx) bound what fixtures/reporting can prove.

### Current source and release reconciliation

The current collection implementation record is [#8428 at
`10e88cd4c68df8a9db3bc1ba6c79ceb61e52a8bd`](https://github.com/adcontextprotocol/adcp/blob/10e88cd4c68df8a9db3bc1ba6c79ceb61e52a8bd/specs/optional-product-collection-qualification.md),
based on reporting merge `3e94f5e376bae2911fe26373a8ff506908f1a765`.
It is non-draft with exact-head CI/reviews still to be assessed; this workspace
has read the memo, not rerun its actual-source or public SDK qualification.
Root owns the ordinary merge decision. The catalog owner retains all source,
grammar/output, caller, hosted, dependency/lock and checkpoint work.

[#8259](https://github.com/adcontextprotocol/adcp/pull/8259) is closed as superseded;
its original `ce8a65d6bd192c105ef3175091f29c7f296e47b9` remains historical.
The SDK [foundation #3354](https://github.com/adcontextprotocol/adcp-client/pull/3354)
merged as `37d308768b01b99f4650800d5af7cfc051b40e9e` and the protocol
[authoring/output contract #8376](https://github.com/adcontextprotocol/adcp/pull/8376)
merged as `277e0a53517976726bbc69d1485de57944a284d4`. Earlier capacity holds,
provisional names and unimplemented-foundation descriptions are not current
readiness claims. Neither merge implements seller declarations or the new native
fixture commitment proposed below. Historical reviews do not qualify later code.

The #8428 tree reports package `3.3.0-beta.0` and installed SDK **16.3.0**.
The original isolated proposal checkout/evidence baseline is main `c2f01a50f`
with SDK **15.9.5**; no dependency, lockfile or bridge is changed here. Probe names
print their actual installed SDK and verify the repository pin. Local results,
merge-check CI and upstream SDK probes must each retain their own version/head.
15.9.5 observations do not establish current 16.3 limitations. No SDK14/9 or
maintenance qualification is inferred. This feature's **future minor is
unassigned**; source package metadata is not a release decision.

Reporting [#8336](https://github.com/adcontextprotocol/adcp/pull/8336) merged at
`3e94f5e376bae2911fe26373a8ff506908f1a765`. Native zero-row
`fixture_unsatisfied` artifacts are coverage gaps, not positive support evidence.
Format/time independence and current reporting limits remain. The collection
memo replaces the old catalog proposal as source-consumer authority; #8254 stays
open until its owner's remaining work is resolved. No maintenance, VP or release
action follows from this proposal.

Adjacent [property rollups #7982](https://github.com/adcontextprotocol/adcp/pull/7982)
provide a sound placement/per-product-authority pattern. Do not inherit their
rollup-only absent/false N/A gating, which would hide catalog evidence, or apply
their property-specific injection/suppression rules to format/time.
[Delivery-mode #7973](https://github.com/adcontextprotocol/adcp/pull/7973) is a
separate proposal held to 3.4: avoid its missing-parent/schema-default and compound
fail-closed hazards, reduced specialism coverage and baseline substitution.
Other composable-breakdown, collection-list, installment and response-version
proposals must be rechecked with their owners before any later overlapping
source change; they are not authority for this draft's new semantics.

### Selected graph, namespace and public SDK boundaries

Use schema-valid atomic `(publisher_domain, collection_id)` pairs. Fixed accepts
only omitted or literal false flags; null/wrong types are schema failures.
Normalize legal grouping/order/redundancy as sets without erasing domains or
inventing nonempty-ID restrictions. Identical duplicate outer selected objects
still fail their schema. Every product collection entry requires explicit
`collection_ids`; authorization bulk grants are not product composition.
Product property selectors forbid `publisher_domains`, even alongside singular
`publisher_domain`. Do not fan out, skip malformed entries or salvage partial data.

A structural cross-publisher relation exists only when a collection domain lies
outside **all** singular property publisher domains of the same product. Traverse
all selectors. Two total pairs may be one local and one external pair; the strict
subset retains the external pair. Historical `owner_sold_channel_*` names imply
neither channel kind, beneficial ownership, AOR, rights nor host authorization.
Those checks remain external. The model no longer invents a channel-kind witness
or proves a relation by comparing against just one property domain.

SDK16.3's merged vocabulary uses the single direct `path: ''`
`collection_selection_satisfies` operand with `collection_targeting`,
`minimum_pairs`, `require_cross_publisher_collection`; witness vocabulary includes
`declared_selectors`, `strict_subset`,
`undeclared_collection_id_selectors`, `undeclared_publisher_domain_selectors`,
`cross_publisher_relation`, `distinct_pairs`, and `snapshot: selected_entity`.
The raw same-selected graph stays protected. Normalize full wire arrays outside
that raw capture, retain same-product/relation-qualified negative arrays, and
capture the SAME scoped pricing entity. A missing optional minimum stays absent;
no blanket `min_spend: present` applicability filter is valid. The caller can use
its budget intent with `max(intent, min_spend_per_package ?? 0)`, without inventing
seller terms or currency.

The current catalog slice is native wholesale, non-guaranteed fixed-price CPM.
It does not qualify guaranteed/auction/brief-only/seeded-only offerings. Future
commitments must name a valid seller-supported commercial path; they do not
universally require that catalog slice. A valid offer outside a harness's
commercial/approval profile is an honest harness/precondition gap, not proof of
producer nonsupport or a setup-refusal excuse after agreed prerequisites hold.

The #8428 memo retains durable repaired-behavior probes for SDK issues
[#3395](https://github.com/adcontextprotocol/adcp-client/issues/3395),
[#3396](https://github.com/adcontextprotocol/adcp-client/issues/3396) and
[#3397](https://github.com/adcontextprotocol/adcp-client/issues/3397): optional
resource-lifecycle false failure, missing authored context-key evidence, and
buyer feed restart. Their assertions fail naturally on the reported SDK16.3
version. This workspace has not executed them; a failing repaired-behavior probe
is not a passing conformance regression. #3389 host-authorizer refusal, bare
standalone gate/phase behavior, #3382 caller projection/branding and #8416 hosted
coverage presentation remain separately bounded work. No new SDK assignment or
adoption is made here.

## Proposed normative language

These clauses become normative only after adoption in an assigned minor.

1. Sellers MAY emit any subset of the eight booleans. Absent fields or parents
   mean **no seller-wide claim / unknown**, not unsupported. False declines a
   seller-wide commitment without denying product support. True is explicit
   producer opt-in to the feature and fixture promise after adoption, regardless
   of self-reported implementation minor. Unknown boolean keys are ignored as
   unknown features. Known non-booleans fail validation, never coercing to false.
2. Every true feature MUST be backed by at least one qualifying bookable offer
   in the normal native sandbox execution path, and MUST support the proposed
   `prepare_product_feature` operation for that scope. Initially empty and
   brief-only catalogs are allowed. A fixture-only feature echo does not satisfy
   native support. Historical extension collisions must be removed or adopted;
   old schema acceptance alone is not semantic certification.
3. Product declarations remain authoritative on every selected product,
   independent of rollups. A supporting product with absent/false rollup is not
   a contradiction; nor is an ordinary product beside a true rollup. Failure to
   supply a promised qualified offer or violation of selected product behavior
   is a producer violation. It MUST NOT become unsupported/N/A or fallback success.
4. Runners MUST retain catalog testing for absent/false flags. A true flag with
   no catalog match selects the commitment route without a wholesale gate.
   Never equals-true-gate an entire existing product scenario or infer defaults
   through missing capability parents. Each fixture graph qualifies independently.
5. Setup commitment and product behavior MUST have separate evidence. Missing
   new runner capability cannot suppress existing catalog execution. Confirmed
   missing promised operations violate the promise; inability to inspect or
   dispatch is an honest harness gap. Even when catalog behavior passes, a
   commitment is untested until valid preparation and its normal lifecycle run.
6. No flag conveys authorization, eligibility, availability or entitlement.
   Establish a prearranged feature-eligible sandbox account and executable
   commercial profile using ordinary onboarding/operator evidence, without
   credentials or entitlement assertions in metadata. A documented unmet
   precondition is a gap. After prerequisites hold, valid advertised refusal is
   a commitment violation; a bare `INVALID_PARAMS` or post-failure assertion of
   ineligibility cannot cancel the promise. Harness-authored malformed input
   and unsupported execution profiles are not producer failures.

### Applicability and fixture state table

Evaluate every scope independently. Valid, complete wholesale no-match differs
from unavailable wholesale. A transport/protocol/schema/pagination/capture failure
after supported discovery starts is terminal under DR-0010, not a no-match.

| Declaration / condition | Action | Evidence |
| --- | --- | --- |
| Absent/false; qualifying catalog | Pin same graph and exercise product | Existing product obligations graded |
| Absent/false; valid complete no-match | No invented feature seed | `fixture_unsatisfied` coverage gap, no nonsupport proof |
| Absent/false; brief-only and no defined construction | Do not force wholesale | Discovery-precondition gap, unknown support |
| True; qualifying catalog | Run product and separate preparation probe | Catalog pass alone leaves preparation untested |
| True; empty/nonqualifying/brief-only | Prepare exact feature scope, then execute normal lifecycle | Independent feature/commitment evidence |
| True; advertised valid setup refusal, transport failure or confirmed missing operation | Preserve response/operation evidence | Producer commitment violation, no fallback/N/A |
| True; malformed/nonqualifying prepared offer | Stop before purchase | Producer violation with exact schema/qualification cause |
| Any selected offer; broken selected behavior | Retain failure | Behavior violation; no applicability reclassification |
| Any; missing harness/access/commercial profile/trusted read history | Stop affected operation, retain independent core tests | Honest precondition gap; no pass or producer accusation |
| Known declaration has null/string/array/object value | Fail known-field validation | Invalid producer declaration |
| Optional reader absent / advertised reader broken | Root-gate reader only / retain reader failure | Core coverage survives / behavior violation |

Model labels such as `commitment_violation`, `harness_gap`, `coverage_gap` and
`behavior_violation` are local proposal evidence, not new wire errors or shipping
runner-output kinds. Current hosted setup projection is not rewritten here.
Adoption needs an explicit declaration assertion retaining setup evidence rather
than silently relying on a setup-gap/N/A projection. Global guards/floors stay intact.

## Proposed controller and runner addition

The merged foundation can resolve catalog products and prices and protect
preparation. It still does not negotiate native feature support or supply an
initially absent, feature-qualified offer. Generic `seed_product` and
`list_scenarios` do not close this gap. No existing error code is repurposed.

Propose one additional sandbox scenario `prepare_product_feature`:

- Params: `feature` (one of the eight proposed field names without `supports_`)
  and `fixture_id` (nonempty run-unique key, at most 128 characters). No authored
  product, selectors, observations, credentials or endpoint overrides.
- Success retains the existing controller envelope:
  `success: true, simulated: {feature, fixture_id, product}`. Product MUST be a
  complete valid product with seller-issued identities and usable scoped price,
  native support and sufficient agreed test inventory. It may be brief-only.
  Normal purchase/readback must use its actual selectors/commercial terms.
- `fixture_id` is namespaced by authenticated principal and sandbox account;
  feature is immutable content. Exact retries return the same offer/terms during
  the run. Same key/different feature is `INVALID_PARAMS` without mutation.
  Another run needs a fresh key; cross-principal/account isolation is mandatory.
  Validation precedes mutation, cleanup uses sandbox ownership/TTL, never reset.
- False/absent flags do not require this operation. Unknown scenario names keep
  `UNKNOWN_SCENARIO`; malformed/unknown feature params keep `INVALID_PARAMS`.
  A true scope's valid refusal violates the promise; neither code means optional
  support negotiation. Uncommitted scopes are not probed through this operation.

The [features fragment](optional-product-feature-declarations/features.schema.json)
and [controller fragment](optional-product-feature-declarations/controller.schema.json)
are not installed into production schemas. Validation merges the former with
existing structured fields and unknown-boolean bounds. A future runner contract,
provisionally `product_feature_commitments_v1`, must bind the native returned
offer into the same pinned graph without requiring wholesale rediscovery that
would exclude brief-only products. Its authenticated preparation, evidence and
failure semantics need WG/SDK/caller review. No new assignment or implementation
is implied by naming that contract.

Reuse qualified same-selected capture/set semantics and per-lookup scope checks,
without asserting a host grant service, portable authenticated JSON or durable
cross-request trust. Direct state and opaque references need their real authority
boundaries. #8428's successful-create and invocation-local semantics do not
certify retired catalog reuse. Reader companions remain optional by tool.

### Reporting guarantees

A feature declaration/fixture does not inject observed reporting grains.
Requested supported format arrays may be empty, with required truncation and
applied-sort companions. Do not demand a format kind, first row, positive count,
forced truncation or selection from an unobserved larger population. Sorting
precedes metric narrowing under existing rules; narrowing stays independently
binding across metrics-bearing containers.

Time thresholds may be any positive seller-defined value; two/six seconds are
recommendations. A valid three-second `in_view` entry is acceptable, and
`(threshold_seconds, basis)` pairs are unique when emitted. Do not sum bases.
`available_metrics` is not proof of a matured commitment or timestamp. Contracted
arrays require the carrier or applicable missing-metric disclosure under current
maturity/measurability rules; empty observations remain legal where appropriate.

Deterministic nonempty format/time injection would require a separate controller
design specifying attribution, dates, replace/add, reconciliation, suppression,
validation and narrowing. #7982 property injection is not that design, and this
proposal neither chooses nor requires it.

## Implementation, compatibility and WG decisions

Major-version negotiation stays unchanged; no minor request pin is invented.
Old sellers need no new parent/flags; new clients keep their catalog route.
Old clients accept unknown boolean additions, and old runners retain existing
coverage without certifying the new promise. Unsupported future runner contracts
must leave visible gaps; unknown check load behavior must not become a pass.

1. Ratify eight scopes/names and the combined native-support/fixture promise,
   or choose a separately advertised fixture commitment. Passive rollups alone
   leave the seeded-only/brief-only certification gap.
2. Ratify exact controller retry/qualification/evidence semantics and the native
   offer-binding runner route, including honest commercial/profile gaps.
3. Schedule a future minor with release owners. Optional fields and new opt-in
   MUSTs are Normative/minor, not patch errata or a 3.2.x backport. No changeset
   is active in this nonoperative proposal; an implementation needs a descriptive
   `.changeset/optional-product-feature-commitments.md` with
   `"adcontextprotocol": minor`.
4. Coordinate an implementation touching only approved source schemas/docs,
   controller and qualified caller/SDK paths. Preserve #8428 independent graphs,
   optional reader roots, same-product prices and current reporting guarantees.
   Do not reopen its merge/SDK/pin/checkpoint ownership from this workspace.
5. During rollout, keep catalog evidence for absent/false and exact commitment
   setup for true/no-match. Deduplicate only actual same-feature/same-product
   execution; do not suppress independent smaller/larger paths. Display gaps,
   violations and untested commercial/catalog slices separately.
6. Qualify actual source schema/docs/controller, public full/standalone caller,
   exact pinned SDK, hosted disposition and CI. Treat #3395/#3396/#3397 and
   other bounded limitations honestly; no accounting or baseline weakening.

Existing sellers incur no mandatory migration. Opted-in sellers implement one
operation branch per true scope plus native execution. Buyers may ignore flags;
certifiers/SDK/caller owners pay routing/evidence costs. Eight booleans make
independent coverage explicit; whether that adoption cost warrants a smaller
profile/array surface is a WG choice, not hidden by a broad six-flag claim.
Wire-visible tests cannot prove internal native implementation: that remains an
attestation backed by lifecycle evidence, not generic seed acceptance.

Exact unresolved choices: the eight field names/granularity versus a reviewed
alternative; coupling support and fixtures; the native offer-binding/evidence
contract; retaining current reporting guarantees versus separate grain injection;
and release/certification activation after real implementation qualification.
Human/WG/path approval is still required; no agent review substitutes for it.

## Executable proposal evidence

```bash
node --test --test-timeout=30000 specs/optional-product-feature-declarations/probes.test.cjs
```

[Probes](optional-product-feature-declarations/probes.test.cjs) use real local
source/released schemas, an isolated proposed state machine and injected-client
SDK checks. All 256 field combinations are exercised. They do not execute #8428's
actual source/caller suite or implement the new controller/native route. Concrete
vectors cover selection/default/readback shape, fixed rejection, schema boundaries,
empty reporting and threshold freedom. SDK gates are labeled with actual runtime
version; this checkout's local pin remains 15.9.5, while upstream source uses16.3.
No candidate build/install, dependency change or SDK defect qualification occurs.
Exact commands, counts, versions and independent findings are in the
[review record](optional-product-feature-declarations/review.md).
