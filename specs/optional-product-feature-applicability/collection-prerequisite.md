# Collection storyboard prerequisites for #8254

Status: implementation plan/proposal only. No API or matcher named below is
implemented by this work. Brian authorized a reporting-only correction and a
concrete collection prerequisite proposal; the SDK pin remains **15.9.5**.
The existing proposal PR is [adcp#8259](https://github.com/adcontextprotocol/adcp/pull/8259).
Chat direction authorizes preparation; it does not manufacture a GitHub approval
or remove that PR's recorded workflow/CODEOWNERS gate.

## Recommendation

Retain the independent reporting candidate as a **held qualification draft**;
selected commercial context, matured committed-metric accountability, caller
brand and standalone parity still block shipping it. Keep the
collection rewrite separate until a small upstream collection foundation is
specified, reviewed, and available through an authorized dependency change.
Prefer an upstream change in `adcontextprotocol/adcp-client`, which owns the
runner. Do not vendor/patch the installed SDK, extend the protocol DSL only in
the hosted application, or publish collection YAML that old runners silently
undergrade.

The smallest justified semantic addition has three parts:

1. Qualify a real collection product **before** deterministic selection,
   including the schema's omitted-false default and the needed host/owner
   relationship. Preserve complete, validated, paginated catalog enumeration.
2. Expose the selected product and scoped pricing snapshot, plus a real proper
   collection subset/witness, as declared run context. Bind and capture these
   from the same selection; do not make another unfiltered `products[0]` read.
3. Compare complete domain-qualified collection sets without depending on
   selector grouping or array order, while preserving schema failures, normalizing schema-valid redundant pairs,
   and failing missing expected state. Execute this validation equally in full and standalone runs.

Also make fixture preparation/binding state available to the standalone runner;
otherwise the three additions would repair full runs but leave the hosted step
API using literal fixture handles.

## Evidence on the actual public runner

Run:

```bash
node --test --test-timeout=30000 specs/optional-product-feature-applicability/collection-prerequisite.test.cjs
```

**19 tests pass.** The file imports only `@adcp/sdk/testing` for SDK behavior and
calls public `runStoryboard`, `runStoryboardStep`, `parseStoryboard`,
`registerAssertion`, `extractContext`, and `injectContext`. The public
`transport.trustedFetchFn` option supplies deterministic MCP JSON-RPC responses;
the real SDK transport, client, schema validation, and runner execute. There is
no `_client`, `_profile`, private SDK import, real network access, or production
write. Reading the installed package version is the only non-exported package
file access. This is prerequisite evidence, not repaired-storyboard coverage.

The probes establish:

| Probe | Observation |
| --- | --- |
| Explicit false / omitted collection flag | `equals: false` resolves the explicit value; omission is `fixture_unsatisfied` despite the normative false default. |
| Proposed absent/OR/relational/capture declarations | The public loader rejects them on this pin. These are not existing extension points. |
| Later paginated product | Existing matching finds a later explicit qualifying product after complete pagination, but a later omitted-default fixed product still cannot match `equals:false`. |
| Selected product metadata | Full resolution binds the actual seller ID but supplies no selected collection/domain context. Requests needing such context fail before the buy. |
| Another normal read | The bound product is `a-selected`; `products[0]` can be `z-ordinary`, with different selectors, pricing currency and minimum spend. Seller response order is not fixture selection order. |
| Full / standalone | Full run substitutes `seller-selected`; the same standalone step performs no fixture discovery and transmits `authored-product`. |
| Broad match followed by runtime skip | A selectable first product conceals a later omitted-default fixed product. A same-domain first product similarly conceals a later external-owner/host product. |
| Public extraction | Fixed response paths capture objects, arrays and scalar IDs; whole-key substitution works. `$context.foo.bar` is not nested substitution. |
| Scalar subset assembly | Captured domain and first collection ID can build a singleton request without a general transform language. This works only when the correct entity is already available. |
| Whole-array equality | A harmless selector/ID reorder fails `field_equals_context`. |
| Reference matching | `refs_resolve` cannot match independently allocated `collection_ids` arrays as key values. |
| Flattened ID matching | ID-only membership passes a publisher-namespace substitution. |
| Unknown check name | An unimplemented check is `passed: true, not_applicable: true`; merely adding a new check to YAML is unsafe. |
| Missing comparison context | Existing branch-safe equality passes with a `context_key_absent` observation. A mandatory set check must not copy this behavior. |
| Failed discovery | Schema failure stays terminal and does not become an applicability gap. |
| Local invariant extension | An imported invariant fails the full run but does not run on the standalone entry point. |

## Authority and grading constraints

- [DR-0001](../../governance/decisions/DR-0001-conformance-assertions-normative-basis.md):
  assertions must follow a normative requirement. A test exemplar does not make
  a product feature mandatory.
- [DR-0010](../../governance/decisions/DR-0010-fixture-handles-and-resolution.md):
  explicit fixture strategies; all-or-nothing authored graphs; deterministic
  binding; failures cannot be concealed by fallback; real no-match is a visible
  coverage gap, not a pass.
- The current `storyboard-schema.yaml` match grammar is closed. `equals` means
  JSON deep equality, `present` has no operand, and the remaining operators are
  `contains_all`, `any_match`, and `canonical_format_satisfies`.
- `collection_targeting_allowed` defaults false. Silently changing every
  `equals` comparison to apply arbitrary defaults would revise the existing
  matcher contract. A new explicit semantic predicate or explicit presence/OR
  grammar must be specified first.
- Catalog product, property, and collection selectors can scope the wire-visible
  carriage checks. They do **not** attest collection ownership, host
  authorization, `adagents.json` validation, or a verified supply path. Keep
  those assertions outside this seller-wire storyboard.
- Generic seed/controller/wholesale support never establishes these optional
  collection features. A valid optional-feature seed cannot silently become a
  new refusal/negotiation API.

## Minimal upstream contract: proposed, not an existing API

The following is a concrete recommended direction for review. Exact names are
provisional, and must be agreed in the authoring/output contract before code.

### 1. A bounded collection eligibility predicate

Prefer **one domain-specific semantic predicate**, analogous to the existing
canonical-format satisfaction predicate, over adding a general expression/join
language just for these tests. A possible proposed name is
`collection_selection_satisfies`; its operand would explicitly name:

- `mode: selectable | fixed | any`;
- `minimum_pairs: 1 | 2` (one for default/full-restatement coverage, two when a
  genuine strict subset is material);
- an optional external-owner/host relation for the wire-visible carriage case.

This predicate operates on a validated complete candidate product at the root.
It uses a shared domain-qualified pair normalizer. `fixed` accepts only literal
false or absence of the schema-defaulted flag. Null or wrong-typed flags remain
schema failures. `selectable` requires literal true. Qualification occurs before
UTF-8 identity ordering, so a nonqualifying first product cannot hide a later
qualifying entity.

For carriage, traverse all declared collection selectors and property selectors;
do not compare only index zero. Find and retain an authored relation's witness
whose owner namespace differs from the host namespace, and whose required
placement structure matches. Define the exact seller-inline/placement
requirements in the storyboard contract using the existing wire-visible model.
Do not infer ownership from URL hostname equality or claim that this predicate
performs buyer-side host authorization. An ordinary same-namespace selectable
product must not satisfy the carriage relation. An external collection product
can only establish the wire-visible relation, not verified ownership.

The predicate may return a private match witness alongside eligibility; the
public legacy boolean matcher can retain its return type. The resolver must
capture the witness for the candidate it actually selects. It must not recompute
a different witness from an unrelated response.

**Generic alternative, larger:** add explicit absence plus OR expressions and
quantified relational operands. A plain `not_equals_path` at index zero does not
solve arbitrarily ordered/multiple property and collection arrays. A general
solution needs root/current-element scoping, witnesses, operand validation and
resource bounds. If future use cases independently require that language, it
can replace the focused predicate, but it is not the smallest #8254 prerequisite.
Do not add general OR and then leave relation/witness selection unspecified.

### 2. Declared selected-entity context and collection witnesses

Add an explicit opt-in context capture to product and scoped-pricing resolution
declarations. Reuse current `ContextOutput` scalar/object/array extraction where
possible: paths are relative to the **selected entity snapshot**, not the first
row of another response. Possible proposed spelling: declaration-local
`context_outputs: [{ key, path }]`. This spelling is rejected on 15.9.5 today.

Only publish captures after the entire fixture graph resolves successfully. The
selected product ID, scoped pricing option, product metadata, collection bundle,
and commercial terms must all come from the same pinned graph. Record capture
provenance and match witness in fixture evidence; preserve the exact seller
snapshot rather than adding invented fields to a seller response. Declare key
collisions as authoring errors, and prevent caller context from overriding
preparation-produced captures. Use a reserved immutable namespace: later
convention extraction, authored step captures and seller-returned context must
not replace preparation snapshots, witnesses or their provenance either.

Existing scalar capture plus ordinary YAML object construction is enough for a
simple singleton request. A general subset/map/slice language is unnecessary.
For arbitrary multi-selector products and carriage, provide a bounded
**collection-witness capture** from the selected predicate result:

- the full concrete selector bundle;
- a singleton selected set guaranteed to be a strict subset when `minimum_pairs`
  is two, with the correct carriage witness when that relation was requested;
- a schema-valid unknown-ID selector verified absent from the pinned product;
- a schema-valid mismatched-domain selector verified absent from the pinned
  product's owner namespaces.

The names/shape of this bounded derived capture must be specified explicitly;
they are a proposed extension, not ordinary response paths or new seller fields.
Generate negative witnesses locally and check collisions against the captured
set; do not assume a hardcoded domain/ID is unknown. Do not synthesize products,
seller support, observations, or commercial terms. Return setup failure if a
declared required capture cannot be built; never downgrade that to unsupported.

For pricing, use the existing scoped pricing resolver. Product eligibility must
include an authored compatible pricing option so deterministic parent selection
cannot choose a product whose required child is unavailable while another
product would satisfy the complete authored requirements. A first reviewed
slice may explicitly limit commercial coverage to fixed-price CPM in a supported
currency; it must report that limitation and must not grade arbitrary bid/floor
values copied from an illustrative fixture.

### 3. A namespace-aware collection set validation

Add one explicit validator, possible proposed spelling
`collection_set_equals_context`, whose response `path` and mandatory
`context_key` both identify arrays of concrete selectors.

Normalize each selector to atomic `(publisher_domain, collection_id)` pairs.
Compare exact sets after bytewise ordering of the **pairs**, independent of
outer grouping/order and inner ID order. Never flatten IDs without domains.
Preserve schema validation of the surrounding response, including `uniqueItems`
on identical outer `selected.collections` entries. Normalize otherwise
schema-valid repeated IDs and overlapping atomic pairs as one pair: product
collections and inner IDs have no uniqueness constraint. Collection ID strings
have no `minLength`; do not add a nonempty-ID rule. Distinct pair cardinality
defines a proper subset. Stronger pair-uniqueness rules would require a separate
normative decision. Do not case-fold or rewrite identifiers beyond behavior
required by their schema.

Missing/null/non-array actual data, missing expected context, and malformed
expected selectors fail the validation with distinct authoring/setup diagnostics.
Missing expected context must not use existing branch-safe `context_key_absent`
success. Bound normalized pair count and diagnostic output; limit exhaustion is
a visible failure, not truncation that could make unequal sets compare equal.
Use the same normalizer for predicate eligibility, subset/negative witnesses,
and validation, to avoid inconsistent definitions of collection identity.

The validator must run in both `runStoryboard` and `runStoryboardStep` via the
shared per-step validation engine. A process-local custom invariant is not an
equivalent implementation.

### 4. Full, standalone and hosted fixture-state parity

Make current fixture preparation reusable through a documented public contract,
rather than exposing `executeStoryboardPass`'s private `preSeeded` object.
A possible proposed API is `prepareStoryboardFixtures(...)`, returning an
immutable prepared state plus fixture-resolution records and coverage gaps.
Both full and standalone runners must accept/use the same prepared state, or
the standalone runner must prepare it on first use and return it for subsequent
steps. Neither proposed API exists today.

State binds to storyboard identity/content, resolved seller route and URL,
schema/AdCP target, account/sandbox/auth scope, and run identity. It includes
the pinned identities, snapshots/witnesses, capture provenance, and any terminal
preparation disposition. Steps cannot change or reinterpret those bindings.
No-match yields `fixture_unsatisfied` before a stateful call; failed supported
discovery/setup remains failed. Retry must not repick products or hide a failed
preparation behind freshly discovered alternatives.

Do not treat browser-supplied JSON snapshots as independently verified catalog
evidence. Hosted endpoints should store prepared state in their authenticated
run/session scope and accept an opaque reference, or reconstruct it through the
same authenticated preparation with explicit run pinning. An opaque reference is never authorization: every lookup must enforce the
authenticated tenant/org, caller and run scope, and recheck current grant and
revocation state. Bind auth scope using a nonsecret principal/credential generation
identity; never include bearer tokens or other credentials in evidence. Existing
arbitrary `context` input is insufficient proof. If durable/multi-process state is deferred,
say exactly which interactive surface remains unsupported and do not claim
full/standalone parity.

New collection YAML must fail closed on a runner that lacks this contract.
The proposed new fixture declaration/operator currently fails load, which is
safer than publishing only a new validator name: the latter is silently marked
not applicable on 15.9.5. Specify a runner requirement/version contract and test
the downgrade explicitly; do not rely on unknown checks being failures.

## Downstream source adoption plan (not implemented)

| AdCP source | Proposed adoption after prerequisite qualification |
| --- | --- |
| `static/compliance/source/universal/storyboard-schema.yaml` | Document the approved matcher/capture/set-validation/prepared-state requirements, with explicit downgrade behavior. No seller capability or controller change. |
| `static/compliance/source/universal/runner-output-contract.yaml` | Specify capture/witness provenance and preparation-state evidence/failure scope without changing existing accounting. |
| `static/compliance/source/protocols/media-buy/scenarios/collection_selection.yaml` | Retain selectable purchase/readback/rejection grading, deriving exact selectors and commercial inputs from the selected snapshot. |
| Proposed separate default-materialization and fixed-bundle scenario files | Independent fixture graphs, including omitted-or-false fixed eligibility. Published IDs/filenames require implementation review; no authored companion may suppress another supported path. |
| `static/compliance/source/protocols/media-buy/scenarios/owner_sold_channel_carriage.yaml` | Qualify the declared cross-domain host/collection relation and use its retained witness; preserve valid, unknown-ID and mismatched-domain requests. Do not claim external ownership/host authorization verification. |
| `static/compliance/source/protocols/media-buy/index.yaml` | Register independent scenarios without raising or lowering unrelated coverage/floors. |
| Relevant compliance known-limitations documentation, actual-source/hosted tests, patch changeset | Disclose seeded-only/brief-only/commercial coverage limits and preserve raw failure/accounting evidence. |

Keep default materialization possible with one valid pair independently of a
strict-subset exercise needing two **distinct** pairs. A seller with only a
one-pair selectable product must not lose applicable default coverage because a
two-pair subset fixture is unavailable. Each supported scope resolves its own
graph; any additional subdivided scenario IDs remain provisional until that
source implementation is reviewed. Negative witnesses must be checked against
the complete selected product, not a shortened subset or another catalog row.

The remaining normative boundary is separate from the matcher/context gaps:
wire-visible product selectors establish a **declared relationship**, not
verified beneficial ownership or host permission. Review the carriage scope's
exact existing wire obligation; any stronger ownership/authorization assertion
needs its own normative authority and cannot be invented in this patch.

## Affected upstream files and tests

Paths below were verified in the upstream repository tree. They are the
smallest cohesive ownership boundaries, not a request to edit them here.

| SDK source | Required change |
| --- | --- |
| `src/lib/testing/storyboard/types.ts` | Typed collection predicate/capture/validator declarations; prepared-state input/output contract. |
| `src/lib/testing/storyboard/fixture-resolution.ts` | Closed predicate/capture validation; bounded eligibility; preserve deterministic identity binding. |
| Proposed `src/lib/testing/storyboard/collection-selection.ts` | One pair normalizer, relation/subset/negative-witness builder, set equality with bounded diagnostics. |
| `src/lib/testing/storyboard/seeding.ts` | Capture the selected product/pricing/witness once; commit context only after graph success; expose reusable preparation without changing seed semantics. |
| `src/lib/testing/storyboard/context.ts` | Reuse/provenance for declaration-local fixed-path captures. No general transform language or nested-token expansion is required. |
| `src/lib/testing/storyboard/validations.ts` | Shared namespace-aware set validator with mandatory expected context. |
| `src/lib/testing/storyboard/runner.ts` | Full/standalone preparation, pinned-state lifecycle, propagation of capture evidence and failures. |
| `src/lib/testing/storyboard/index.ts`, `src/lib/testing/index.ts` | Public preparation/state exports where needed. |

Extend existing `test/lib/storyboard-fixture-resolution.test.js`,
`test/lib/storyboard-controller-seeding.test.js`,
`test/lib/context-extractors.test.js`,
`test/lib/storyboard-validations.test.js`,
`test/lib/storyboard-validations-refs-resolve.test.js`,
`test/lib/storyboard-assertion-registry.test.js`, and
`test/lib/comply-vs-storyboard-parity.test.js`; add a focused collection helper
suite. Run actual public full/standalone entry points and MCP/A2A/routed cases.
Do not duplicate a hand-written fixture selector in tests as the oracle.

Acceptance cases include omitted/false/true flags; a misleading first product;
reordered/multi-namespace selectors; different selector grouping; duplicate
pairs; duplicate IDs in different namespaces; strict subsets; seeded-only and
brief-only coverage limits; parent/price coherence; pagination and discovery
failure; selection frozen across steps/retries; and caller-supplied fake state.
Verify old seed-only storyboards and existing DSL semantics stay unchanged.

## Public API audit and local alternative

| Existing public surface | Capability / limit |
| --- | --- |
| `runStoryboard` | Resolves ordinary fixtures internally; returns identity/evidence records, not a reusable selected-entity context preparation API. |
| `runStoryboardStep` | Runs one authored step with caller context/request; does not resolve ordinary fixture graphs or restore public binding state. |
| `FixtureBindingRegistry` + `applyFixtureBindingsToRequest` | Can translate already-known identities. They do not discover or authenticate metadata, qualify defaults/relations, or make prepared evidence available. |
| `extractContext`, step `context_outputs`, `injectContext` | Fixed response extraction and whole-key substitution. Useful after correct selection, not a deterministic catalog query or subset transform API. |
| `runValidations` | Executes existing validator kinds. There is no public per-step validator registration hook. Unknown kinds currently skip. |
| `registerAssertion` | Explicit process import; runs full-run hooks only. Does not repair standalone or stock CLI behavior. |
| `context` / `request` overrides | Permit caller-provided state and a request override, not verified fixture selection or globally portable authoring semantics. |
| `skip_controller_seeding` | Opt-out for externally prepared state; it does not establish fixture support, discovery evidence, or binding provenance. |

Hosted entry points currently use the same unmodified SDK:

- `server/src/routes/registry-api.ts` uses `comply(...)` for full assessments;
  its step route calls `runStoryboardStep` and forwards ordinary `context` only.
- `server/src/addie/mcp/member-tools.ts` calls full `runStoryboard` and standalone
  `runStoryboardStep`; its context-reference handling is not fixture binding.
- `server/src/conformance/run-storyboard-via-ws.ts` calls `runStoryboard` over an
  injected transport; it does not change fixture/extraction semantics.
- `server/src/services/hosted-compliance-version.ts` binds target/schema roots
  and auth test kits, not fixture preparation or collection normalization.

A local implementation can preserve the npm pin by using public `AgentClient`
calls to enumerate, validate, qualify and capture catalog state, then invoke
the SDK with explicit context/request overrides and external seeding opt-out.
However, this is **a second preparation/grading implementation**, not a small
adapter: it must reproduce pagination/error semantics, evidence, all-or-nothing
graphs, route/account/auth isolation, pinning and set validation. Custom
invariants still leave standalone parity missing unless all entry points gain
wrappers. Generic SDK/CLI consumers would not execute this local contract.

| Route | Benefit | Concrete risk / recommendation |
| --- | --- | --- |
| Upstream focused foundation | One contract and implementation for full, standalone, hosted and CLI consumers; reuses existing resolver. | Requires upstream review/release and later authorized adoption. Recommended; no dependency change now. |
| Local foundation preserving 15.9.5 | Could repair this hosted service without changing the pin. | Duplicated runner, public CLI divergence, session/evidence trust boundary, multiple hosted wrappers, unknown check fail-open. Larger practical scope; not recommended for the current qualification draft. |
| Local invariant only | Small set-comparison helper. | Full runs only; no applicability/capture/state solution, no standalone parity. Insufficient. |
| Broad match + skip / hardcoded illustrative IDs | Tiny YAML diff. | Proven hidden applicable paths or grading the wrong inventory. Reject. |

## Upstream ownership and sequencing

Read-only GitHub searches on 2026-10-19 found no open issue/PR specifically
covering `fixture_resolution` or collection fixture predicates. The original
foundation is [adcp-client#2456](https://github.com/adcontextprotocol/adcp-client/issues/2456),
closed, no current assignee; its history implements the intentionally closed
first slice for seed/discover products and scoped prices. The existing owner is
therefore the upstream SDK project/maintainers, not an open implementation PR
that should be duplicated. Recheck immediately before creating any upstream
work and coordinate with a newly discovered owner. No external message or issue
was posted by this analysis.

1. Review/approve the concrete focused contract (including carriage's
   wire-visible limits and full/standalone state scope) in the AdCP authoring and
   runner-output contracts. Clearly proposed language must not claim these are
   existing SDK primitives.
2. Open/coordinate one upstream foundation issue and implementation PR after
   authorization; implement/tests against those contracts. No server-only DSL.
3. Adopt an approved released SDK in a separate authorized dependency change.
   The current task keeps both manifest and lockfile untouched.
4. Rewrite collection storyboards as independent graphs using real selectors
   and pricing; retain rejection/readback checks, meaningful nonsupporting and
   supporting seller tests, and deliberate broken implementations.
5. Add the appropriate protocol changeset. Evaluate additive harness changes
   against patch eligibility, merge to main first, then prepare the 3.2.x
   backport. New seller capability fields are separately authorized future-minor work in
   [#8333](https://github.com/adcontextprotocol/adcp/pull/8333); none is added here. No release or immutable artifact edit occurs
   in this work.

## Reporting qualification shares part of this prerequisite

The independently reviewed source candidate is a held draft, not a shipping
reporting-only fix. Its actual-source/public-runner/hosted-disposition tests retain
these failures on SDK 15.9.5:

- A selected native fixed CPM option with `min_spend_per_package: 5000` may
  correctly reject the remaining illustrative budget 1000. Binding its pricing ID
  is insufficient. The proposed same-selection product/scoped-price snapshot
  must expose actual currency and minimum spend; construct a valid sandbox buy
  within an explicitly qualified commercial scope. Do not silently choose a new
  product after setup failure.
- An accepted package explicitly commits `time_based_views`; its commitment
  timestamp and final reporting window are mature. The candidate accepts a
  report omitting both the metric and its applicable `missing_metrics` entry.
  This false pass is a durable counterexample, not acceptable final grading.
  Reconcile the accepted `committed_metrics`, `committed_at`, reporting period,
  and declared measurement-window measurability. Follow the existing fallback
  to live product capabilities when no commitment snapshot exists. Require the
  canonical carrier or the applicable disclosure only when the current contract
  requires it. Do not turn product availability into unconditional observation
  requirements or invent thresholds, bases, maturation or grain injection.
- Public `runStoryboardStep` does not restore preparation. Any cross-step
  commitment/snapshot accounting must also preserve full/standalone parity.
- SDK request enrichment uses public `options.brand`/`brand_manifest` or defaults
  to `test.example`, overriding authored create brand. Targeted public full/step
  callers can configure existing `options.brand` from trusted caller/test-kit
  identity. `comply()` has one run-level brand; `routeStoryboard` does not offer
  a per-storyboard brand override and `AgentEntry` does not carry one. Qualify
  heterogeneous suites through explicit caller orchestration, not untrusted
  context/seller response mutation or a guessed new API.
- Raw discovery failures are synthetic `comply_test_controller` steps on this
  pin; hosted disposition currently projects them `setup_gap`. Retain the raw
  failure and exact current hosted disposition. This proposal changes no
  accounting/floors and must coordinate any correction through its owner.

Normative authority already exists for the commercial minimum and conditional
reporting disclosure: [CPM option](../../static/schemas/source/pricing-options/cpm-option.json),
[package commitment](../../static/schemas/source/core/package.json), and
[delivery response](../../static/schemas/source/media-buy/get-media-buy-delivery-response.json).
No new seller-wide requirement, capability, or controller refusal contract is
needed to explain these holds. The candidate checks applied format-sort metadata
on a bounded one-row request; it does not establish multi-row order or selection
from an unobserved larger population. Broader sort coverage needs a faithful
existing-contract implementation or a separately reviewed shared validation
prerequisite, not fabricated observations.

## Coordination and decision still required

The catalog-versus-declarations choice is **not being reopened**. Brian approved
catalog-based applicability with its explicit limitations and separately started
future-minor declarations, now draft #8333. Human/WG/path gates remain real.

Root located the existing Stable SDK CLI fixes workspace
`efec54f3-57cf-4d31-8908-56e193147e5c`, session
`b750f233-30f4-46b3-a930-a8ce537badfd`, and requested ownership confirmation and
read-only feasibility review. That is not an implementation assignment. Route
this contract through root and the confirmed fixture/runner owner; do not start
another SDK worker or source implementation here.

The exact next engineering decision is whether the confirmed SDK owner accepts
the focused matcher + same-selection captures/witnesses + shared namespace-set
validation + prepared-state parity contract (and the existing-field reporting
accountability/caller qualification work), or identifies a faithful smaller
existing public mechanism. Generic OR/relations and a local duplicate resolver
remain the alternatives and carry the risks above. No SDK/DSL implementation,
installer/shim, dependency adoption, publication or maintenance merge is authorized
by this review packet.

Maintenance compatibility is independently unqualified: the audited 3.2.x head
`71d877e69cf112128053cb38441e4a46f2f0fa40` pins SDK **14.0.0-rc.53**. These 19
public probes establish current main 15.9.5 behavior only. Do not upgrade the
maintenance dependency, copy main assumptions into a backport, or claim stable
compatibility without executing its real pinned runner and contracts.
