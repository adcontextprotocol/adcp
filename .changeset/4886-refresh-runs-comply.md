---
---

fix(compliance): `POST /api/registry/agents/{url}/refresh` now also re-runs the full compliance suite

Closes #4886. Prior to this change, `/refresh` probed capabilities + health via `crawler.refreshSingleAgent` but did NOT call `comply()` or update `agent_storyboard_status`. The dashboard verdict view kept showing whatever the periodic heartbeat last wrote (up to 12h stale), so adopters who fixed their agent and clicked "Refresh" saw no movement and concluded the cache was broken (e.g. fgranata's report: identical 72/128 verdict across 5+ runs over 7+ hours post-deploy).

What changed:
- After the existing capability/health probe in `/refresh`, when the caller owns the agent and the probe succeeded, the full storyboard suite runs via `comply()` (90s timeout) and results are persisted to `agent_storyboard_status` via `recordComplianceRun()` under `triggered_by: 'manual'`. The CHECK constraint on `valid_storyboard_triggered_by` already accepts `'manual'`.
- Badge fan-out (`runBadgeFanOut`) fires after a successful compliance run so verification badges reflect the new verdict immediately. Matches the per-storyboard owner-test path's pattern.
- Compliance failure is soft-fail: if `comply()` times out, returns `auth_required`, or throws, the capability/health snapshot still returns successfully and the response carries `compliance: { ran: false, error: "..." }`. The pre-existing 60s per-agent rate limit on `/refresh` is unchanged and bounds repeat-clicks.
- Response shape gains a `compliance` block with `ran` / `overall_status` / `storyboards_passing` / `storyboards_total` / `error`. Dashboard's existing "Recheck" button now appends `compliance: N/M` to the flash message so the operator sees the verdict update without leaving the page.

Server-only change; no spec/wire change for AdCP. OpenAPI doc updated to describe the new behavior and the response shape.
