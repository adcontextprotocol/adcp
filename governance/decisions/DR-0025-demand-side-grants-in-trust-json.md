---
id: DR-0025
title: Demand-side acts-for grants live in trust.json, and a missing grant is a request-level denial
class: normative
status: ratified
date: 2026-10-12
decided: 2026-10-15
decided_by: lazy consensus on #6033 (objection window through 2026-10-15)
refs: ["#6033", "#8118", "PR #8119", "PR #8157", "PR #8169", "#7809"]
dissent: none recorded
---

## Decision

**Grants ship in 3.3.** Demand-side acts-for grants (#6033) ship in 3.3 as experimental `grants[]` entries in the grantor's trust.json.

**A missing grant is a request-level denial.** An acts-for claim no grant covers returns `PERMISSION_DENIED` with `error.details` `{ scope: "agent", reason: "grant_absent" }`, emitted only once the signer's identity is established. It never creates an account or changes an account's status.

**A withdrawn grant ends the agent's access, not the account.** Later calls from that agent fail with `grant_absent`; the account keeps its status, and its live buys stand.

How a seller evaluates a grant (which record authorizes, the chain, and the intersection) is `specs/agent-identity-3-3.md` R6.

## Rationale

A seller can verify who is calling but not who the caller may speak for, so an intermediary's `operator` claims were unfalsifiable at the boundary (#6033).

A grant published by the party making it is the only non-circular trust root. Putting it in trust.json follows #7809's split, under which brand.json becomes identity-only.

Treating a missing grant as a request-level failure keeps the authorization gate separate from the seller's commercial review (`pending_approval`). Ending only the agent's access keeps an operator's account and live buys intact when it changes agents.

## Implications

Delivered as P5 (#8118, PR #8169). It changes:
- `error-details/agent-permission-denied.json`: the new `reason` value `grant_absent`, and a description widened from provisioning constraints to per-agent gates generally. The `PERMISSION_DENIED` description and recovery text follow.
- `trust/v1/trust.json`: `valid_until` and `exclusive_grants` lose their "not enforced in 3.3" markers, and the `grant` description drops "brand.json is unchanged in 3.3" and points to the evaluation rules.
- `L2/accounts-and-agents.mdx`: the sentence that `authorized_operators` "does not model internal agency hierarchies" no longer holds, because a two-link chain models one agency hop. That page's §Grants in trust.json becomes the one normative home for evaluating grants.
- Which record authorizes: the brand's house record, found through the `house` (or reciprocated `house_domain`) pointer in the brand's brand.json, otherwise the brand's own domain. Exactly one record authorizes, so a brand's own record and its house's never compete.

It does not settle:
- the out-of-domain brand rule under an `open` onboarding mode (R7), which belongs to the onboarding-posture decision;
- signed grants or grant transparency, which wait for the 3.4 provenance work.
