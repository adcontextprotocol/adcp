---
---

fix(training-agent): bump @adcp/sdk to 6.11.0, drop both KNOWN_FAILING_STEPS

6.11.0 ships the two SDK gaps surfaced after the #3965 cluster work — both filed and closed within hours of being identified:

- **adcp-client#1554** — `ctx.handoffToTask(fn, options)` now accepts `TaskHandoffOptions.task_id`. Lets the seller pass a caller-supplied task id through to the framework's submitted-arm projection (required by the `force_create_media_buy_arm` test directive).
- **adcp-client#1552** — the SDK's `simulate_delivery` dispatcher now spreads params verbatim, so extension fields like `vendor_metric_values` reach the seller's adapter instead of being silently dropped.

Wires both fixes:

- `v6-sales-platform.ts:createMediaBuy` detects the v5 handler's submitted-arm envelope (returned when `force_create_media_buy_arm` is set) and routes it through `ctx.handoffToTask(fn, { task_id })` with the directive's task_id. The handoff fn is a no-op-with-throw because the test directive only asserts on the immediate submitted envelope; production sellers register a real completion handler.
- Drops both `KNOWN_FAILING_STEPS` entries — both storyboards now pass cleanly with no skips.

Floor lifts (step counts move when previously-skipped steps now pass):

| Tenant            | Old | New | Delta |
|-------------------|-----|-----|-------|
| /sales            | 67 / 252 | 67 / 258 | flat / +6 |
| /governance       | 65 / 101 | 65 / 102 | flat / +1 |
| /creative         | 66 / 114 | 66 / 118 | flat / +4 |
| /creative-builder | 60 / 96  | 60 / 100 | flat / +4 |
| /signals          | 66 / 54  | 66 / 54  | flat |
| /brand            | 66 / 45  | 66 / 45  | flat |

All six tenants pass with zero failing steps and zero known-failing skips. The conformance suite is fully green on the framework path.

Files: `package.json`, `package-lock.json`, `server/src/training-agent/v6-sales-platform.ts`, `server/tests/manual/run-storyboards.ts`, `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh`.
