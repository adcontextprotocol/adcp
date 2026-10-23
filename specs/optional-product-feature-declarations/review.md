# Proposal review and evidence

This record describes agent analysis, not human approval, WG ratification,
shipping implementation, hosted certification, or release qualification.
The decision memo remains `status: proposed`; the PR must remain draft/unmerged.

## Reproduce

From main base `c2f01a50f2133b016fc73ca74019c4c021f2256e`, with its existing
SDK 15.9.5 and lockfile:

```bash
node --test --test-timeout=30000 specs/optional-product-feature-declarations/probes.test.cjs
```

The isolated suite has **89 tests**, including all 256 independent proposed field subsets.
It compiles actual current product/selection/reporting schemas and the actual
immutable 3.2.5 feature schema for old-reader acceptance, without editing them.
Five tests execute the installed SDK: four small runner/gate probes with injected
clients and a controller dispatch probe, labeled with the actual runtime version.
The original three prove
equals-true gates hide absent declarations, and a legacy ungated execution path
continues to run and retain selected-path failures, and an old controller
returns `UNKNOWN_SCENARIO` without mutation for the proposed operation. They do not implement the
proposed routing or exercise production sellers.

The proposal model tests native-fixture qualification decisions, empty and
brief-only catalog routes, explicit false/no-claim behavior, missing harness
versus confirmed promised-operation violations, malformed declarations/setup,
independent feature combinations, catalog behavior plus separate preparation
evidence, and no whole-feature bypass through unsupported setup.

Concrete vectors cover selected subset, default materialization, fixed default
and exact restatement, fixed-subset refusal, unknown-owner and malformed-selector
rejection, dropped/widened readback, empty format arrays with mandatory companions,
empty contracted time arrays, arbitrary positive thresholds, and requested-metric
narrowing. These are schema-backed assertion oracles over isolated vectors,
not executed source storyboards or a new reference-seller implementation.

## Initial review synthesis (head `2b4908b2`)

The WG panel instructions require source-code, protocol and buyer/seller workflow
review. Three independent reviewers were run in one parallel batch, with
conceptual and end-to-end workflow checks. Findings retained here:

- **Protocol:** preserve boolean-only unknown feature keys and real released-ref
  loading; declare standardized true as the producer opt-in; keep catalog tests
  when the new runner contract is absent; separate missing adapter from seller
  transport failure; define retry keys consistently; specify seller-filter use.
- **Product/docs:** require a feature-eligible sandbox account without inferring
  entitlement; do not certify setup from a catalog pass; clarify shared filter
  semantics; add concrete selection/readback/reporting vectors; retain thresholds
  and empty observed arrays under current guarantees.
- **Code:** preserve independent commitment evidence when selected behavior fails;
  retain old-schema bounds; validate missing parent blocks; add mixed-catalog and
  missing-operation/harness combinations; no active changeset for nonoperative
  proposal assets.
- **Final code follow-up:** compile the complete format-package `allOf` so
  inherited metric types are validated, and reject a malformed-metrics vector.
  Clarify run-unique fixture IDs versus exact retries in the same principal/account
  namespace; isolation is across principals/accounts, not an unstated run identity.

Each finding above was addressed in the proposal and probes. Protocol and
product/docs reviewers found no remaining blocking/actionable findings for scoped
draft human review (independent 51/51 reruns before the three final negative/SDK
probes). The code reviewer inspected all eight final scoped files and independently
reran **54/54** probes plus `git diff --check`: **Ready to push**, with no blockers,
issues or nits. Normal precommit passed 79 unit files / 1260 tests, boundary suites
and typecheck; its server-unit scope check correctly skipped unrelated server
coverage. No full source-storyboard matrix or hosted implementation run is claimed.
No reviewer can approve
the normative field/fixture semantics for the WG or waive gated-path approval.

## Reconciliation with independent default coverage

The revised candidate adds a sixth proposed default-materialization field and
controller scope. One schema-valid distinct pair qualifies independently from
the two pairs required for genuine strict-subset selection. Six new probes
cover default-only coverage, a broken subset promise alongside a valid default,
all fixed/selectable one-pair modes, namespace-preserving normalization of
schema-valid redundant/empty IDs, and regrouping versus schema-invalid duplicate
selected objects, plus lossless ordering of schema-valid distinct IDs whose
UTF-8 replacement bytes tie. All 64 declaration subsets execute; generic per-feature probes
also cover the sixth scope. This is isolated evidence, not an SDK/DSL change.

The proposal now cites #8259 at `ce8a65d6bd192c105ef3175091f29c7f296e47b9`
and held reporting #8336 at `8ccc1d62194b9b8e2a9b8d3b2543b20d145f67f6`.
Upstream counts and reviews are explicitly owner/reviewer reports; this workspace
has not rerun those suites. The declared relation, same-selected snapshot,
protected write/delete/metadata funnel, alias-safe prepared state and authenticated
every-lookup grant/revocation requirements remain separately qualified foundation
surfaces. At that reconciliation, assignment was NONE RECORDED / unconfirmed;
root has since assigned the focused #8259 SDK implementation to workspace
`9bed7f0a-da60-44d8-a102-3586db378a8a`, session
`7d85de47-008e-484b-8f14-2601c34f5725`. This ownership update supersedes that status
only; no candidate source head has been reviewed or qualified by this proposal.
The metadata-only correction changes no field, fixture or model semantics.
Reporting IDs are
limited to the two actual-source reporting scenarios; new collection IDs remain
provisional. Green draft CI or counterexample tests do not qualify shipping.

Fresh independent protocol and product/docs reviews each reran **66/66** and
found no blocking/actionable findings in the scope correction. Final independent
code review inspected all seven changed files (the existing scoped workflow is
unchanged), corrected a schema-valid Unicode ordering edge case, and reran
**67/67**, zero failures/skips, plus `git diff --check`: **Ready to push**, with no
remaining findings. The new regression preserves distinct IDs when UTF-8
replacement bytes tie; it adds no schema restriction. The current isolated suite
passes 67/67 locally; new exact-head CI will be observed separately. These fresh
reviews support continued draft human review, not ratification or runtime safety.

## SDK API readiness and existing product-schema boundaries

The owner reported draft adcp-client #3354 public exports and disposable build
instructions, plus 13 limitations re-established on SDK main `1977a1ba` /
`16.0.0-beta.9` before implementation. The first source head was reported to
contain two confirmed security defects and is superseded. This workspace has
read PR metadata/API reports only, has not installed or executed that candidate,
and awaits the exact review-fix SHA before disposable candidate qualification.
Owner baseline/fixed-suite counts remain reports, distinct from local installed
15.9.5 evidence and the separate pristine 15.9.6 comparison.

Two new real-source-schema probes explicitly reject product `publisher_domains`
even alongside a singular domain, and domain-only collection entries even beside
a concrete otherwise-qualifying selector. Catalog and prepared setup failures
are retained; no fan-out or invalid-row salvage occurs. Local evidence is
**69/69**, including all 64 proposed declaration combinations. No field, controller,
model or SDK dependency implementation changed.

The API-readiness table is conditional on exact-head qualification and upstream
AdCP authoring/operator/capture/check-kind amendments. It preserves every-lookup
direct/opaque authority and process-local identity/host-grant boundaries. Native
qualified-offer binding for the future seller-wide commitment remains an
additional WG/controller/runner decision; the catalog foundation alone does not
implement it. Fresh independent protocol, product/docs and code reviewers each
reran **69/69**, with no blocking/actionable findings; final code review of the
three changed files also passed `git diff --check` and returned **Ready to push**.
None fetched, installed, executed or reviewed candidate SDK source. Prior review
results retain their explicitly recorded earlier scope. These reviews qualify
only the proposal packet, not SDK implementation safety or WG ratification.

## Reconciliation with settled #8428 source consumers (2026-10-23)

Read the exact qualification memo at #8428 head
`10e88cd4c68df8a9db3bc1ba6c79ceb61e52a8bd`, base
`3e94f5e376bae2911fe26373a8ff506908f1a765`. This workspace did not rerun its
actual-source/public/caller suite or take over catalog merge qualification.
#8259 is closed as superseded; #3354/#8376 are merged and the source package pin
is SDK16.3.0. Obsolete execution-capacity and provisional API notes are removed
from the current memo, retained above only as historical review context.

The current recommendation is eight proposed commitments: six independent core
collection scopes plus separate format/time. It separates one-pair fixed
restatement from two-pair fixed enforcement, and any-mode one-pair cross-publisher full-set restatement from selectable
two-total-pair cross-publisher subset. Provisional wire fields use structural
`cross_publisher_collection_*` names, while historical source IDs remain unchanged. The prior
unpublished fixed-bundle field is replaced; no public wire rename/alias occurs.
Optional reader companions stay tool-gated without new declarations. These are
recommendations to review, not requirements adopted by source scenario IDs.

The model now uses only the declared cross-publisher structure outside ALL
same-product property domains; no invented channel-kind/ownership witness.
New probes preserve small-path coverage under missing/broken larger promises,
local-plus-external subset eligibility and independent optional reader gates.
All 256 field combinations execute; **89/89 pass locally on SDK15.9.5**.
Probe labels/checks use the actual repository pin so a later merge-check run on
SDK16.3 reports its own evidence rather than claiming the legacy runtime. No
SDK/dependency/lock/bridge installation or change occurred here.

Fresh independent protocol, product/docs and code reviewers each reran
**89/89**, all 256 combinations, on installed SDK15.9.5, with clean diff checks.
A naming issue was resolved by using structural cross-publisher field/scope names
while retaining historical source-ID mappings. Final code review verified all
eight schema/controller/model cases agree: **Ready to push**, no remaining
findings. Eight fields are a defensible WG recommendation, not an adopted or
uniquely minimal wire design. No earlier 69-probe review is substituted for this
review. New exact-head CI must be observed independently. #8428 merge/source
duties and SDK #3395/#3396/#3397 defect triage remain with existing owners.

## Still required for adoption

The five normative choices at the end of the memo remain for humans/WG. Real
implementation needs source schema/docs/controller changes, SDK setup and evidence
support, current-source-storyboard qualification, hosted disposition integration,
minor changeset and assigned release train. The suite supplies no coverage for
real native adapter behavior, owner/host HTTPS authorization, fixture retry/TTL
implementation, production account eligibility, observed-grain injection, or a
3.2.x backport. Existing guards, baseline floors and release records are untouched.
