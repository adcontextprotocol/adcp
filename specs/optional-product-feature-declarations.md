---
title: Seller-wide optional product-feature commitments
class: normative
status: proposed
date: 2026-10-19
refs: ["#8254", "PR #8259", "PR #8336", "PR #7982", "PR #7973", "DR-0001", "DR-0009", "DR-0010"]
dissent: Human/WG decision outstanding; agent review is not ratification
---

## Decision

**Nonoperative future-minor proposal.** Approving investigation or opening this
PR does not ratify these clauses. This memo uses the decision-record format;
a DR number and decision provenance are assigned only through human review.
No production schema, storyboard, hosted disposition, or released artifact is
changed. The isolated schemas and executable model below are proposal evidence.

Recommend six optional booleans under `media_buy.features`, with no defaults:

| Field | Commitment and qualifying product | Independent consumers |
| --- | --- | --- |
| `supports_collection_selection` | At least one product with nonempty explicit `collections`, `collection_targeting_allowed: true`, and at least two distinct domain-qualified collection pairs so proper-subset selection can be tested. | Strict-subset structured selection, persisted readback and invalid-selector rejection. Existing default obligations still bind on the product. |
| `supports_collection_default_materialization` | At least one product with one distinct `(publisher_domain, collection_id)` pair in explicit `collections`, regardless of selectable/fixed mode. | `mode: default` full-bundle materialization and persisted concrete readback; independent of a strict-subset fixture. |
| `supports_fixed_collection_bundles` | At least one multi-collection product with `collection_targeting_allowed` false or omitted (existing default false). | Exact full-bundle restatement, default materialization, proper-subset rejection. |
| `supports_owner_sold_channel_carriage` | At least one channel-owner offer referencing that owner's canonical channel collection and a different host publisher's property. | Owner/host selector boundary checks; buyer-side host authorization verification remains separate. |
| `supports_format_breakdown` | At least one product with `reporting_capabilities.supports_format_breakdown: true`. | Requested `format` dimension, `by_format`, truncation and applied-sort echoes; no required observations. |
| `supports_time_based_views` | At least one product listing `time_based_views` in `reporting_capabilities.available_metrics`. | Metric availability and narrowing, schema-valid threshold entries when observed, committed-array presence when contracted. |

These are existential seller support commitments, never assertions about every
product. Default materialization and strict-subset selection qualify
independently: one distinct pair suffices for default coverage, while a genuine
strict subset needs two distinct pairs. Missing a two-pair fixture MUST NOT
suppress a one-pair default path. The two declarations do not make existing
readback obligations optional: a selected product's default/readback contract
still binds even when the separate seller-wide default commitment is absent or
false. Fixed-bundle subset enforcement needs its own two-pair fixed product and
must not depend on a selectable companion. Owner-sold offers can be fixed or
selectable: declaring owner-sold does not imply either of the other flags.
The owner-sold fixture uses the product's actual fixed/selectable behavior.
Format and time declarations are unrelated to each other or to creative-grain
reporting. Baseline requested-metric narrowing stays independently graded.

The shared `media-buy-features.json` also types `get_products`
`filters.required_features`. Using these flags there selects **sellers**, as
existing property rollups do; it never filters to qualifying products, provisions
a fixture, or implies every returned product supports the feature. Buyers still
inspect product declarations. No new filter mechanism is proposed.

The direct `collection_selection` path is distinct from hosted `collection_list`
and exclusion-list support. Their existing declarations continue to govern them;
these flags do not imply list-service, collection-card, placement-selection,
property-reporting, installment-reporting, or any new delivery-mode support.

## Rationale

Catalog-only applicability cannot certify support reachable only after sandbox
setup or through a brief. Generic `seed_product` accepting authored feature fields
does not establish native support. This proposal adds a clear support promise
and a separately specified setup commitment, rather than using seed refusal as
an unsupported-feature negotiation mechanism.

Controlling authority:

- [DR-0001](../governance/decisions/DR-0001-conformance-assertions-normative-basis.md): grade only normative/schema obligations. This memo is not yet such authority.
- [DR-0009](../governance/decisions/DR-0009-additional-properties-default-true.md): preserve existing object boundaries; validate known fields strictly.
  `media-buy-features.json` specifically allows unknown **boolean** flags; do not
  widen this to arbitrary objects.
- [DR-0010](../governance/decisions/DR-0010-fixture-handles-and-resolution.md): real seller identities, explicit strategies, pinned bindings, terminal supported-operation failures, visible exhausted-strategy gaps.
- [Product](../static/schemas/source/core/product.json), [targeting](../static/schemas/source/core/targeting.json), [collection selection](../static/schemas/source/core/collection-selection.json), [reporting capabilities](../static/schemas/source/core/reporting-capabilities.json) remain the product authority.
- [Delivery request](../static/schemas/source/media-buy/get-media-buy-delivery-request.json), [delivery metrics](../static/schemas/source/core/delivery-metrics.json), and [controller](../docs/building/by-layer/L3/comply-test-controller.mdx) bound what reporting evidence can prove.

### Main, release, and adjacent-work inventory

Verified on 2026-10-19 against main `c2f01a50f2133b016fc73ca74019c4c021f2256e`:
root package `3.2.1` is release machinery metadata, SDK pin **15.9.5**,
`.changeset/pre.json` is beta mode, stable latest is **v3.2.5**, and both
`changeset-release/main` (#7897) and `changeset-release/3.2.x` (#8274) are open.
The playbook says main is the future 3.3 line after GA; do not derive a release
number from root package metadata. The actual minor/train for this proposal is
**unassigned**, subject to WG and release-owner scheduling. No 3.2.x backport.

| Work | Verified disposition and relationship |
| --- | --- |
| [#8254](https://github.com/adcontextprotocol/adcp/issues/8254), [#8259](https://github.com/adcontextprotocol/adcp/pull/8259) | Open; full proposal and discussion read. Catalog owner retains three existing YAMLs, independent fixed/time YAMLs, media-buy index, compliance docs/tests, patch changeset and proposal reconciliation. Owner coordination confirmed before edits. Catalog implementation lands main first; maintenance qualification stays separate. |
| [#7982](https://github.com/adcontextprotocol/adcp/pull/7982) | Merged 2026-10-07. Reuse `media_buy.features`, independent matching product flags, and empty-array/companion discipline. Its absent/false mean "no rollup claim," not "no products"; keep that compatibility. Do not copy rollup-only gating, which hides undeclared catalog evidence, or its specific property-row injection/suppression exemption into format/time support. |
| [#7973](https://github.com/adcontextprotocol/adcp/pull/7973) | Open draft held for 3.4. Delivery modes are a different axis. Do not import its parent-object/schema-default dependence, compound fail-closed gates, coverage removal from required specialisms, or low-coverage baseline substitution. No files shared. |
| [#7134](https://github.com/adcontextprotocol/adcp/pull/7134), [#8201](https://github.com/adcontextprotocol/adcp/issues/8201) | Collection storyboards and fixture-resolution prior art. Current source and shipping SDK inspected; no changes to their shared contracts here. SDK currently accepts only seed/discover resolution strategies, despite source discussion of construct. |
| [#7958](https://github.com/adcontextprotocol/adcp/pull/7958), [#8061](https://github.com/adcontextprotocol/adcp/pull/8061), [#8246](https://github.com/adcontextprotocol/adcp/pull/8246) | Open composable-breakdown, collection-list and installment-product proposals. Preserve current product vocabulary; recheck before any later source promotion. |
| [#8117](https://github.com/adcontextprotocol/adcp/pull/8117), [#8156](https://github.com/adcontextprotocol/adcp/pull/8156), [#7934](https://github.com/adcontextprotocol/adcp/pull/7934) | Open negotiated-response-version, undefined-property reporting and per-account readiness work. Do not presume their proposed rules are operative or infer entitlement from this technical support declaration. |

All listed open adjacent proposals are authored by @bokelley. The scoped catalog
owner and root coordinator were contacted directly in their existing sessions;
this PR touches only its own proposal namespace and scoped evidence workflow.
Any later source overlap requires renewed file coordination with those owners.

### Reconciled catalog prerequisites (nonoperative)

The current foundation review packet is [#8259 at
`ce8a65d6bd192c105ef3175091f29c7f296e47b9`](https://github.com/adcontextprotocol/adcp/blob/ce8a65d6bd192c105ef3175091f29c7f296e47b9/specs/optional-product-feature-applicability/collection-prerequisite.md).
It supersedes earlier proposal-head references for this reconciliation; its new
exact-head CI must be observed separately. The owner reports 70 local probes,
code-review rerun of 70 and protocol rerun of 36. Those are owner/reviewer reports,
not reruns by this declarations workspace or implemented SDK qualification.

The selected-fixture contract must normalize schema-valid atomic
`(publisher_domain, collection_id)` pairs before eligibility and deterministic
parent selection. Default/full-bundle materialization needs one distinct pair;
strict-subset and fixed-subset enforcement need two. Fixed accepts literal false
or the existing omitted-false default, not null/wrong types. Optional declared
cross-domain owner/host relations must qualify before selection and retain the
same selected product, scoped price and relation witness. Full concrete bundle,
real singleton strict subset and collision-checked absent-ID/absent-domain
negatives must derive from that complete selected set. One normalizer serves
eligibility, witnesses and namespace-set validation; schema-valid redundant pairs
normalize as a set, while schema-invalid duplicate outer selected objects fail.
Empty string collection IDs remain legal under current schemas. Wire-declared
relations do not verify ownership or host authorization. Added collection
scenario IDs remain provisional; this proposal adopts no new source filename.

Protected captures need the proposed atomic write/delete/metadata funnel across
all context-write paths, detached immutable preparation state and deep-cloned
views against alias mutation, plus authenticated every-lookup tenant/caller/run/
grant/revocation checks. These are separate, **unimplemented foundation
surfaces**. Main-line implementation assignment is **NONE RECORDED / unconfirmed**;
reviewer-only work is not an assignment. This PR implements no SDK/DSL, protected
state or authenticated lookup. Its small pair normalizer is an isolated model
helper, not a foundation API or evidence of implemented capture/state safety.

Held reporting [#8336 at
`8ccc1d62194b9b8e2a9b8d3b2543b20d145f67f6`](https://github.com/adcontextprotocol/adcp/pull/8336)
has exactly two current actual-source IDs: `media_buy_seller/advanced_delivery_reporting`
(format-only, literal product format-support true) and
`media_buy_seller/time_based_delivery_reporting` (time metric independently present).
Both discover native non-guaranteed products with compatible fixed CPM options,
resolve pricing from the same product graph, and fully validate/paginate before
selection. Only the isolated account is seeded; no feature products/prices are
seeded. No-match is an explicit coverage gap, never a pass or nonsupport proof.
Seeded-only, brief-only and commercial coverage limits remain disclosed.

Commercial snapshot/minimum-spend, mature committed-time value-or-disclosure,
caller-brand, full/standalone and hosted disposition limits keep that draft held.
The owner reports 48 actual-source/public/hosted tests and 38 successful exact-head
checks plus five skips; the draft storyboard matrix is skipped. These counts do
not qualify runtime behavior or authorize shipping. The later #8259 public
evidence shows bounded same-read returned-row ordering and time value-or-disclosure
are already downstream-authorable, with timestamp/measurability/live-fallback,
standalone-flow and unobserved-population limits. They are not reasons to invent
new reporting observations or deterministic grain injection. Main 15.9.5 and a
disposable pristine 15.9.6 comparison remain separately scoped; no dependency
adoption follows. #8254 stays open. Maintenance qualification/merge, draft Version
Packages refresh (including #8274), publication and production actions remain held;
the #8302-only refresh exception does not extend to these drafts.

## Proposed normative language

The following MUST/SHOULD text is conditional on adoption in an assigned minor.

1. A seller MAY emit any subset of the six fields. Every emitted known value
   MUST be a boolean. Omitted fields, including an omitted `features` or
   `media_buy` parent, mean **no seller-wide claim / unknown**, not unsupported.
   `false` explicitly declines the seller-wide commitment; it does not deny
   individual supporting products. `true` declares native technical support
   and the sandbox fixture commitment below. Unknown future boolean keys MUST NOT be
   interpreted as a known feature; existing feature-object compatibility is preserved.
2. A true declaration MUST be backed by at least one qualifying, bookable
   sandbox offer through the seller's normal execution path. Initially empty,
   nonqualifying wholesale, seeded-only and brief-only catalogs are permitted.
   A seller MUST implement `prepare_product_feature` for every true feature,
   advertise that scenario through `list_scenarios` when supported, and supply
   a valid qualifying fixture on request. A fixture-only echo path that accepts
   unsupported authored fields does not satisfy native execution support.
3. Each product remains authoritative for its own feature support. A seller
   MUST honor every product-level declaration on a selected product regardless
   of an absent or false seller-wide field. A supporting product alongside a
   false rollup is not a contradiction. A true rollup alongside ordinary,
   non-supporting products is also not a contradiction. A declaration is
   contradicted when its promised setup cannot supply a qualifying fixture,
   or selected qualifying behavior violates its existing product contract.
4. A runner MUST preserve catalog-based testing for absent/false declarations.
   It MUST NOT replace that route with an equals-true gate over the whole
   storyboard or infer schema defaults through missing parents. A true
   declaration selects commitment testing even when initial catalog evidence
   is empty. Catalog discovery is attempted only when wholesale is actually
   supported; brief-only support cannot be wholesale-gated away.
5. Setup and behavior evidence MUST be reported separately. Harness inability
   to dispatch a negotiated operation is an explicit untested/setup gap. A
   promised operation advertised by the seller that refuses, malforms, returns
   `UNKNOWN_SCENARIO`/`INVALID_PARAMS` on valid input, or supplies a nonqualifying
   fixture is a producer commitment violation. It MUST NOT become
   `not_applicable`, a pass, or fallback success. Missing promised operation
   confirmed from the seller's tool/scenario surface is a commitment violation;
   failure to inspect that surface is a harness gap. Harness errors and
   malformed runner input MUST NOT be blamed on the producer.
6. No field conveys account authorization, commercial access, availability for
   a particular buyer, or entitlement. Existing auth/account checks remain in
   force. Fixtures use a prearranged, authorized, **feature-eligible** sandbox account;
   a runner lacking one records that precondition gap. Establish eligibility
   through ordinary account onboarding/operator setup evidence, not these
   flags. A documented access denial before those preconditions hold is a
   precondition gap; once they hold, setup refusal violates the promise. A bare
   `INVALID_PARAMS` or post-failure assertion of ineligibility cannot alone
   establish that gap or cancel the commitment. Metadata contains no credentials, tokens,
   endpoint overrides, or entitlement assertions. Seller-provided terms,
   account eligibility and selected pricing govern the fixture buy.

### Applicability and fixture state table

Evaluate each feature independently; never require a companion feature product.
Catalog availability below means a valid, fully paginated wholesale scan is
possible. A transport/protocol/schema/pagination failure after a supported scan
starts is terminal under DR-0010, not a no-match or a setup fallback.

| Declaration | Catalog / precondition | Required next action | Outcome / evidence |
| --- | --- | --- | --- |
| absent, false, unknown key, or old seller | Qualifying catalog product | Pin real product and execute feature | Product obligations graded; seller-wide promise not inferred. |
| absent or false | Valid catalog, no qualifying product | No generic feature seed | `fixture_unsatisfied` coverage gap; N/A projection is no proof of nonsupport. |
| absent or false | Brief-only, no defined construction route | Do not invent wholesale or construct | Explicit discovery-precondition gap; unknown support. |
| true | Qualifying catalog product | Verify promised setup operation exists; pin and exercise product | Product feature graded; preparation explicitly untested until its separate commitment probe runs. |
| true | Empty/nonqualifying catalog or brief-only | Call negotiated feature setup, pin returned product | Grade normal purchase/readback/reporting independent of wholesale. |
| true | Setup operation absent, or valid advertised setup refused | Preserve failed response and commitment result | Producer violation, never N/A or fallback. |
| true | Setup succeeds with malformed/nonqualifying product | Stop before purchase | Producer violation with exact schema/qualification evidence. |
| true or selected product | Broken selected behavior | Retain validation/protocol failure | Producer behavior violation; no fallback or applicability reclassification. |
| any | Runner lacks new setup contract/schema, feature-eligible sandbox access, or required harness tool | Record missing precondition | Harness/setup gap, no compliance pass or producer accusation. |
| malformed known declaration | e.g. string `"true"`, null, array | Fail capability validation for known field | Invalid producer declaration; never coerce or ignore as false. |

The reference model returns local evidence labels (`commitment_violation`,
`harness_gap`, `coverage_gap`, `behavior_violation`, `applicable`). These are
**not new wire errors or shipping runner-output enums**. Current hosted
[step disposition](../server/src/compliance/step-disposition.ts) maps synthetic
controller setup failures to `setup_gap` and unsupported seeds to N/A. Adoption
requires a separate assertion of the declaration obligation, with the failed
setup evidence attached. Global grading guards and baseline floors stay intact.
A missing runner contract or confirmed missing preparation operation cannot
silently remove existing product tests. Catalog behavior evidence and commitment
evidence are separate axes: a passing catalog path with preparation untested
MUST NOT certify the seller-wide commitment. Before certifying a true flag, a
runner MUST also execute valid preparation and exercise its returned fixture,
even when another product already qualified through catalog discovery.

## Additional controller contract requiring a WG decision

Current `seed_product` accepts permissive authored exemplars; `list_scenarios`
only identifies operation names. Neither negotiates native feature support or
returns a feature-qualified seller-owned offer. `simulate_delivery` supports
property-row injection but does not inject observed format rows or time-view
measurements. The shipping resolver accepts only seed/discover, so `construct`
is not an executable escape hatch here.

Propose one additional sandbox scenario, **`prepare_product_feature`**, within
`comply_test_controller`, using its existing account and success/error envelope:

- Params: `feature` (one of the six scope identifiers below) and `fixture_id`
  (nonempty run-scoped idempotency key, maximum 128 characters). No authored
  product fields, selector strings, observed metrics, or credentials.
- Success: `success: true`, `simulated: {feature, fixture_id, product}`. `product`
  MUST validate against current `core/product.json`, qualify for the requested
  feature, and carry seller-issued identities and a usable pricing option.
  The response does not supply trusted authorization attestations. Owner-sold
  qualification also requires independent owner channel/host evidence from
  canonical discovery/fixtures; the product alone cannot prove channel kind or
  host authorization.
- Setup establishes an offer in the seller's real sandbox adapter path, with
  disclosed product terms and sufficient test inventory. It may expose it only
  through a brief; the returned full product is the binding input and purchases
  use its seller-issued IDs. Wholesale listing is not newly required. Re-read
  through the normal buyer lifecycle; do not grade only the controller echo.
- `fixture_id` is scoped by authenticated principal and sandbox account; the
  feature is immutable request content, not part of the key namespace.
  An exact retry returns the same offer and terms during the run; reusing a key
  for a different feature is `INVALID_PARAMS` with no mutation. Runners MUST
  generate fresh, run-unique fixture IDs. Isolation is enforced across principals
  and accounts; reusing the same key in the same principal/account namespace is
  a retry, not a separately isolated run. Setup validates before mutation. Cleanup follows
  normal sandbox TTL/ownership rules, never a production reset.
- False/absent commitments do not require this scenario. Unknown scenario names
  retain `UNKNOWN_SCENARIO`. A known scenario with unknown feature or malformed
  params returns `INVALID_PARAMS`; that code still means invalid input or unmet
  precondition, never "feature unsupported." A true feature's valid setup refusal
  is evidence of a violated promise, not a new interpretation of the error.
  An uncommitted feature is not probed through this operation.
- Scope identifiers: `collection_selection`, `collection_default_materialization`,
  `fixed_collection_bundles`,
  `owner_sold_channel_carriage`, `format_breakdown`, `time_based_views`.

The isolated [declaration schema](optional-product-feature-declarations/features.schema.json)
is the proposed additive `core/media-buy-features.json` properties fragment.
It is merged into the existing properties for evidence validation, preserving
existing structured features and the unknown-boolean constraint.
The [controller schema](optional-product-feature-declarations/controller.schema.json)
defines the proposed params and `simulated` payload, referencing the real product
schema. It is not installed into the published controller schema. A runner must
explicitly advertise/enable a future `product_feature_commitments_v1` harness
contract before using this route; its eventual runner-output representation and
SDK implementation are still required. This name is a proposal, not a working
SDK contract. There is no storyboards-schema edit in this PR.

### Reporting limits

A declaration and prepared product establish technical support and a valid
execution fixture, not observed reporting grains. Format checks require the
requested supported array (possibly empty), truncation disclosure and actual
applied-sort echoes. Never require a video format, first-row identity, positive
row count, or `truncated: true` from generic delivery simulation. Sorting remains
before requested-metric narrowing; existing fallback rules apply.

Time-view thresholds may be any positive seller-defined number; two/six seconds
are recommendations. A valid three-second `in_view` entry is acceptable. Check
unique `(threshold_seconds, basis)` pairs when entries exist and do not sum
bases. `available_metrics` alone does not guarantee every uncommitted metric
is measurable on every report. Missing values follow existing omission and
`missing_metrics` rules. Contracting `time_based_views` binds accountability for its array carrier or
the applicable `missing_metrics` disclosure under existing maturity/measurability
rules; it does not force observations or bind particular thresholds. An empty
observed array remains valid where the carrier is appropriate. A feature
declaration alone supplies neither a matured commitment nor its timestamp.
The isolated reporting probes exercise these limits without injecting grains.

If the WG wants deterministic nonempty observations, it needs a **separate**
controller amendment specifying package attribution, accepted format/threshold
rows, replace/add semantics, dates, reconciliation, suppression, idempotency,
validation and request-narrowing behavior. This PR neither chooses nor requires
that amendment; #7982's property-specific injection is not such a contract.

## Compatibility, migration and implementation plan

Major-version negotiation remains unchanged: `adcp_major_version` chooses a
major; feature checks determine minor additions. Do not invent a minor request
pin, use deployment version strings as capability gates, or treat #8117 as law.
A new client with an old seller keeps catalog testing when these fields are
absent. An old client validates new fields through open objects and ignores
unknown keys. An old runner cannot certify the new commitment; it keeps its
existing catalog coverage and must not issue unknown setup calls. A seller on
an older release is not required to emit these fields or add a `media_buy`
parent. Unknown future capability keys are not proof of this contract.
After adoption, emitting a standardized field as `true` is the explicit producer
opt-in, regardless of self-reported implementation minor. There is no hidden
handshake or second version marker. Historical snapshots from before adoption
are not retroactively certified; older implementations with a colliding custom
boolean name must remove it or adopt this contract before opting in. An old
schema accepting that boolean is not itself semantic certification.

1. Preserve the separately owned held catalog drafts and their qualification holds;
   a 3.2.x backport requires a qualified main merge and separate actual-pin review.
   Retain its independent feature graphs, seller-derived selectors/pricing,
   omitted-false bundle handling and current reporting guarantees.
2. Ratify exact fields, existential semantics and setup commitment. Assign a
   future minor after the release owner confirms the train; do not copy #7973's
   3.4 hold as a release assignment for this design. New stable optional fields
   plus new opt-in MUSTs are Normative/minor, not patch errata. Sellers making
   no claim keep their existing contracts.
3. In a coordinated implementation PR add six properties to
   `static/schemas/source/core/media-buy-features.json`, document the clauses in
   `docs/protocol/get_adcp_capabilities.mdx`, add the controller scenario/params
   and docs, implement native fixture preparation in the reference seller, and
   qualify schema/MCP projection without changing dependency pins or limits.
   Use a real descriptive `.changeset/optional-product-feature-commitments.md`:

   ```yaml
   ---
   "adcontextprotocol": minor
   ---
   Add optional seller-wide product-feature commitments and sandbox feature-qualified fixture preparation. Preserve catalog-based coverage for undeclared sellers.
   ```

   That changeset is intentionally **not active in this proposal-only PR**;
   policy forbids versioning a nonoperative spec experiment as shipped protocol.
4. After explicit implementation assignment and contract approval, add the
   runner setup/evidence contract in its owning SDK and qualify the actual
   pinned SDK and real source storyboards, and integrate a declaration assertion
   that cannot be hidden by controller prerequisites. Coordinate shared files
   with #8254 before promotion. Do not create equals-true or compound gates that
   exclude undeclared sellers or remove required-specialism coverage.
5. During rollout, use catalog evidence for absent/false and commitment setup
   for true/no-catalog. Deduplicate execution when both routes select the same
   feature/product. Test unrelated product declarations even when the rollup
   declines a claim. Display harness gaps, violations and catalog limitations
   separately. After SDK qualification, sellers opt in per independent feature;
   registries/buyers gain pre-discovery routing hints but still inspect products.
6. Run source schema/docs parity, controller unit/integration and MCP projection
   checks, source-storyboard contract tests, hosted disposition tests, normal
   matrix and required CI on the exact implementation head. Do not change
   global guards/floors, immutable records, maintenance branches or release
   automation. Human/WG/path review remains mandatory; no automatic merge.

Existing sellers pay no mandatory migration cost. Opted-in sellers implement
one preparation scenario with a branch per true feature plus normal product
execution. Buyers may ignore the flags; certifiers and SDK owners pay the
routing/evidence cost. The setup obligation is deliberately stronger than a
passive rollup and makes empty-catalog support testable. A remote assertion
cannot prove how a producer implemented its adapter; lifecycle probes catch
wire-visible divergence, while native-support honesty remains an attestation.

## Executable evidence and review boundary

Run from the repository root:

```bash
node --test --test-timeout=30000 specs/optional-product-feature-declarations/probes.test.cjs
```

[Probes](optional-product-feature-declarations/probes.test.cjs) combine an
isolated proposed commitment state machine with real source-schema validation
and separate SDK 15.9.5 runner and old-controller behavior checks. The model uses injected in-memory
sellers. It is **not** an implemented SDK feature, actual repaired storyboard,
hosted certification run, production adapter test or 3.2.x qualification.
Tests cover declarations, mixed feature subsets, valid catalog and empty/brief
setup, honest harness gaps versus refusal/invalid setup, selected-path failures,
old clients/servers, schema openness, reporting emptiness and threshold freedom.
The SDK probes pin present gate/default and unsupported-setup hazards rather
than claiming the proposed routing already exists. Exact review findings and
commands are recorded in [review evidence](optional-product-feature-declarations/review.md).

## Unresolved normative choices for human/WG review

1. Adopt the six field names and independent qualification, including a one-pair
   default path separate from two-pair subset selection and owner-sold independent
   of selectability?
2. Adopt existential native support **plus** mandatory feature-qualified sandbox
   preparation for true declarations, or split technical-support rollups from
   an independently advertised fixture commitment? Recommendation: one explicit
   opt-in commitment per feature as specified; passive rollups leave the original
   seeded-only certification gap unresolved.
3. Adopt the exact `prepare_product_feature` params/result, retry scope and
   violation treatment? Its native-offer promise and new runner assertion require
   WG approval and SDK implementation; existing error semantics stay intact.
4. Keep reporting observations optional under current guarantees, or commission
   a separate deterministic grain-injection design? Recommendation: keep current
   guarantees; injection must not block this commitment design.
5. Confirm release scheduling, evidence representation and the point at which
   opting in becomes certifiable after real SDK/source-storyboard qualification.
   No agent review substitutes for WG ratification, human/path approval or CI.
