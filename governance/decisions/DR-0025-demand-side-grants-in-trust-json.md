---
id: DR-0025
title: Demand-side acts-for grants live in trust.json, and a missing grant is a request-level denial
class: normative
status: ratified
date: 2026-10-12
decided: 2026-10-12
decided_by: WG working session 2026-10-12
refs: ["#6033", "#8118", "PR #8119", "#7809"]
dissent: none recorded
---

## Decision

**Grants ship in 3.3.** Demand-side acts-for grants (#6033) ship in 3.3 as experimental `grants[]` entries in the grantor's trust.json. They are read from the grantor's document only and never carry keys.

**Which record authorizes.** At `sync_accounts`, the authorizing record is the brand's own record, or its house record when it has one.
- **Implicit authority:** when `account.operator`, the brand, and the signer's operator share a registrable domain, authority is implicit.
- **Otherwise a grant chain must reach the signer's operator** with a scope covering the operation. Either the brand grants the signer's operator directly, or the brand grants `account.operator`, which grants the signer's operator.
- **`account.operator` MUST be on the chain.**
- **No extension:** a grantee never extends a grant it received. Effective authority is the intersection of brands, countries, scopes, and the earliest `valid_until` along the chain.

**Absence and fallback.**
- `exclusive_grants: true` opts a grantor in to fail-closed. Without it, an uncovered claim is at the relying party's discretion: its own onboarding records, never the grantor's brand.json.
- A fetch failure is never absence.
- A 200 from the grantor's trust.json disables brand.json `authorized_operators[]`. Through 3.x, brand.json stays a valid source when there is no trust.json.

**Freshness.** Grants are checked at `sync_accounts`, re-derived at least as often as the revocation polling interval, and re-checked before a spend-committing call when the cached result is older than that.

**Unauthorized acts-for claim.** It returns `PERMISSION_DENIED` with `error.details` `{ scope: "agent", reason: "grant_absent" }`, emitted only once the signer's identity is established. It is a request-level authorization failure; it never creates an account or changes an account's status.

**Withdrawn grant.** It ends the agent's access, not the account: later calls from that agent fail with `grant_absent`, the account keeps its status, and its live buys stand.

## Rationale

A seller can verify who is calling but not who the caller may speak for, so an intermediary's `operator` claims were unfalsifiable at the boundary (#6033).

A grant published by the party making it is the only non-circular trust root. Putting it in trust.json follows #7809's split, under which brand.json becomes identity-only.

Treating a missing grant as a request-level failure keeps the authorization gate separate from the seller's commercial review (`pending_approval`). Ending only the agent's access keeps an operator's account and live buys intact when it changes agents.

## Implications

The design is `specs/agent-identity-3-3.md` R6 and is delivered as P5 (#8118). The `grant_absent` reason is a new value in `error-details/agent-permission-denied.json`.

Under an `open` onboarding mode, a missing grant for a brand outside the buyer's operator domain is a deny (R7). That rule belongs to the onboarding-posture decision, not this one.
