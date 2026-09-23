---
id: DR-0021
title: Idempotency ledgers outlive committed resources for the declared replay window
class: normative
status: proposed
date: 2026-09-20
decided_by: pending WG ratification
refs: ["#7575"]
dissent: none reported; WG review pending
---

## Decision

For AdCP 3.2, a seller declaring idempotency support retains each committed
key record and canonical request hash independently of the created resource for
the full `replay_ttl_seconds`, measured from the successful mutation's durable
commit time. Independently deleting or purging the resource does not free the
key. A resource-row `UNIQUE` constraint alone is not conformant.

When a mutation commits but its affected resource is independently deleted or
purged before the seller can durably record a canonical success response, the seller returns
`COMMITTED_RESOURCE_PURGED` with terminal recovery and retains that
committed-outcome tombstone for the rest of the replay window. Equivalent
replays return the same outcome with `replayed: true` and without re-executing
the mutation. Successful requested delete operations do not use this code. `CONFLICT`
remains limited to transient concurrent modification.

An active handler lease may expire, but an ambiguous local or downstream
outcome does not release the idempotency claim. The seller retains the claim
and reconciles it to proven non-commit, cached success, or a committed-outcome
tombstone before it may invoke the mutation again.

When the canonical success response was already durably recorded, the normal
historical replay rule takes precedence and deletion does not replace that
cached response with an error.

## Rationale

The natural row-scoped implementation deletes its replay protection together
with the resource. A buyer following `CONFLICT`'s transient recovery then
re-executes a write that already committed, creating a second media buy or
other billable resource. Keeping the ledger independent preserves the declared
time-bounded at-most-once guarantee. A dedicated terminal code avoids giving
one code contradictory recovery classes and makes the committed write explicit
to buyers.

## Implications

Sellers need an independent response cache or committed-outcome tombstone, not
only an idempotency column on a resource row. Buyers receiving
`COMMITTED_RESOURCE_PURGED` do not retry automatically with either the same or
a fresh key; they reconcile through resource reads and seller audit or operator
records before deciding whether a new operation is intended.

This record does not ratify itself. The implementation PR is the ratification
vehicle. The record does not prescribe a database schema or require structured
error details for `COMMITTED_RESOURCE_PURGED`.
