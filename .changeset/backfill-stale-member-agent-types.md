---
---

Backfill stale `type` values in `member_profiles.agents` JSONB. PR #3498's `resolveAgentTypes()` only runs on writes, so rows saved before the fix never get re-evaluated. Adds a one-shot script (`server/scripts/backfill-member-agent-types.ts --dry-run` first) that walks every member profile and writes back any agent whose stored type disagrees with the snapshot's inferred type. Also tightens the crawler's type-update policy: promote when stored is missing/`unknown`, log on disagreement, never auto-flip a known-good row from a single probe. `resolveAgentTypes` is now exported from `member-profiles.ts` so the script can reuse it. Refs #3538.
