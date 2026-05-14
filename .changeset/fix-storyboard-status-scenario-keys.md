---
---

Rewrites `deriveStoryboardStatuses` to read SDK 6.x's storyboard-keyed scenarios. `comply()` emits `result.tracks[].scenarios[].scenario` as `<storyboard_id>/<phase_id>` (one per phase), but the old implementation walked YAML steps' `comply_scenario` fields and looked up bare names like `signals_flow` / `capability_discovery` — every lookup missed, so `testedCount === 0` skipped every storyboard. Net effect: zero rows in `agent_storyboard_status` have ever been written by the compliance heartbeat. The dashboard's "X passing / Y total" was structurally `0 / N` across the registry, every declared specialism was `untested`, and the AAO Verified badge pipeline silently stopped issuing.

New implementation groups scenarios by storyboard id, rolls per-step pass counts up from each phase's `steps` array (with phase-level fallback when steps are absent), and supports the existing `storyboardIds` override for explicit-IDs callers that need an untested entry when the runner didn't run a requested storyboard. Surfaced by escalation #329 — Evgeny's agent was passing 30/30 scenarios but showing `degraded` because the storyboard counts never updated.
