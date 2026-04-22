---
---

Close the three-tier agent visibility blockers flagged in the PR #2793 review that landed before the review was addressed.

- **POST /api/me/member-profile (create) now runs the same tier gate as PUT.** A fresh profile containing `visibility: 'public'` on an Explorer-tier org was accepted verbatim, then filtered-through strictly without a tier re-check. Extracted the coercion into a shared helper (`agent-visibility-gate`), wired into both paths, now returns structured `warnings[]` on the create response too.
- **MCP `addAgent` now defaults to `members_only`** instead of `public`. Callers without an API-access tier could implicitly publish an agent via Addie, bypassing the explicit `/publish` tier check.
- **`applyAgentVisibility` re-reads the membership tier inside its transaction.** The outer `requireApiAccessTier` check is a fast-fail only; a concurrent Stripe downgrade committing between the outer read and the profile UPDATE would otherwise slip a `public` write past the gate.
- **`demotePublicAgentsOnTierDowngrade` now wraps the profile lock + update in a single transaction** with `SELECT ... FOR UPDATE`. Previously it read and wrote the profile as two statements, so a concurrent PATCH could reinsert a `public` entry between them. The two transactional guarantees together (apply + demote) mean a tier-gated publish and a tier downgrade can't interleave past each other's lock.

New unit tests cover the shared gate helper and the transactional demote path; existing enforcement tests were rewritten to exercise the new pg client contract. Full unit suite green (1811 pass).
