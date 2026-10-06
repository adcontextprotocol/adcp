---
id: DR-0023
title: Failed mutations report their outcome on the error object, not a new code
class: normative
status: proposed
date: 2026-10-06
decided_by: pending WG ratification
refs: ["#7812", "DR-0021"]
dissent: product review preferred a dedicated error code (Option B in the PR description)
---

## Decision

For AdCP 3.3, `core/error.json` gains an optional, open-typed
`mutation_outcome` (`not_applied`, `unknown`, `applied`). It is independent of
`code` and `recovery`. Sellers declaring 3.3 or later in `supported_versions`
MUST set `unknown` (or `applied`) on the error for a fenced idempotency claim,
MUST NOT emit `unknown` without a fence, and MUST NOT set `not_applied` without
pre-commit evidence: a failure raised before the claim row was inserted and
before any write, or a typed rejection from validation that runs strictly before
the first write. A timeout or exception from within or after a write (including
an in-flight database write) is never pre-commit evidence. `COMMITTED_RESOURCE_PURGED`
SHOULD carry `applied` and MUST NOT carry `not_applied`. `unknown` on a compound
mutation covers the whole request envelope. Buyers MUST NOT re-plan after
`unknown` or `applied`, including on an async `failed` task, and SHOULD read
state before re-planning after an absent-field `transient` mutation error.
Receivers treat unrecognized values as `unknown`.

## Rationale

Whether a write landed is a separate question from why the request failed and
from what to do next; folding it into `code` loses the cause, and folding it
into `recovery` regresses older buyers, which treat unknown `recovery` values as
`terminal`. DR-0021 already requires sellers to fence ambiguous claims; this
gives buyers the matching machine-readable signal.

## Implications

Settles the field's location and semantics. Does not settle per-item outcomes
for partially applied compound mutations (3.4), nor any change to `recovery`
values or retry rules (4.0 if ever).
