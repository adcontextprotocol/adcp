---
id: DR-0017
title: Seller dispositions are attributable audit records, not governance authority
class: normative
status: ratified
date: 2026-08-24
decided: 2026-08-24
decided_by: WG approval confirmed by Brian O'Kelley
refs: ["#6757", "PR #6794"]
dissent: No dissent was reported in the ratification confirmation
---

## Decision

A seller may decline an otherwise governed action under its own standing policy
and attribute that disposition with `POLICY_VIOLATION` using progressive
disclosure, including an optional seller origin and an opaque
`seller_policy_ref`. The buyer reports the failed interaction through the
existing `report_plan_outcome` path, and the governance audit retains the
bounded buyer-attributed error evidence.

This record grants no seller authority over the buyer's governance plan. Seller
internal automation, human review, escalation, and timing remain implementation
details.

## Rationale

An approved buyer action can still fail at the seller for independent content,
legal, or commercial reasons. Preserving an attributable failure explains why
execution did not occur without conflating seller policy with credentials,
account authorization, or buyer governance authority.

## Implications

`PERMISSION_DENIED` remains reserved for caller, credential, account-scope, or
signed-governance authorization failures. `ACTION_NOT_ALLOWED` identifies a
change outside negotiated or current rights. Reported failure evidence is
untrusted audit data: it is bounded, mutation-isolated, and excluded from
privileged prompts and governance decisions.
