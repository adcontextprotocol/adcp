---
id: DR-0033
title: Every minor-release change states its pathway to the previous minor of the same major (withdrawn)
class: normative
status: superseded
date: 2026-11-09
decided: 2026-11-09
decided_by: WG session 2026-11-09
refs: ["PR #8519", "PR #8704", "DR-0032"]
superseded_by: PR #8704  # the rules under "What can change in a release" in docs/reference/versioning.mdx
dissent: none recorded
---

## Decision

Withdrawn before ratification. This record holds no rule, and its ID is not
reused.

PR #8519 proposed that every change in a minor release state its pathway back
to the previous minor. The WG adopted the versioning rules of PR #8704 instead.

## Rationale

If a minor only adds, there is no pathway back to state. The additive-minor
check already proves the structural half in CI. What a reviewer still has to
judge is rule 4 of PR #8704: a minor never adds a field to a mutating request
if an older seller that ignores it would commit to something different.

## Implications

- Cite `docs/reference/versioning.mdx`, not this record.
- The `LADON.md` checks and the constitution invariant that PR #8519 proposed
  are not adopted.
- The proposed text stays on PR #8519.
