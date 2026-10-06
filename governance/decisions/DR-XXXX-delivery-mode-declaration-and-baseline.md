---
id: DR-XXXX
title: Sellers declare their delivery modes; compliance gates non-guaranteed flows and grades guaranteed-only sellers on a sibling baseline
class: normative
status: proposed
date: 2026-10-06
decided_by: pending WG ratification
refs: ["#7852"]
dissent: none reported; WG review pending
---

## Decision

Sellers declare the product delivery modes they sell in
`media_buy.supported_delivery_types` (`guaranteed`, `non_guaranteed`; absent
means both). A seller MUST NOT list products of an undeclared mode and MUST
reject a `create_media_buy` for one with `UNSUPPORTED_FEATURE`.

The `media_buy_seller` baseline, and each inherited scenario that creates buys
on non-guaranteed fixtures, is gated on `non_guaranteed` being declared. A
seller that declares a set without it is graded on the sibling baseline
`media_buy_seller_guaranteed` (submitted create, controller-forced completion,
`get_task_status` polling, `get_media_buys` readback, delivery reporting). A run
whose approval controller is missing grades those steps `missing_test_controller`
and is not a complete grade.

## Rationale

The baseline's follow-on checks need a `media_buy_id` issued in the create
response; a guaranteed buy defers it to task completion. The runner selects one
baseline per protocol, so an additive sibling alone cannot replace the base for
a guaranteed-only seller: the seller would still be graded on the base. A
declaration plus applicability gates is the smallest change that lets the runner
pick the right baseline without a runner or schema-engine change, because the
runner already resolves schema defaults for absent capability values.

## Risks and preconditions

- **Fail-closed default.** The gates rely on the runner resolving the schema default for an undeclared seller. The runner does that only when the capabilities response has a `media_buy` object and the schema root it loads carries this field. A seller with no `media_buy` block, or a bundle paired with an older schema root, grades the gated storyboards `not_applicable` and the guaranteed baseline does not run either. The decision therefore requires that the compliance bundle and schema ship together and that sellers emit a `media_buy` block. Applying defaults when the parent object is absent is an SDK change tracked separately. This is a blocking risk if shipped.
- **Reduced coverage.** `not_applicable` is no coverage. A guaranteed-only seller's result is a profile with reduced coverage, not equivalence with the non-guaranteed baseline. A subset declaration is also an incentive to dodge scenarios; the guaranteed baseline checks the listing half of the declaration, the reject-on-create half is attestation-only.
- **Gates are temporary.** Every delivery-mode gate is tagged `TEMPORARY(adcp#7852)` and is removed when the scenario is made delivery-mode aware (Option B). Compound gates use `requires_all_capabilities`, which fails closed when the raw capabilities response is missing, where a single gate fails open.
- Declaration is seller-wide, not per product.

## Implications

- Undeclared sellers see no change; the schema default is both modes.
- Adapting every inherited scenario to be delivery-mode-aware (so a
  guaranteed-only seller regains their coverage) is deferred. Gated scenarios
  give a guaranteed-only seller no coverage until then.
- A new `incomplete` skip reason for a missing approval controller, and a
  per-step polling budget for human-latency approvals, are runner-output-contract
  and SDK concerns and are not decided here.
- No delivery-mode-specific error code is introduced; `UNSUPPORTED_FEATURE` is
  used. Whether a dedicated code is warranted is left open.
