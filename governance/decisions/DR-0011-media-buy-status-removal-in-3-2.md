---
id: DR-0011
title: Remove the deprecated create/update media-buy status field in AdCP 3.2
class: breaking
status: ratified
date: 2026-08-15
decided: 2026-05-21
decided_by: maintainer approval
refs: ["#4895", "PR #4904", "#4906", "PR #6570"]
dissent: Protocol SemVer normally reserves field removal for a major release; this is a narrow migration exception.
---

## Decision

AdCP 3.2 removes the deprecated response-body `status: MediaBuyStatus` field
from synchronous `create_media_buy` and `update_media_buy` success payloads.
Those payloads use `media_buy_status` for lifecycle state, while root `status`
is reserved for the task envelope. The removal carries a minor changeset so it
lands in 3.2 after the enforced 3.1 migration window.

## Rationale

AdCP 3.1 added `media_buy_status`, deprecated the colliding lifecycle `status`,
and required the canonical field in compliance storyboards. Conformant sellers
therefore migrated before 3.2 even though the legacy field remained
schema-valid. Keeping both names for another full major would prolong ambiguous
generated types after the conformance gate had already completed the migration.

## Implications

- This is an explicit, one-field compatibility exception, not permission to
  remove other published fields in minor releases.
- Buyers and sellers spanning versions must negotiate the AdCP version and use
  legacy lifecycle `status` only for 3.0 or 3.1 responses.
- The nested status cascade tracked in #4905 remains a 4.0 change.
- Future same-major removals still require their own ratified decision record.
