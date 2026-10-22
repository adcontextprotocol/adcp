---
id: DR-0033
title: Every 3.x protocol change states its pathway to the previous minor release
class: normative
status: proposed
date: 2026-10-22
refs: ["#8373", "DR-0032", "DR-0024"]
dissent: none recorded
---

## Decision

Every Normative or Breaking change on the 3.x line states, in the PR that introduces it, how it maps to the previous minor release. That covers each new or changed field, enum value, task, union variant, requiredness and semantic rule. The statement takes exactly one of these forms:

1. **Droppable.** Older counterparts never see it, and nothing else changes. For a request field on a mutating task, say also whether dropping it changes what the seller commits to; if it does, the downgrade is a refusal (form 3).
2. **Moves.** It has an exact equivalent in the previous release (a renamed field, a restructured block, a narrower enum). Give the mapping, both directions where both exist.
3. **Refused.** The previous release cannot express it, and an SDK must refuse rather than send a different meaning. Name the error.
4. **Identity-bearing.** It changes account identity, resource identity or idempotency keys. Treat it as Breaking, and state the reduction and migration rule (see [DR-0032]).

New tasks keep using the manifest's `added_in` and `legacy_fallback`. The pathway also covers the reverse direction: how a server reads the previous release's payload in the new shape.

Each stated pathway ships with its cross-version conformance case, or with a tracked follow-up when the conformance harness for that pair is not ready.

Reviewers (Ladon and the expert seats) treat a 3.x schema or normative-doc change with no stated pathway as a `high` finding.

## Rationale

SDKs can only translate what the spec has defined how to translate. When a change ships without a pathway, every SDK invents one, and they disagree on exactly the calls that move money. Asking at design time costs one paragraph; reverse-engineering it after release cost the 3.2 cycle an account-identity break ([DR-0032]) and a set of response shapes older validators reject ([DR-0024]).

## Implications

- Applies to every change targeting a 3.x release from adoption onward; existing 3.2 and 3.3 changes are backfilled through the conformance cases in [DR-0032].
- A change whose only honest pathway is "refused" is still allowed. The record makes the cost visible, so reviewers can weigh the additive alternative the constitution prefers.
- 4.0 is out of scope: cross-major bridging stays `VERSION_UNSUPPORTED` by design.

[DR-0024]: ./DR-0024-responses-conform-to-served-release.md
[DR-0032]: ./DR-0032-sdks-translate-between-releases.md
