---
"adcontextprotocol": patch
---

Server: fire badge issuance on owner-driven compliance runs.

The per-version badge fan-out (membership-org resolution + `processAgentBadges` loop across `SUPPORTED_BADGE_VERSIONS`) is extracted into a shared `runBadgeFanOut()` helper in `services/badge-issuance.ts`, and the two owner-driven paths now call it immediately after `recordComplianceRun`:

- `evaluate_agent_quality` (member-tools) — full comply runs from an agent owner.
- `POST /api/registry/agents/:url/storyboard/:storyboardId/run` — single-storyboard re-runs from the dashboard.

The helper reads the latest per-storyboard state from `agent_storyboard_status` (rather than trusting the run's own inputs), so a single-storyboard owner re-run doesn't degrade badges for storyboards it didn't touch.

Owner-facing impact: an owner who fixes a compliance issue and re-runs sees the badge update on the next page load instead of waiting up to a heartbeat cycle. Heartbeat behavior is unchanged — it still emits the verification-change Slack notification; owner paths skip the notify because the result is already delivered in chat / HTTP response.

Closes #4376.
