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
