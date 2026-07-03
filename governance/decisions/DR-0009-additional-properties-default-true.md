---
id: DR-0009
title: Published schemas default additionalProperties:true; tightening is policy-wide
class: breaking
status: recorded
date: 2026-07-03
decided: ~2026-04
decided_by: maintainer practice
refs: []
dissent: none
---

## Decision

AdCP JSON Schemas default to `additionalProperties: true`. Published schemas
are durable contracts: adding `additionalProperties: false` to a published
variant rejects payloads that previously validated, so tightening is a
**breaking, policy-wide decision** — never a per-variant or per-PR edit.

## Rationale

Openness by default lets implementations carry extensions and lets the
protocol add optional fields in minors without invalidating existing traffic.
Piecemeal tightening creates a patchwork where identical extension behavior is
legal in one schema and a validation error in its sibling.

## Implications

- PRs that tighten `additionalProperties` on any published schema are
  Breaking-class regardless of diff size (Argus MUST FIX list already blocks
  this as spec drift).
- A future policy-wide strictness proposal is legitimate — as a single
  WG-ratified decision with a major version and migration notes.
