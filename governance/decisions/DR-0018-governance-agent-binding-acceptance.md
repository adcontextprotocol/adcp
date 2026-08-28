---
id: DR-0018
title: Sellers may constrain governance-agent bindings at account sync
class: normative
status: ratified
date: 2026-08-24
decided: 2026-08-24
decided_by: WG approval confirmed by Brian O'Kelley
refs: ["#6758", "PR #6794"]
dissent: No dissent was reported in the ratification confirmation
---

## Decision

Sellers may publish advisory governance-agent acceptance criteria under the
cross-role `adcp.governance_enforcement` capability. Criteria use a typed
`any_of` union of exact canonical agent-URL matchers and deterministic trusted
registry-verification matchers. The `sync_governance` result is authoritative
for the account and rejects an unacceptable candidate with
`GOVERNANCE_AGENT_NOT_ACCEPTED`.

Rejection details may be opaque or disclosed. Disclosed details expose only the
parsed HTTPS origin and applicable criteria, never the submitted URL or its
credentials. A rejected endpoint is neither contacted nor persisted. A
verification dependency that cannot be resolved produces retryable
`GOVERNANCE_UNAVAILABLE`, not a definitive rejection.

## Rationale

A bound governance agent becomes a seller dependency for authorization and
recovery, so sellers need a deterministic binding-time trust decision. The
cross-role capability fits sellers that enforce governance without themselves
implementing the governance protocol, while typed matchers make permissive OR
semantics explicit.

## Implications

Absent a declaration, otherwise valid bindings remain accepted. Later policy or
registry changes do not retroactively invalidate a binding; an explicit
resynchronization creates a new decision. Eligibility criteria must be
objective and non-discriminatory and must not become a commercial exclusion
mechanism.
