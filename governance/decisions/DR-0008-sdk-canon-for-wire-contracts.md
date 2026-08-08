---
id: DR-0008
title: Under spec ambiguity, shipping SDK behavior is canon for wire shape
class: normative
status: recorded
date: 2026-07-03
decided: ~2026-05
decided_by: maintainer practice
refs: []
dissent: none
---

## Decision

When the AdCP spec is ambiguous and a schema-literal reading diverges from what
`@adcp/client` (and peer SDKs) actually ship on the wire, the SDK behavior
wins: codify the SDK shape in the spec rather than migrating the SDK. This
applies to **wire shape only** — field names, types, envelope structure — not
to semantic contracts, where the spec's intent governs.

## Rationale

Production integrations are built against what SDKs emit. "Fixing" the SDK to
match a stricter reading of an ambiguous schema breaks working adopters to
satisfy a document that failed to be clear — the document is the defect.

## Implications

- The remedy for the ambiguity is always a spec clarification PR (and, if the
  clarified MUST fails the patch-eligibility test, it ships in the next minor).
- This record does not license SDKs to diverge from an *unambiguous* spec —
  that is an SDK bug.
