---
title: Gemini 3.7 Direct web pilot
description: "Operate the Addie Gemini 3.7 Direct pilot, compare routing, latency, cost and outcomes, and roll back safely."
"og:title": "AdCP — Gemini 3.7 Direct web pilot"
---

Experiment `gemini-3.7-direct-v1` compares the existing web routing and response
stack (normally Haiku → Sonnet, with quick matches) against Gemini 3.7 without
an up-front router call. This measures the model and architecture together.

## Rollout

The runtime defaults to off. `fly.toml` selects the first stage, **staff**, on
deployment. It sends new site-admin conversations to Gemini; it is a delivery pilot,
not a randomized comparison. Existing conversations retain control. Once a
thread has an assignment, it persists across workers, restarts, and percentage
changes.

After reviewing staff outcomes, enable the randomized cohort:

```sh
fly secrets set -a adcp-docs ADDIE_GEMINI_DIRECT_MODE=eligible ADDIE_GEMINI_DIRECT_PERCENT=10
```

This assigns 10% of authenticated users to treatment in new conversations using
a stable user hash. The remaining eligible users are control. Staff-pilot and
pre-existing conversation cohorts remain separate in the results.

Rollback takes precedence over saved assignments:

```sh
fly secrets set -a adcp-docs ADDIE_GEMINI_DIRECT_MODE=off
```

Fly applies these settings through a rolling restart. In-flight turns finish;
subsequent requests on restarted workers use control. Set the mode back to
`staff` or `eligible` to resume saved assignments. `PERCENT=0` stops enrolling
new treatment conversations in eligible mode; use `MODE=off` for rollback.

## Treatment behavior

- Exact model: `gemini-3.7-flash`, low thinking, 8,192 output tokens, ordinary
  ten-step tool loop. Native Google streaming retains signed continuation parts.
- Documentation and schema tools start active. `load_tool_group` can load one
  additional authorized read-only group: industry research, community discussion,
  group discovery, or agent/publisher directory. Definitions and handlers must
  already be registered for the request. Loading a group grants no permissions.
- `handoff_to_addie` transfers unsupported work to the existing routed workflow
  without asking the user to repeat the request. Gemini cannot dispatch mutation
  handlers. Its spent time and settled usage remain attributed to treatment.
- Attachments, active certification, sponsored intelligence, interrupted-turn
  retries, and explicit GitHub creation requests use control. These turns retain
  their assigned arm and record an exclusion reason.
- Provider failure can fall back to control before any Gemini answer is
  delivered. Both providers use normal production accounting and cost caps.
  Cap exhaustion does not trigger a fallback that bypasses the cap.
- Saved tool results are historical text on later Gemini turns. Current-turn
  function calls retain the adapter's opaque Google signatures. Server-owned
  action receipts and mutation reservations stay on the existing control path.

## Results and review

While signed in as a site admin, open
`https://agenticadvertising.org/api/addie/chat/experiment`.
It reports users/turns, incomplete turns, failures, fallbacks, first visible
response time, median/p95 total time, router time, estimated cost, tool errors,
ratings, and marked resolutions, grouped by arm, cohort, and exclusion reason.

Timing starts at HTTP handler entry and includes context preparation, routing,
tool discovery, tool execution, provider continuations, fallback, and reply
persistence. Streaming answers remain buffered until the logical response is
accepted, as required by the existing receipt/delivery boundary. Estimates use
the live pricing registry and include router cache usage. Failed dispatches can
lack usage receipts: `incomplete_usage` exposes these cases; their cost is a
lower bound, not zero-cost success. Cost per marked resolution depends on manual
outcome coverage and should not be treated as a complete resolution rate.

`addie_chat_experiment_turns.assistant_message_id` links outcomes to existing
thread messages and feedback. Use the existing Addie conversation review view;
review a sample from each arm without model labels for correctness, useful
completion, unnecessary clarification, and unsupported success claims. Compare
eligible, non-excluded turns within the same cohort. Small staff samples establish
delivery readiness, not a quality or latency win.

Stop treatment for unauthorized actions or fabricated action confirmations.
Investigate repeated quality/error regressions or p95 total time more than 20%
worse than control. Expand into teaching or consequential actions only after
their permission, progress, and receipt workflows are checked independently.

## Release dependency found during implementation

As of 2026-09-10, main's existing Deploy workflow depends on successful protected
matched-v4 evaluator provisioning. Run `34478760809` failed because its database,
principal, and manifest inputs were empty; Deploy was skipped. The web experiment
uses the ordinary application database and existing Gemini credential, but cannot
activate until that release dependency is resolved. This change does not bypass
the protected workflow or provision another evaluator service.
