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

The isolated suite has **54 tests**, including all 32 independent feature subsets.
It compiles actual current product/selection/reporting schemas and the actual
immutable 3.2.5 feature schema for old-reader acceptance, without editing them.
Three tests execute the real pinned SDK: two runner probes with injected clients
and an old controller dispatch probe. They prove
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

## Independent review synthesis

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

## Still required for adoption

The five normative choices at the end of the memo remain for humans/WG. Real
implementation needs source schema/docs/controller changes, SDK setup and evidence
support, current-source-storyboard qualification, hosted disposition integration,
minor changeset and assigned release train. The suite supplies no coverage for
real native adapter behavior, owner/host HTTPS authorization, fixture retry/TTL
implementation, production account eligibility, observed-grain injection, or a
3.2.x backport. Existing guards, baseline floors and release records are untouched.
