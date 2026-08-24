---
id: DR-0016
title: Accepted proposal terms bind buyer change rights
class: normative
status: ratified
date: 2026-08-24
decided: 2026-08-24
decided_by: WG approval confirmed by Brian O'Kelley
refs: ["#6750", "PR #6794"]
dissent: No dissent was reported in the ratification confirmation
---

## Decision

Post-acceptance buyer change rights are expressed in
`commercial_terms.change_terms[]` and covered by `terms_digest`. When the field
is present, its entries are the authorization ceiling: an omitted action is not
a negotiated right. Runtime `available_actions[]`, product templates, current
state, account authorization, and governance may narrow those rights but must
not broaden or replace them.

Each right carries a service mode, applicable states, elapsed-time SLA,
conditions, and typed constraints. Constraints and conditions fail closed when
they cannot be evaluated. A delegated caller may exercise a buy-bound right
only when the existing account authorization and signed governance checks also
admit that caller.

## Rationale

Separating accepted rights from current availability makes the commercial
agreement durable while preserving operational state projection. Binding the
complete array into the existing commercial digest prevents an advisory product
declaration from silently changing the accepted deal.

## Implications

Changing the rights requires a newly accepted proposal. Omission of the entire
field preserves legacy behavior. AdCP 3.2 uses `change_term_id` and
`seller_managed`; released 3.1 consumers receive the explicit compatibility
projection through `terms_ref` and `requires_approval`.
