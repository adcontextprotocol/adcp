---
id: DR-0020
title: Targeting null-clear commands exist only on mutation requests
class: breaking
status: proposed
date: 2026-09-13
decided_by: pending WG ratification
refs: ["#6832"]
dissent: none reported in issue triage; WG review pending
---

## Decision

AdCP 3.2 mutation requests use a request-only Targeting Input with three states
for every targeting dimension: omission inherits the product default on create
or leaves stored state unchanged on update; `null` suppresses that default on
create or clears stored state on update; and a non-null value replaces the
complete dimension. Sellers apply the supplied dimensions atomically or reject
the request.

`null` is a command, not targeting state. Discovery criteria, configured
products, accepted commercial snapshots, mutation responses, and package
readback continue to use strict Targeting Overlay and MUST NOT contain null.
After a successful clear, the cleared dimension is absent from effective
readback unless inherent product scope still supplies a non-null constraint.

## Rationale

The prior shared schema required every targeting collection to be non-empty,
so a buyer could replace a dimension but could not distinguish clearing it from
omitting it. Re-admitting empty arrays would make `[]` alternate between a clear
command and an empty match set across systems, and would weaken discovery and
response contracts. A request-only null union follows the protocol's existing
null-clear convention for bidding and budget controls without allowing command
sentinels into durable state.

The wire shape is additive, but changing an omitted nested dimension from
“remove” to “preserve” changes previously documented update behavior. The
record is therefore Breaking and is proposed only for the unreleased 3.2 line.

## Implications

Established `create_media_buy` and `update_media_buy` inputs and compact
`buy_products` and `control_media_buy` inputs use Targeting Input. Shared compact
purchase input and accepted-snapshot shapes are split so code generation can
represent nullable request dimensions without making response types nullable.
Every successful mutation returns strict non-null effective targeting.

This record does not ratify itself. Until human/WG approval changes its status
and decision provenance, the schema and prose in the same PR are a proposed 3.2
contract. External SDKs must preserve the three states in generated input types
and in version projections; that implementation work is not evidence of WG
ratification.

For released 3.0 and 3.1 peers, adapters must obtain authoritative effective
targeting and project a complete post-state replacement; a local write cache is
not sufficient authority. Released 2.5 can represent a geographic clear only
where its explicit empty-list form has the same meaning, and cannot represent
3.2 audience include/exclude clears. Missing authoritative state or an inexact
legacy representation requires rejection before dispatch.
