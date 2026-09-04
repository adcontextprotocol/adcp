---
id: DR-0019
title: Closed row schemas are a deliberate class; optional additions to them are minor
class: normative
status: recorded
date: 2026-09-04
decided: ~2026-09 (practice operative since 3.0)
decided_by: maintainer practice
refs: ["#7224", "PR #7177", "#7150", "DR-0009"]
dissent: none recorded; #7224 leaves open whether current practice is design or drift (B. Masse, Triton) — options B/C there may supersede this record in 3.3
---

## Decision

DR-0009's default stands: AdCP schemas are `additionalProperties: true` unless
this record permits otherwise. `additionalProperties: false` is permitted only
on a **row or arm schema** that meets both conditions:

1. Its consumers join, reconcile, or dispatch on its keys — metric rows
   (`vendor-metric-value`, `delivery-metric-aggregate`), contract entries
   (`committed-metric`, `missing-metric`, `canonical-reporting-commitment`),
   qualifier objects, forecast dimensions, and discriminated `oneOf` arms —
   so an unknown key is a correctness hazard for the join, not merely noise.
2. It provides an explicit open escape hatch for extension: `ext`, a
   `breakdown`/payload slot marked `x-adcp-open-payload`, or an equivalent
   documented slot. A closed schema with no escape hatch is a defect.

Response roots, capability blocks, and container objects stay open.

Consequences, stated so they can be applied without argument:

- **Adding an optional field to a closed schema is a `minor` change**, never a
  patch, because strict validators on the prior version reject payloads that
  carry it. PR authors declare the `minor` changeset and cite this record;
  reviewers do not relitigate.
- **Loosening a closed schema to open is Normative**, non-breaking, and must
  name this record and the unknown-key lint that replaces the validation the
  closed schema provided.
- **Tightening an open schema remains Breaking** per DR-0009.

## Rationale

DR-0009 states the default but the tree does not follow it: 239 of 968 source
schemas are closed at the top level, concentrated in the reporting and metric
row family. That is not accidental — `vendor-metric-value.json` says in its own
description that extras belong in `breakdown`, and the conformance runner
relies on closed rows to surface unknown keys as errors (canonical-fixture
validation; the `product_id`/`proposal_id` mutual-exclusion fixtures assert on
the "must NOT have additional properties" message). Re-deciding this on every
PR that adds an optional field to a row (#7177 being the latest) is the pattern
a decision record exists to end.

## Implications

- Settles the rule for 3.2. It does **not** settle #7224 options B (open the
  row family) or C (open everything), which remain 3.3 candidates; either
  would supersede this record and must cost the unknown-key lint replacement.
- Does not certify that every one of the 239 closed schemas meets both
  conditions above. An audit against condition 2 (escape hatch present) is a
  follow-up; schemas that fail it get an `ext` slot, not an open envelope.
- The `@adcp/sdk` codegen strips `additionalProperties: true` before type
  generation, so this record's choices affect wire validation and conformance
  only, not generated TypeScript types.
