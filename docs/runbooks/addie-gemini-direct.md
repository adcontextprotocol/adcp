---
title: Addie Gemini response provider
description: "Operate Addie's global Gemini response policy, emergency fallback, rollout, rollback, and historical experiment reporting."
"og:title": "AdCP — Addie Gemini response provider"
---

Gemini 3.7 Flash (`gemini-3.7-flash`) is the normal response provider for
authenticated and anonymous web, Slack DMs, mentions, thread continuations,
channel responses and reactions, MCP `chat_with_addie`, email conversations,
and Tavus voice/video. This includes existing web threads, saved control
assignments, certification, and requests previously assigned a precision/depth
model. Model selection does not grant tools or change a caller's permissions.

This is a response-provider migration. Internal classifiers, routers, sentiment
analysis, and background jobs can still use Luna, Haiku, or Sonnet. Slack and
Tavus retain their existing router-selected tool surface; web retains direct
authorized discovery without an up-front router. This is not a Gemini-only
migration of all AI calls.

Existing Anthropic initialization credentials remain required for the shared
clients, internal jobs, and rollback. Do not remove them as part of this rollout.

## Global policy and emergency fallback

| Setting | Application default | Behavior |
| --- | --- | --- |
| `ADDIE_RESPONSE_PROVIDER` | `gemini` | `gemini` selects Gemini for every user-facing response; `sonnet` is the global operator rollback. Other values fail closed. |
| `ADDIE_RESPONSE_AUTOMATIC_FALLBACK` | `false` | Only explicit `true` allows one emergency Sonnet attempt after a Gemini provider failure, before any action reservation attempt. |

The controls are independent. Missing Google credentials, an open Google circuit,
or a provider failure does not silently select Sonnet with fallback disabled.
With fallback enabled, the Sonnet attempt retains the request's permissions,
replay policy, cost scope, and iteration limit and passes normal cost admission.
Cost-cap refusal and local safety responses do not trigger fallback.

Once a mutation reservation is attempted, even if the write fails or its durable
outcome is uncertain, the turn can never restart on Sonnet. Streaming tool
receipts reach the delivery checkpoint before another provider step; checkpoint
failure stops execution. Text is buffered until the Gemini logical response is
accepted, so a pre-action fallback does not expose a discarded partial answer.
After action failure, normal channel recovery preserves durable outcomes and
does not automatically repeat the action. Existing retry receipt checks remain
in force.

The web model picker is disabled. Direct API requests selecting Sonnet receive
409 while Gemini policy is active; stale Gemini choices normalize to `default`.
Stored choices and provider badges on historical messages remain readable.
Operator rollback also overrides stale choices and saved assignments.

## Rollout

`fly.toml` sets the global provider to `gemini`, explicitly enables pre-action
emergency fallback with `ADDIE_RESPONSE_AUTOMATIC_FALLBACK=true`, and sets the
legacy authenticated/anonymous enrollment defaults to 100/100. The application
default remains `false` when this setting is absent. Production configuration
changes follow the normal reviewed, tested deployment workflow.
`ADDIE_GEMINI_DIRECT_MODE`, its percentages, and the anonymous surface switch
are historical experiment configuration: they no longer control response
execution or provide a rollback. Existing assignments are neither rewritten nor
used to keep a thread on Sonnet.

Before a separately approved production rollout, verify Google credentials and
provider health, inspect existing secret overrides of these policy settings,
and confirm the desired emergency-fallback setting. This PR does not deploy,
change production secrets, or run paid model evaluations. Keep the go/no-go
decision separate from merging and deploying.

Operators can roll every response channel back to Sonnet:

```sh
fly secrets set -a adcp-docs ADDIE_RESPONSE_PROVIDER=sonnet
```

Fly applies settings through a rolling restart. In-flight turns finish using
their snapshotted policy; requests on restarted workers use Sonnet. Neither
rollback nor restart authorizes replaying a reserved action. Restore normal
responses with `ADDIE_RESPONSE_PROVIDER=gemini`. Rollback needs a working
Anthropic credential and remains subject to Anthropic health and cost admission.

To enable emergency pre-action fallback while keeping Gemini primary:

```sh
fly secrets set -a adcp-docs ADDIE_RESPONSE_AUTOMATIC_FALLBACK=true
```

Set the fallback control back to `false` to stop automatic cross-provider
attempts. Setting enrollment percentages to zero or the old experiment mode to
`off` has no effect on this global policy.

## Treatment behavior

- Exact model: `gemini-3.7-flash`, low thinking, and 8,192 output tokens. Ten
  provider turns is a progress checkpoint rather than a terminal wall. A turn
  at the active boundary can earn one more tool-capable turn only when it
  completes a new successful tool and accumulated model/tool time remains
  below 60 seconds. At most six such turns are admitted. The loop then reserves
  one tool-disabled synthesis turn when any useful tool work exists, for a hard
  maximum of 17 provider turns at the default setting. Failed, denied, or
  duplicate calls do not earn tool-capable extensions. Native Google streaming
  retains signed continuation parts. A tool request at the synthesis boundary
  is blocked and logged as `addie_final_answer_tool_call_rejected`, separately
  from the generic undeclared-tool operator alert.
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
- Anonymous treatment retains the anonymous request's restricted tool surface,
  five-iteration base policy, rate limiter, cost scope, output validation, and
  JSON/SSE delivery behavior. Direct discovery can expose only tools already
  present with executable handlers on that request.
- Images and PDFs are passed to Google natively, including media returned by
  tools. Provider-managed Anthropic web search is not an Addie custom tool and
  is not exposed through Google's adapter; registered research/fetch tools are
  available through discovery.
- With automatic fallback explicitly enabled, provider errors may fall back to Sonnet before any action reservation. After
  an action is reserved, a provider error preserves the recorded receipts and
  stops the turn without replaying it on Sonnet. These are reported separately
  as `provider_error_fallbacks` and `post_action_provider_failures`.
- Both providers use normal production accounting and cost caps. Cap exhaustion
  never triggers a fallback that bypasses admission. The web response badge
  identifies provider-error fallback separately from the selected model.
- Saved tool results are historical text on later Gemini turns. Current-turn
  function calls retain the adapter's opaque Google signatures.
- Gemini's output allowance includes hidden thinking; it is not reduced to fit
  a character target. The shared application backstop is 32,000 characters and
  is not a Slack or provider maximum. If it fires, the response is cut at a safe
  Markdown boundary and explicitly offers continuation. Slack shapes delivery
  separately: streaming switches to a follow-up near 9,000 characters, and the
  follow-up is split into expanded 2,900-character Block Kit sections. Slack
  documents a 4,000-character recommendation and truncation above 40,000
  characters for top-level message text; section text is limited to 3,000
  characters. See
  [chat.postMessage](https://api.slack.com/methods/chat.postMessage) and the
  [section block reference](https://docs.slack.dev/reference/block-kit/blocks/section-block).

## Limit and incident diagnosis

The original ten-iteration default and 10,000-character output limit both date
to the first Addie security/client implementation (`342f20beb`, December 2025).
The output comment said only that 10,000 supported web-search responses; it did
not identify a Slack constraint. PR #517 (`b01deff35`) later added a 25-turn
admin allowance after bulk admin work stopped midway, while retaining ten for
ordinary traffic. PR #6929 (`732a79442`) moved the same value into the shared
provider-neutral loop without changing behavior. PR #6391 (`74cc1e02a`) made
the existing 10,000-character rule consistent across delivery paths and added
safe Markdown truncation/continuation, but did not establish it as a platform
ceiling.

For `gemini-3.7-direct-v2`, the metadata-only production audit covered 78
Gemini and 64 control turns. Gemini provider calls were p50 3, p95 8.3, max 10;
successful tools were p95 6.45, max 10; total latency was p50 7.58s, p95 28.09s,
max 50.71s. Control provider calls (including its router) were p50 3, p95 4,
max 5; total latency was p50 10.51s, p95 26.38s, max 31.94s. Gemini estimated
cost was p50 53,283 and p95 127,719 microdollars versus control 183,248 and
413,338. Four Gemini turns reached ten calls; two had nine successful tools and
two had ten. The reported terminal was therefore the local loop wall after ten
successful provider/tool rounds, not a Google tool-call limit.

The exact length incident reached six provider calls and five successful tools
in about 46.3s. `Output truncated due to length` is emitted only by the local
character validator. Provider exhaustion has separate `Response truncated:`
telemetry (Google `MAX_TOKENS` normalizes to the provider-output limit), and no
provider-limit flag appeared in the audited Gemini sample. Buffered logical
turns are validated before persistence and delivery, so this was not transport
or streaming loss. Length shaping now records `output_truncation.source` and a
specific diagnostic reason without setting the broad safety/failure flag.

## Gemini caching and model follow-up

Gemini Direct currently uses Google's automatic implicit caching only. The
adapter sends no explicit `cachedContent` resource and rejects portable cache
hints; Anthropic's `cache_control: ephemeral` behavior is intentionally not
projected onto Google. The stable core rules and stable tool reference are first
in the system instruction. Request-specific context follows them. Tool schemas
also remain stable across ordinary iterations, but intentionally change after
`load_tool_group` exposes another authorized schema, so that later prefix may
not reuse the same cache entry.

Google reports an implicit hit in `usage_metadata.cached_content_token_count`.
The adapter maps that value to `cacheReadTokens`; it does not invent a cache
write because implicit population has no explicit cache-write receipt or
storage lifecycle. Consequently, Gemini cache reads with zero cache writes are
expected. In the audited sample, 63 of 78 Gemini turns reported cache reads
(7,850,042 tokens total) and none reported writes. Explicit caching remains out
of scope: it is a beta/v1beta resource with TTL and storage lifecycle, and would
need separate authority and lifecycle design. Google's guidance says implicit
caching begins above a 4,096-token prefix and recommends putting repeated common
content first; see [context caching](https://ai.google.dev/gemini-api/docs/caching).

Google lists both 3.7 Flash and 3.8 Flash at introductory prices through
2026-12-31 of USD 0.75/M input, USD 3.75/M output, USD 0.075/M cached input, and
USD 0.50/M tokens/hour for explicit-cache storage; see
[Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). Gemini 3.8
Flash became GA on 2026-09-02. The repository has an exact, stable
`gemini-3.8-flash` evaluation cell; the model supports a 1,048,576-token input /
65,536-token output window. Google's guide describes its greater token use,
smaller reasoning steps, iterative tool calls, and verification as intended
behavior. Do not infer a silent model change from an exact endpoint without
provider evidence. See the
[3.8 guide](https://ai.google.dev/gemini-api/docs/latest-model),
[model specification](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
and [model version patterns](https://ai.google.dev/gemini-api/docs/models).

The repository contains sealed 3.7/3.8 fixed-trace and matched-v4 comparison
paths, but no safely discoverable persisted comparison was established during
this incident review. Do not run a paid comparison locally. It remains a
follow-up requiring the protected runtime-attestation workflow, an exact clean
reviewed head, one-use admission, immutable evidence custody, and spend-capped
provider credentials described in the
[matched-v4 authority runbook](./addie-matched-v4-private-authority.md). The
current repository explicitly has no provisioned paid runner, so this PR does
not switch production to 3.8.

## Results and review

The response-stage columns separate `pre_provider_ms` from provider and tool
time. Preparation is further split into member/context work (including WorkOS),
experiment/tool routing, relationship-analytics scheduling, and persistence /
delivery. Relationship sentiment and engagement writes run as shutdown-tracked
best-effort work after model admission has advanced; their processing time and
completed/failed outcome arrive asynchronously. Transaction-local pool, lock,
statement, and idle-in-transaction deadlines prevent identity merges from
holding a worker indefinitely. Authorization-bearing member and tool access
checks remain synchronous and fail closed. SSE clients receive a content-free
`status: {stage:"preparing_context"}` event when preparation exceeds 1.5s.

`call_adcp_task` failures now carry structured status, safe code/category,
retryability, operation, attempt count, and same-turn recovery state through
tool checkpoints. `recovered_tool_errors` and `unrecovered_tool_errors` should
be compared separately; do not parse Markdown result prefixes. A typed
`call_adcp_get_products` read surface makes the adapter's stable
idempotency-key and buying-mode contract machine-checkable without acquiring a
mutation reservation. One automatic retry is allowed only for typed transient
transport failures: reads (including `get_products`) may retry, while actual
mutations require both the exact existing valid idempotency key and their
durable pre-dispatch reservation. Validation, auth, protocol, application,
ambiguous unkeyed, and excessive Retry-After failures are never retried
automatically.

Historical experiment `gemini-3.7-direct-v2` remains separately reportable.
Global-policy web turns use `gemini-3.7-primary-v1` with
`assignment_version=global_gemini_v1` (or `global_sonnet_v1` during rollback).
They do not update thread assignment keys or historical manual choices and must
not be pooled into randomized experiment estimates. Anonymous policy telemetry
still uses the verified owner's HMAC, never the raw owner UUID or an IP address;
claimed anonymous threads retain the `auth_transition` identity cohort.

While signed in as a site admin, open
`https://agenticadvertising.org/api/addie/chat/experiment`.
The endpoint's `cohorts` retains historical results; `global_policy.cohorts`
contains the new population and `response_policy` exposes operator settings.
It reports users/turns, incomplete turns, failures, fallbacks, first visible
response time, median/p95 total time, router time, estimated cost, tool errors,
ratings, and marked resolutions. Results are grouped by surface, identity
cohort, assignment unit/version, arm, randomized/manual cohort, and exclusion
reason. Do not pool authenticated and anonymous estimates: their permissions,
base iteration budgets, cost scopes, and traffic mix differ.

Across all channels, `addie_response_provider` logs the snapshotted policy,
surface and final `model_execution`; `addie_response_provider_failure` records
fallback decisions and whether an action reservation was attempted. Thread
messages retain requested/actual provider provenance, and cost events retain
each provider's settled usage. MCP has no persisted transcript and uses these
content-free logs and cost events. Internal router costs remain separate.
Monitor Google circuit state, fallback frequency, post-reservation failures,
latency, cost, truncation, and actual provider separately by channel.

The durable turn record also contains delivery outcome, iteration count,
progress-extension count, final-answer-opportunity count, final-boundary
rejected-call count, structured recovered/unrecovered AdCP tool-error counts,
response-stage timing, and typed provider/local truncation fields. A null delivery
outcome means the adapter did not establish completion and must not be counted
as delivered.

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

After this terminal-boundary change, monitor `addie_tool_progress_extension`,
`addie_final_answer_opportunity`, `Max tool iterations reached`, local
`Output truncated due to length`, provider `Response truncated:`, provider-call
count, cost, and p95 total time separately by arm. Calls above ten should have a
new successful tool receipt and remain within the bounded time/extension policy.
Local and provider truncation are incomplete-output telemetry, not broad safety
failures. Stop or tighten the extension policy if high-percentile latency grows
materially; do not lower output tokens merely to suppress the local character
metric.

## Deployment

The pilot uses the ordinary application database and existing Gemini credential.
Leave the repository variable `ADDIE_MATCHED_V4_EVALUATOR_DEPLOY_ENABLED` unset or
`false` to deploy after the successful main build with paid evaluation disabled.
The ordinary release applies migration 586 and skips evaluator migrations 584
and 585. It explicitly replaces any prior evaluator admission settings.

The protected evaluator release path remains available with that variable set
to `true`; it requires the separate operator configuration described in the
[evaluator runbook](./addie-matched-v4-private-authority.md).
