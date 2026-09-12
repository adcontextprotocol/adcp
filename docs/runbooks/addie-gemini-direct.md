---
title: Gemini 3.7 Direct web pilot
description: "Operate the Addie Gemini 3.7 Direct pilot, compare routing, latency, cost and outcomes, and roll back safely."
"og:title": "AdCP — Gemini 3.7 Direct web pilot"
---

Experiment `gemini-3.7-direct-v2` compares the existing web routing and response
stack (normally Luna → Sonnet, with quick matches) against Gemini 3.7 without
an up-front router call. Both use the same authorized Addie custom-tool domains and
shared action executor. This measures the model and tool-discovery architecture
together. Version 2 reports separately from the earlier read-only pilot; the
assignment key and user hash remain unchanged to preserve existing assignments.

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
- Documentation, schema, baseline tools, and authorized admin analytics start
  active. `load_tool_group` selects another authorized Addie domain, including
  member actions, escalation management, billing, and agent storyboards. Loading
  a group grants no permissions: the existing role and request-bound handlers
  determine access. Hidden compatibility aliases are not advertised.
- Admin escalation tools remain available alongside other domains. Admin tools
  require both the trusted role and an executable request-local registration;
  a global tool name alone never grants admin access.
- There is no capability handoff tool. Certification, sponsored intelligence,
  interrupted-turn retries, and explicit GitHub creation stay on Gemini when
  selected. Trusted active workflows retain the same scoped tools as Sonnet.
- Both models use the shared action executor, confirmation and receipt checks,
  durable mutation reservations, duplicate suppression, and retry policy. Each
  completed tool result reaches the delivery checkpoint before another action.
  A failed checkpoint stops continuation.
- Images and PDFs are passed to Google natively, including media returned by
  tools. Provider-managed Anthropic web search is not an Addie custom tool and
  is not exposed through Google's adapter; registered research/fetch tools are
  available through discovery.
- Provider errors may fall back to Sonnet before any action reservation. After
  an action is reserved, a provider error preserves the recorded receipts and
  stops the turn without replaying it on Sonnet. These are reported separately
  as `provider_error_fallbacks` and `post_action_provider_failures`.
- Both providers use normal production accounting and cost caps. Cap exhaustion
  never triggers a fallback that bypasses admission. The web response badge
  identifies provider-error fallback separately from the selected model.
- Saved tool results are historical text on later Gemini turns. Current-turn
  function calls retain the adapter's opaque Google signatures.

## Results and review

While signed in as a site admin, open
`https://agenticadvertising.org/api/addie/chat/experiment`.
It reports users/turns, incomplete turns, failures, fallbacks, first visible
response time, median/p95 total time, router time, estimated cost, tool errors,
ratings, and marked resolutions, grouped by arm, cohort, and exclusion reason.

Timing starts at HTTP handler entry and includes context preparation, routing,
tool discovery, tool execution, provider continuations, fallback, and reply
persistence. Answer text remains buffered until the logical response is
accepted; tool receipts are checkpointed immediately. Estimates use
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
worse than control. The regression suite covers native escalation actions, role boundaries, trusted
teaching scope, reservation failures, duplicate suppression, checkpoint failures,
and provider failure after an action.

## Deployment

The pilot uses the ordinary application database and existing Gemini credential.
Leave the repository variable `ADDIE_MATCHED_V4_EVALUATOR_DEPLOY_ENABLED` unset or
`false` to deploy after the successful main build with paid evaluation disabled.
The ordinary release applies migration 586 and skips evaluator migrations 584
and 585. It explicitly replaces any prior evaluator admission settings.

The protected evaluator release path remains available with that variable set
to `true`; it requires the separate operator configuration described in the
[evaluator runbook](./addie-matched-v4-private-authority.md).
