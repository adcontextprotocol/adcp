---
---

fix(server): treat all-silent comply tracks as passing, not degraded (closes #4065)

The `@adcp/sdk/testing` `comply()` function returns `overall_status: 'partial'` when every
track is `'silent'` (all scenarios passed with no advisory observations — the best possible
outcome). The server mapped `'partial'` → `ComplianceStatus: 'degraded'`, causing the
compliance dashboard to show "Degraded" for fully-clean agents.

**Root cause:** `complianceResultToDbInput()` called `mapOverallStatus(result.overall_status)`
which blindly forwarded the SDK's `'partial'` to the DB. `computeStatus('partial')` then
returned `'degraded'`.

**Fix:** Added `effectiveRunStatus()` which checks whether all active (non-skip) tracks are
`'pass'` or `'silent'` before falling through to `mapOverallStatus`. When all tracks are
passing/silent, it overrides to `'passing'` and zeroes out `tracks_partial` so the stored
run record stays consistent.

**Frontend:** Track pills in `agents.html` and `dashboard-agents.html` (card view and history
panel) mapped `'silent'` to the skip CSS class (gray). Fixed to use the pass class (green) in
all four locations.

**Secondary gap (not fixed here):** `member-tools.ts:3533` records
`overall_passed: result.overall_status === 'passing'` using the raw SDK string, which stays
`'partial'` for all-silent runs. The `quality_evaluation` test-run record will incorrectly
store `overall_passed: false` until a follow-up PR fixes `evaluate_agent_quality`'s
`recordTest` call. Tracked as a known gap.

**Downstream effects of the fix (correct behavior):**
- Streak accumulation now works for all-silent agents (`streak_days` advances correctly)
- `last_passed_at` is now set on all-silent heartbeats (was NULL, blocking badge eligibility)
- Compliance notifications no longer false-fire for agents with clean-but-silent runs
