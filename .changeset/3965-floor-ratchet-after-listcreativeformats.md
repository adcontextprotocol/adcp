---
---

ci(storyboards): ratchet floors up to capture #3976's lift on /creative and /creative-builder

#3976 wired `listCreativeFormats` on the v6 `/creative` and `/creative-builder` platforms but explicitly deferred floor changes to avoid conflict with #3974. Now that both have merged, raise the floors.

| Tenant            | #3974 floor | This PR | Delta |
|-------------------|-------------|---------|-------|
| /creative         | 56 / 69     | 64 / 79 | +8 clean / +10 passed |
| /creative-builder | 52 / 51     | 58 / 61 | +6 clean / +10 passed |

Files: `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh` (kept in sync per the existing pattern).

After this lands, /creative is at pre-bump baseline (was 58, now 64). /creative-builder is +3 over pre-bump (was 55, now 58). The remaining residue across all tenants is in Classes A (SDK gap, adcp-client#1455), C (predates the bump), and E (force_create_media_buy_arm — needs reproducer).

The ratchet pattern this PR exemplifies — multiple lower→raise cycles per cluster — is itself flagged as a meta-issue in #3977 (\"ratchet-only floors with explicit waivers instead of lower-then-raise\"). Out of scope for this PR; just noting the precedent.
