---
id: DR-0033
title: Every minor-release change states its pathway to the previous minor of the same major
class: normative
status: proposed
date: 2026-10-22
refs: ["#8373", "#8501", "DR-0024", "DR-0032", "DR-0036"]
dissent: none recorded
---

> **Revised 2026-11-02 against DR-0036.** First proposed on 2026-10-22 and parked at WG Session C pending #8501. DR-0036 now forbids additions to closed schemas within a major, so the "identity-bearing" form is gone: such a change waits for a major.

## Decision

A minor release is non-breaking **and** backward compatible: an SDK on the new minor must still be able to reach a counterpart on any earlier minor of its major. So every Normative or Breaking change targeting a minor states, in the PR that introduces it, how it maps to the previous minor of the same major: 3.3 to 3.2 now, and 4.1 to 4.0 later. That covers each new or changed field, enum value, task, union variant, requiredness and semantic rule.

The statement takes exactly one of these forms:

1. **Ignorable.** The change is on an open schema, and a peer on the previous minor can ignore it without committing to anything different: a label, a hint, a description, or a read filter whose absence only broadens results. SDKs drop it for older peers and report the drop (DR-0032).
2. **Gated.** The change is on an open schema, and a peer that ignores it would commit to something different: it limits or changes spend, targeting, caps, bidding, creative activation, measurement or account settings. Name the refusal SDKs apply on a mutation, and the capability flag, if any, a sender checks before sending it.
3. **Moves.** It has an exact equivalent in the previous minor: a renamed field, a restructured block, a narrower enum. Give the mapping in both directions where both exist.
4. **Correction.** It is a DR-0036 correction to a closed schema. Name the spec text it restores. A correction accepts only what that text already required, so it needs no translation.

New tasks keep using the manifest's `added_in` and `legacy_fallback`; SDKs refuse a task the counterpart's release doesn't define (DR-0032).

**Not allowed in a minor:** additions to or removals from a closed schema other than a recorded correction (DR-0036), and changes to account or resource identity or to idempotency keys. Those wait for the next major.

Each stated pathway ships with its cross-version conformance case, or with a tracked follow-up when the case for that pair isn't ready.

Reviewers (Ladon and the expert seats) treat a minor-release schema or normative-doc change with no stated pathway as a `high` finding.

## Rationale

SDKs can only translate what the spec has defined how to translate. When a change ships without a pathway, every SDK invents one, and they disagree on exactly the calls that move money. DR-0036 makes an older peer ignore new fields rather than reject them, which makes the gated case the one that matters: without a statement, nobody knows whether a silently ignored field changes what was bought. Stating the pathway at design time costs one paragraph. Reverse-engineering it after release cost the 3.2 cycle an account-identity break (DR-0032) and the 3.3 cycle a triage of 57 fields (#8501).

## Implications

- Applies to every change targeting a minor release from adoption onward, on 3.x now and on each later major's own minors from 4.1. A major release (4.0) is where breaking changes land, and cross-major bridging stays `VERSION_UNSUPPORTED`.
- The 3.3 dispositions from #8501 (moves, deferrals, corrections) serve as the pathway statements for 3.3's closed-schema changes. The remaining 3.3 changes state their pathway before GA.
- A change whose only honest pathway is "gated" is still allowed. The statement makes the cost visible, so reviewers can weigh an ignorable design the constitution prefers.
