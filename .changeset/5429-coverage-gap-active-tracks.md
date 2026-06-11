---
---

fix(compliance): don't degrade an all-pass run when an active track carries step-level controller-gated skips

`effectiveRunStatus()`'s coverage-gap guard (added in #5328) checked every track, including active (`pass`/`silent`) ones. A single-protocol agent (e.g. signals-only) legitimately skips the universal `track: core` pagination storyboards — which carry `requires: [controller]` — with skip reason `missing_test_controller`. Those expected step-level skips set the coverage-gap flag and suppressed the all-pass → `passing` promotion, so a fully-passing agent (every executed scenario green) was rendered `degraded`.

Narrow the guard to track-level-skipped tracks (`status === 'skip'`), matching the intent of #5328 (surface gaps where a whole track was gated out) without penalizing active tracks that merely contain expected controller-gated step skips. The per-track `has_coverage_gap_skip` field is unchanged, so the gap is still surfaced — it just no longer degrades an otherwise all-pass run.

Adds a regression test for the active-track case.

Fixes #5429. Regression of #5328; prior art #4065.
