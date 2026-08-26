import { createHmac, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { query as defaultQuery } from '../db/client.js';
import { ModelConfig } from '../config/models.js';
import { costUsdMicros } from './claude-pricing.js';
import {
  InvalidModelEventStreamError,
  collectModelResponse,
} from './model-providers/events.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  PreparedModelInvocation,
} from './model-providers/model-provider.js';
import {
  UnexpectedModelIdentityError,
  UnsupportedModelCapabilityError,
} from './model-providers/model-provider.js';
import {
  OPENAI_ROUTER_MODEL,
  OpenAIResponsesProvider,
} from './model-providers/openai-responses-provider.js';
import {
  RouterPlanParseError,
  extractRouterResponseText,
  parseStrictRouterPlan,
  type RouterModelObservation,
  type StrictRouterPlan,
} from './router.js';

export const ROUTER_SHADOW_POLICY_VERSION = 'addie-router-luna-shadow:v1';
export const ROUTER_SHADOW_PRICING_VERSION = 'openai-gpt-5.6-luna-2026-08-26';
export const ROUTER_SHADOW_PRIMARY_PRICING_VERSION = 'anthropic-router-2026-08';
export const ROUTER_SHADOW_MIN_COMPARISON_SAMPLES = 30;
export const ROUTER_SHADOW_RETENTION_DAYS = 8;
export const ROUTER_SHADOW_TIMEOUT_MS = 120_000;
export const ROUTER_SHADOW_MAX_REQUEST_BYTES = 65_536;

// Official standard pricing checked 2026-08-26:
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// The rollout also requires a budget gate so a stale price pin stays bounded.
const LUNA_INPUT_MICROS_PER_TOKEN = 0.2;
const LUNA_OUTPUT_MICROS_PER_TOKEN = 1.2;
export const ROUTER_SHADOW_RESERVED_COST_MICROS = Math.ceil(
  ROUTER_SHADOW_MAX_REQUEST_BYTES * LUNA_INPUT_MICROS_PER_TOKEN
  + 300 * LUNA_OUTPUT_MICROS_PER_TOKEN,
);

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>;

export type RouterShadowSelectionReason =
  | 'selected'
  | 'disabled'
  | 'production_data_not_approved'
  | 'invalid_configuration'
  | 'private_channel'
  | 'shared_channel'
  | 'channel_not_allowlisted'
  | 'sample_excluded';

interface RouterShadowConfig {
  hmacKey: string;
  hmacKeyVersion: string;
  openAiApiKey: string;
  channelId: string;
  sampleBps: number;
  dailyLimit: number;
  dailyBudgetMicros: number;
}

export interface RouterShadowSelection {
  selected: boolean;
  reason: RouterShadowSelectionReason;
}

export interface RouterShadowCohortInput {
  channelId: string;
  opportunityId: string;
  channelIsPublic: boolean;
  channelIsShared: boolean;
}

type RouterShadowEnvironment = Record<string, string | undefined>;

function parseBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function digest(key: string, purpose: string, value: string): string {
  return createHmac('sha256', key)
    .update(`${ROUTER_SHADOW_POLICY_VERSION}\0${purpose}\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

/** Pure, fail-closed selection; it never logs or persists production IDs. */
function resolveRouterShadowCohort(
  input: RouterShadowCohortInput,
  env: RouterShadowEnvironment = process.env,
): RouterShadowSelection & { config?: RouterShadowConfig } {
  if (env.ADDIE_ROUTER_LUNA_SHADOW_ENABLED !== 'true') {
    return { selected: false, reason: 'disabled' };
  }
  if (env.ADDIE_ROUTER_LUNA_SHADOW_PRODUCTION_DATA_APPROVED !== 'true') {
    return { selected: false, reason: 'production_data_not_approved' };
  }
  if (!input.channelIsPublic) return { selected: false, reason: 'private_channel' };
  if (input.channelIsShared) return { selected: false, reason: 'shared_channel' };

  const channels = (env.ADDIE_ROUTER_LUNA_SHADOW_CHANNEL_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const hmacKey = env.ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY?.trim();
  const hmacKeyVersion = env.ADDIE_ROUTER_LUNA_SHADOW_HMAC_KEY_VERSION?.trim();
  const openAiApiKey = env.OPENAI_API_KEY?.trim();
  const sampleBps = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_SHADOW_SAMPLE_BPS,
    1,
    10_000,
  );
  const configuredDailyLimit = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_SHADOW_DAILY_LIMIT,
    1,
    100,
  );
  const dailyBudgetMicros = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_SHADOW_DAILY_BUDGET_MICROS,
    ROUTER_SHADOW_RESERVED_COST_MICROS,
    10_000_000,
  );
  if (
    channels.length !== 1
    || !/^C[A-Z0-9]{8,}$/.test(channels[0] ?? '')
    || !hmacKey
    || hmacKey.length < 32
    || !hmacKeyVersion
    || !/^[A-Za-z0-9._:-]{1,64}$/.test(hmacKeyVersion)
    || !openAiApiKey
    || sampleBps === null
    || configuredDailyLimit === null
    || dailyBudgetMicros === null
    || !input.channelId
    || !input.opportunityId
  ) {
    return { selected: false, reason: 'invalid_configuration' };
  }
  if (channels[0] !== input.channelId) {
    return { selected: false, reason: 'channel_not_allowlisted' };
  }

  const sample = digest(
    hmacKey,
    'sample',
    `${input.channelId}\0${input.opportunityId}`,
  );
  const bucket = Number.parseInt(sample.slice(0, 8), 16) % 10_000;
  if (bucket >= sampleBps) return { selected: false, reason: 'sample_excluded' };

  const budgetSlots = Math.floor(dailyBudgetMicros / ROUTER_SHADOW_RESERVED_COST_MICROS);
  const dailyLimit = Math.min(configuredDailyLimit, budgetSlots);
  if (dailyLimit < 1) return { selected: false, reason: 'invalid_configuration' };
  return {
    selected: true,
    reason: 'selected',
    config: {
      hmacKey,
      hmacKeyVersion,
      openAiApiKey,
      channelId: channels[0],
      sampleBps,
      dailyLimit,
      dailyBudgetMicros,
    },
  };
}

export function selectRouterShadowCohort(
  input: RouterShadowCohortInput,
  env: RouterShadowEnvironment = process.env,
): RouterShadowSelection {
  const { selected, reason } = resolveRouterShadowCohort(input, env);
  return { selected, reason };
}

type TerminalReason =
  | 'valid_plan'
  | 'daily_limit_reached'
  | 'request_too_large'
  | 'invalid_json'
  | 'schema_invalid'
  | 'refusal'
  | 'truncated'
  | 'incomplete'
  | 'empty'
  | 'timeout_after_dispatch'
  | 'unexpected_model_identity'
  | 'invalid_provider_event_stream'
  | 'unsupported_provider_capability'
  | 'provider_error'
  | 'internal_error';

type TerminalStatus = 'succeeded' | 'invalid' | 'error' | 'not_dispatched';

interface TerminalEvidence {
  status: TerminalStatus;
  reason: TerminalReason;
  shadowPlan?: StrictRouterPlan;
  returnedModel?: string;
  actionMatch?: boolean;
  toolSetsMatch?: boolean;
  confidenceMatch?: boolean;
  depthMatch?: boolean;
  emojiMatch?: boolean;
  privilegeAttempt?: boolean;
  invalidToolSetAttempt?: boolean;
  requestHmac?: string;
  outputHmac?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

type PrimaryStatus =
  | 'valid_plan'
  | 'invalid_json'
  | 'schema_invalid'
  | 'plan_mismatch'
  | 'refusal'
  | 'truncated'
  | 'incomplete'
  | 'empty'
  | 'missing_dispatch_snapshot'
  | 'unexpected_model_identity'
  | 'invalid_provider_event_stream'
  | 'unsupported_provider_capability'
  | 'provider_error';

interface PrimaryEvidence {
  status: PrimaryStatus;
  plan?: StrictRouterPlan;
  canonicalRequestHmac: string;
  providerRequestHmac?: string;
  outputHmac?: string;
  estimatedCostMicros?: number;
}

class RouterShadowBoundaryError extends Error {
  constructor(readonly category: 'request_too_large' | 'internal_error') {
    super(category);
    this.name = 'RouterShadowBoundaryError';
  }
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function canonicalTools(plan: StrictRouterPlan): string[] | null {
  return plan.action === 'respond' ? [...(plan.tool_sets ?? [])].sort() : null;
}

function plansMatchProduction(
  strict: StrictRouterPlan,
  production: RouterModelObservation['productionPlan'],
): boolean {
  if (strict.action !== production.action) return false;
  if (strict.action === 'react') {
    return production.action === 'react' && strict.emoji === production.emoji;
  }
  if (strict.action !== 'respond' || production.action !== 'respond') return true;
  return canonicalTools(strict)?.join('\0') === [...production.tool_sets].sort().join('\0')
    && strict.confidence === production.confidence
    && Boolean(strict.requires_depth) === Boolean(production.requires_depth);
}

function classifyPrimaryObservation(
  observation: RouterModelObservation,
  hmacKey: string,
): PrimaryEvidence {
  const canonicalRequestHmac = digest(
    hmacKey,
    'canonical-request',
    stableJson(observation.canonicalRequest),
  );
  const providerRequestHmac = observation.primaryInvocation
    ? digest(
        hmacKey,
        'primary-provider-request',
        stableJson(observation.primaryInvocation.providerRequest),
      )
    : undefined;
  const outputHmac = observation.finishReason !== null
    ? digest(hmacKey, 'primary-output', stableJson(observation.responseContent))
    : undefined;
  const estimatedCostMicros = observation.inputTokens !== null
    && observation.outputTokens !== null
    ? costUsdMicros(observation.requestedModel, {
        input_tokens: observation.inputTokens,
        output_tokens: observation.outputTokens,
        cache_read_input_tokens: observation.cacheReadTokens ?? undefined,
        cache_creation_input_tokens: observation.cacheWriteTokens ?? undefined,
      })
    : undefined;
  const base = {
    canonicalRequestHmac,
    providerRequestHmac,
    outputHmac,
    estimatedCostMicros,
  };

  if (observation.primaryErrorCategory) {
    return { ...base, status: observation.primaryErrorCategory };
  }
  if (!observation.primaryInvocation) {
    return { ...base, status: 'missing_dispatch_snapshot' };
  }
  if (observation.finishReason === 'refusal') return { ...base, status: 'refusal' };
  if (observation.finishReason === 'length') return { ...base, status: 'truncated' };
  if (observation.finishReason === 'continue' || observation.finishReason === 'tool_calls') {
    return { ...base, status: 'incomplete' };
  }
  if (!observation.rawResponseText?.trim()) return { ...base, status: 'empty' };
  try {
    const plan = parseStrictRouterPlan(observation.rawResponseText, observation.isAdmin);
    return {
      ...base,
      status: plansMatchProduction(plan, observation.productionPlan)
        ? 'valid_plan'
        : 'plan_mismatch',
      plan,
    };
  } catch (error) {
    return {
      ...base,
      status: error instanceof RouterPlanParseError ? error.category : 'schema_invalid',
    };
  }
}

function comparePlans(primary: StrictRouterPlan, shadow: StrictRouterPlan) {
  const bothRespond = primary.action === 'respond' && shadow.action === 'respond';
  return {
    actionMatch: primary.action === shadow.action,
    toolSetsMatch: bothRespond
      ? canonicalTools(primary)?.join('\0') === canonicalTools(shadow)?.join('\0')
      : undefined,
    confidenceMatch: bothRespond
      ? primary.confidence === shadow.confidence
      : undefined,
    depthMatch: bothRespond
      ? Boolean(primary.requires_depth) === Boolean(shadow.requires_depth)
      : undefined,
    emojiMatch: primary.action === 'react' && shadow.action === 'react'
      ? primary.emoji === shadow.emoji
      : undefined,
  };
}

function estimateCostMicros(inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    inputTokens * LUNA_INPUT_MICROS_PER_TOKEN
    + outputTokens * LUNA_OUTPUT_MICROS_PER_TOKEN,
  );
}

async function beginAttempt(input: {
  attemptId: string;
  sourceBindingHmac: string;
  primary: PrimaryEvidence;
  observation: RouterModelObservation;
  config: RouterShadowConfig;
  now: Date;
  query: QueryFn;
}): Promise<'claimed' | 'duplicate' | 'daily_limit_reached'> {
  const retainedUntil = new Date(
    input.now.getTime() + ROUTER_SHADOW_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  await maintainRouterShadowAttempts({ query: input.query, now: input.now });
  const result = await input.query<{ attempt_id: string }>(
    `WITH attempt AS (
       INSERT INTO addie_router_shadow_attempts (
         attempt_id, policy_version, pricing_version, hash_key_version,
         status, requested_model, primary_provider, primary_pricing_version,
         primary_requested_model,
         primary_returned_model, primary_status, primary_finish_reason, primary_action,
         source_binding_hmac, canonical_request_hmac,
         primary_provider_request_hmac, primary_output_hmac,
         primary_input_tokens, primary_output_tokens,
         primary_cache_read_tokens, primary_cache_write_tokens,
         primary_latency_ms, primary_estimated_cost_micros,
         reserved_cost_micros, selected_at, retained_until, quota_date, quota_slot
       )
       SELECT
         $1, $2, $3, $4, 'running', $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
         $23, $24, $25,
         ($24::timestamptz AT TIME ZONE 'UTC')::date, candidate
       FROM generate_series(1, $26::integer) AS candidate
       ORDER BY candidate
       ON CONFLICT DO NOTHING
       RETURNING attempt_id
     ), admission AS (
       INSERT INTO addie_router_shadow_daily_admissions (
         admission_date, policy_version, pricing_version, primary_pricing_version,
         hash_key_version, requested_model, primary_requested_model,
         sampled_count, claimed_count, retained_until
       )
       SELECT ($24::timestamptz AT TIME ZONE 'UTC')::date,
              $2, $3, $7, $4, $5, $8, 1, COUNT(*)::bigint, $25
       FROM attempt
       ON CONFLICT (
         admission_date, policy_version, pricing_version, primary_pricing_version,
         hash_key_version, requested_model, primary_requested_model
       ) DO UPDATE SET
         sampled_count = addie_router_shadow_daily_admissions.sampled_count + 1,
         claimed_count = addie_router_shadow_daily_admissions.claimed_count
           + EXCLUDED.claimed_count,
         retained_until = GREATEST(
           addie_router_shadow_daily_admissions.retained_until,
           EXCLUDED.retained_until
         )
       RETURNING 1
     )
     SELECT attempt_id FROM attempt
     WHERE EXISTS (SELECT 1 FROM admission)`,
    [
      input.attemptId,
      ROUTER_SHADOW_POLICY_VERSION,
      ROUTER_SHADOW_PRICING_VERSION,
      input.config.hmacKeyVersion,
      OPENAI_ROUTER_MODEL,
      input.observation.requestedProvider,
      ROUTER_SHADOW_PRIMARY_PRICING_VERSION,
      input.observation.requestedModel,
      input.observation.returnedModel,
      input.primary.status,
      input.observation.finishReason,
      input.primary.plan?.action ?? null,
      input.sourceBindingHmac,
      input.primary.canonicalRequestHmac,
      input.primary.providerRequestHmac ?? null,
      input.primary.outputHmac ?? null,
      input.observation.inputTokens,
      input.observation.outputTokens,
      input.observation.cacheReadTokens,
      input.observation.cacheWriteTokens,
      input.observation.latencyMs,
      input.primary.estimatedCostMicros ?? null,
      ROUTER_SHADOW_RESERVED_COST_MICROS,
      input.now,
      retainedUntil,
      input.config.dailyLimit,
    ],
  );
  if (result.rows.length > 0) return 'claimed';

  // A fresh READ COMMITTED snapshot distinguishes a same-source winner from
  // genuine quota exhaustion after any unique-conflict wait has completed.
  const existing = await input.query<{ duplicate: boolean }>(
    `WITH classification AS (
       SELECT EXISTS (
         SELECT 1 FROM addie_router_shadow_attempts WHERE source_binding_hmac = $1
       ) AS duplicate
     ), recorded AS (
       UPDATE addie_router_shadow_daily_admissions admission
       SET duplicate_count = duplicate_count + CASE WHEN classification.duplicate THEN 1 ELSE 0 END,
           quota_exhausted_count = quota_exhausted_count
             + CASE WHEN classification.duplicate THEN 0 ELSE 1 END
       FROM classification
       WHERE admission.admission_date = ($2::timestamptz AT TIME ZONE 'UTC')::date
         AND admission.policy_version = $3
         AND admission.pricing_version = $4
         AND admission.primary_pricing_version = $5
         AND admission.hash_key_version = $6
         AND admission.requested_model = $7
         AND admission.primary_requested_model = $8
       RETURNING classification.duplicate
     )
     SELECT duplicate FROM recorded`,
    [
      input.sourceBindingHmac,
      input.now,
      ROUTER_SHADOW_POLICY_VERSION,
      ROUTER_SHADOW_PRICING_VERSION,
      ROUTER_SHADOW_PRIMARY_PRICING_VERSION,
      input.config.hmacKeyVersion,
      OPENAI_ROUTER_MODEL,
      input.observation.requestedModel,
    ],
  );
  if (existing.rows.length === 0) throw new RouterShadowBoundaryError('internal_error');
  return existing.rows[0]?.duplicate ? 'duplicate' : 'daily_limit_reached';
}

/** Scheduled and opportunistic recovery keeps selected/terminal counts honest. */
export async function maintainRouterShadowAttempts(
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<{ recovered: number; purged: number }> {
  const runQuery = dependencies.query ?? defaultQuery as QueryFn;
  const now = dependencies.now ?? new Date();
  const result = await runQuery<{ recovered: string; purged: string }>(
    `WITH stale AS (
       UPDATE addie_router_shadow_attempts
       SET status = 'error', reason = 'stale_interrupted', completed_at = $1,
           completion_hmac = NULL
       WHERE status = 'running'
         AND selected_at < $1 - INTERVAL '15 minutes'
         AND retained_until > $1
       RETURNING attempt_id
     ), purged AS (
       DELETE FROM addie_router_shadow_attempts WHERE retained_until <= $1
       RETURNING attempt_id
     ), purged_admissions AS (
       DELETE FROM addie_router_shadow_daily_admissions WHERE retained_until <= $1
       RETURNING admission_date
     )
     SELECT (SELECT COUNT(*)::text FROM stale) AS recovered,
            ((SELECT COUNT(*) FROM purged)
              + (SELECT COUNT(*) FROM purged_admissions))::text AS purged`,
    [now],
  );
  return {
    recovered: Number.parseInt(result.rows[0]?.recovered ?? '0', 10),
    purged: Number.parseInt(result.rows[0]?.purged ?? '0', 10),
  };
}

async function markDispatched(
  attemptId: string,
  requestHmac: string,
  now: Date,
  runQuery: QueryFn,
): Promise<void> {
  const result = await runQuery(
    `UPDATE addie_router_shadow_attempts
     SET provider_request_hmac = $2, dispatched_at = $3
     WHERE attempt_id = $1 AND status = 'running' AND dispatched_at IS NULL`,
    [attemptId, requestHmac, now],
  );
  if (result.rowCount !== 1) throw new RouterShadowBoundaryError('internal_error');
}

async function completeAttempt(input: {
  attemptId: string;
  evidence: TerminalEvidence;
  primary: PrimaryEvidence;
  observation: RouterModelObservation;
  sourceBindingHmac: string;
  selectedAt: Date;
  dispatchedAt?: Date;
  config: RouterShadowConfig;
  now: Date;
  query: QueryFn;
}): Promise<void> {
  const boundedCompletion = {
    attemptId: input.attemptId,
    status: input.evidence.status,
    reason: input.evidence.reason,
    shadowAction: input.evidence.shadowPlan?.action ?? null,
    actionMatch: input.evidence.actionMatch ?? null,
    toolSetsMatch: input.evidence.toolSetsMatch ?? null,
    confidenceMatch: input.evidence.confidenceMatch ?? null,
    depthMatch: input.evidence.depthMatch ?? null,
    emojiMatch: input.evidence.emojiMatch ?? null,
    privilegeAttempt: input.evidence.privilegeAttempt ?? false,
    invalidToolSetAttempt: input.evidence.invalidToolSetAttempt ?? false,
    primaryStatus: input.primary.status,
    primaryFinishReason: input.observation.finishReason,
    primaryAction: input.primary.plan?.action ?? null,
    primaryRequestedModel: input.observation.requestedModel,
    primaryReturnedModel: input.observation.returnedModel,
    primaryCanonicalRequestHmac: input.primary.canonicalRequestHmac,
    primaryProviderRequestHmac: input.primary.providerRequestHmac ?? null,
    primaryOutputHmac: input.primary.outputHmac ?? null,
    primaryInputTokens: input.observation.inputTokens,
    primaryOutputTokens: input.observation.outputTokens,
    primaryCacheReadTokens: input.observation.cacheReadTokens,
    primaryCacheWriteTokens: input.observation.cacheWriteTokens,
    primaryLatencyMs: input.observation.latencyMs,
    primaryEstimatedCostMicros: input.primary.estimatedCostMicros ?? null,
    sourceBindingHmac: input.sourceBindingHmac,
    requestHmac: input.evidence.requestHmac ?? null,
    outputHmac: input.evidence.outputHmac ?? null,
    inputTokens: input.evidence.inputTokens ?? null,
    outputTokens: input.evidence.outputTokens ?? null,
    returnedModel: input.evidence.returnedModel ?? null,
    shadowLatencyMs: input.evidence.latencyMs ?? null,
    estimatedCostMicros: input.evidence.inputTokens !== undefined
      && input.evidence.outputTokens !== undefined
      ? estimateCostMicros(input.evidence.inputTokens, input.evidence.outputTokens)
      : null,
    selectedAt: input.selectedAt.toISOString(),
    dispatchedAt: input.dispatchedAt?.toISOString() ?? null,
    completedAt: input.now.toISOString(),
  };
  const completionHmac = digest(
    input.config.hmacKey,
    'completion',
    stableJson(boundedCompletion),
  );
  const estimatedCost = input.evidence.inputTokens !== undefined
    && input.evidence.outputTokens !== undefined
    ? estimateCostMicros(input.evidence.inputTokens, input.evidence.outputTokens)
    : null;
  const result = await input.query(
    `UPDATE addie_router_shadow_attempts
     SET status = $2, reason = $3, returned_model = $4,
         shadow_action = $5, action_match = $6, tool_sets_match = $7,
         confidence_match = $8, depth_match = $9, emoji_match = $10,
         privilege_attempt = $11, invalid_tool_set_attempt = $12,
         provider_request_hmac = COALESCE(provider_request_hmac, $13),
         provider_output_hmac = $14, completion_hmac = $15,
         input_tokens = $16, output_tokens = $17, shadow_latency_ms = $18,
         estimated_cost_micros = $19, completed_at = $20
     WHERE attempt_id = $1 AND status = 'running'`,
    [
      input.attemptId,
      input.evidence.status,
      input.evidence.reason,
      input.evidence.returnedModel ?? null,
      input.evidence.shadowPlan?.action ?? null,
      input.evidence.actionMatch ?? null,
      input.evidence.toolSetsMatch ?? null,
      input.evidence.confidenceMatch ?? null,
      input.evidence.depthMatch ?? null,
      input.evidence.emojiMatch ?? null,
      input.evidence.privilegeAttempt ?? false,
      input.evidence.invalidToolSetAttempt ?? false,
      input.evidence.requestHmac ?? null,
      input.evidence.outputHmac ?? null,
      completionHmac,
      input.evidence.inputTokens ?? null,
      input.evidence.outputTokens ?? null,
      input.evidence.latencyMs ?? null,
      estimatedCost,
      input.now,
    ],
  );
  if (result.rowCount !== 1) throw new RouterShadowBoundaryError('internal_error');
}

function buildLunaRequest(observation: RouterModelObservation): ModelRequest {
  if (
    observation.canonicalRequest.model !== observation.requestedModel
    || observation.canonicalRequest.tools.length !== 0
    || observation.canonicalRequest.providerTools?.length
  ) {
    throw new RouterShadowBoundaryError('internal_error');
  }
  return {
    ...observation.canonicalRequest,
    model: OPENAI_ROUTER_MODEL,
    reasoning: { effort: 'none' },
  };
}

function classifyError(
  error: unknown,
  aborted: boolean,
  dispatchRecorded: boolean,
): TerminalReason {
  if (aborted && dispatchRecorded) return 'timeout_after_dispatch';
  if (error instanceof RouterShadowBoundaryError) return error.category;
  if (error instanceof RouterPlanParseError) return error.category;
  if (error instanceof UnexpectedModelIdentityError) return 'unexpected_model_identity';
  if (error instanceof InvalidModelEventStreamError) return 'invalid_provider_event_stream';
  if (error instanceof UnsupportedModelCapabilityError) return 'unsupported_provider_capability';
  return dispatchRecorded ? 'provider_error' : 'internal_error';
}

export interface RunRouterShadowInput extends RouterShadowCohortInput {
  observation: RouterModelObservation;
}

export interface RunRouterShadowDependencies {
  env?: RouterShadowEnvironment;
  query?: QueryFn;
  provider?: ModelProvider;
  now?: () => Date;
  randomId?: () => string;
  timeoutMs?: number;
}

export type RunRouterShadowResult =
  | { status: 'not_selected'; reason: RouterShadowSelectionReason }
  | { status: 'duplicate' }
  | { status: TerminalStatus; reason: TerminalReason };

/**
 * Execute one selected Luna observation. The primary Haiku decision has
 * already completed and is never read back or modified by this function.
 */
export async function runRouterShadow(
  input: RunRouterShadowInput,
  dependencies: RunRouterShadowDependencies = {},
): Promise<RunRouterShadowResult> {
  const selection = resolveRouterShadowCohort(input, dependencies.env);
  if (!selection.selected || !selection.config) {
    return { status: 'not_selected', reason: selection.reason };
  }
  const config = selection.config;
  if (input.observation.requestedProvider !== 'anthropic') {
    return { status: 'not_selected', reason: 'invalid_configuration' };
  }
  const runQuery = dependencies.query ?? defaultQuery as QueryFn;
  const now = dependencies.now ?? (() => new Date());
  const attemptId = (dependencies.randomId ?? randomUUID)();
  const sourceValue = `${input.channelId}\0${input.opportunityId}`;
  let request: ModelRequest;
  try {
    request = buildLunaRequest(input.observation);
  } catch {
    return { status: 'not_selected', reason: 'invalid_configuration' };
  }
  const primary = classifyPrimaryObservation(input.observation, config.hmacKey);
  const sourceBindingHmac = digest(config.hmacKey, 'source-binding', sourceValue);
  const selectedAt = now();
  const claim = await beginAttempt({
    attemptId,
    sourceBindingHmac,
    primary,
    observation: input.observation,
    config,
    now: selectedAt,
    query: runQuery,
  });
  if (claim === 'duplicate') return { status: 'duplicate' };
  if (claim === 'daily_limit_reached') {
    return { status: 'not_dispatched', reason: 'daily_limit_reached' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('router_shadow_deadline')),
    dependencies.timeoutMs ?? ROUTER_SHADOW_TIMEOUT_MS,
  );
  let requestHmac: string | undefined;
  let dispatchRecorded = false;
  let dispatchedAt: Date | undefined;
  let outputHmac: string | undefined;
  let response: ModelResponse | undefined;
  const started = performance.now();
  let terminal: TerminalEvidence;
  try {
    const preparedProvider = dependencies.provider
      ?? new OpenAIResponsesProvider(config.openAiApiKey);
    if (preparedProvider.id !== 'openai') {
      throw new RouterShadowBoundaryError('internal_error');
    }
    const expectedPrepared = preparedProvider.prepare(request);
    const expectedRequestJson = stableJson(expectedPrepared.providerRequest);
    if (Buffer.byteLength(expectedRequestJson, 'utf8') > ROUTER_SHADOW_MAX_REQUEST_BYTES) {
      throw new RouterShadowBoundaryError('request_too_large');
    }
    const expectedRequestHmac = digest(
      config.hmacKey,
      'provider-request',
      expectedRequestJson,
    );
    response = await collectModelResponse(preparedProvider.respond(request, {
      signal: controller.signal,
      beforeDispatch: async (prepared: PreparedModelInvocation) => {
        const exactRequestJson = stableJson(prepared.providerRequest);
        if (Buffer.byteLength(exactRequestJson, 'utf8') > ROUTER_SHADOW_MAX_REQUEST_BYTES) {
          throw new RouterShadowBoundaryError('request_too_large');
        }
        requestHmac = digest(config.hmacKey, 'provider-request', exactRequestJson);
        if (requestHmac !== expectedRequestHmac) {
          throw new RouterShadowBoundaryError('internal_error');
        }
        try {
          const exactDispatchTime = now();
          await markDispatched(attemptId, requestHmac, exactDispatchTime, runQuery);
          dispatchRecorded = true;
          dispatchedAt = exactDispatchTime;
        } catch (error) {
          if (error instanceof RouterShadowBoundaryError) throw error;
          throw new RouterShadowBoundaryError('internal_error');
        }
      },
    }), 'openai');
    if (!dispatchRecorded || !requestHmac) {
      throw new RouterShadowBoundaryError('internal_error');
    }
    outputHmac = digest(
      config.hmacKey,
      'provider-output',
      stableJson(response.content),
    );
    if (response.finishReason === 'refusal') {
      terminal = { status: 'invalid', reason: 'refusal' };
    } else if (response.finishReason === 'length') {
      terminal = { status: 'invalid', reason: 'truncated' };
    } else if (
      response.finishReason === 'continue'
      || response.finishReason === 'tool_calls'
    ) {
      terminal = { status: 'invalid', reason: 'incomplete' };
    } else {
      const text = extractRouterResponseText(response.content);
      if (!text.trim()) {
        terminal = { status: 'invalid', reason: 'empty' };
      } else {
        const shadowPlan = parseStrictRouterPlan(
          text,
          input.observation.isAdmin,
        );
        terminal = {
          status: 'succeeded',
          reason: 'valid_plan',
          shadowPlan,
          ...(primary.status === 'valid_plan' && primary.plan
            ? comparePlans(primary.plan, shadowPlan)
            : {}),
        };
      }
    }
  } catch (error) {
    const reason = classifyError(error, controller.signal.aborted, dispatchRecorded);
    terminal = {
      status: reason === 'invalid_json' || reason === 'schema_invalid'
        ? 'invalid'
        : reason === 'request_too_large'
          ? 'not_dispatched'
          : 'error',
      reason,
      privilegeAttempt: error instanceof RouterPlanParseError
        ? error.unauthorizedToolSetAttempt
        : false,
      invalidToolSetAttempt: error instanceof RouterPlanParseError
        ? error.invalidToolSetAttempt
        : false,
    };
  } finally {
    clearTimeout(timeout);
  }

  terminal = {
    ...terminal,
    requestHmac,
    outputHmac,
    returnedModel: response?.model,
    inputTokens: response?.usage.inputTokens,
    outputTokens: response?.usage.outputTokens,
    latencyMs: dispatchRecorded
      ? Math.max(0, Math.round(performance.now() - started))
      : undefined,
  };
  await completeAttempt({
    attemptId,
    evidence: terminal,
    primary,
    observation: input.observation,
    sourceBindingHmac,
    selectedAt,
    dispatchedAt,
    config,
    now: now(),
    query: runQuery,
  });
  return { status: terminal.status, reason: terminal.reason };
}

export interface RouterShadowSummary {
  days: number;
  scope: {
    policy_version: string;
    pricing_version: string;
    primary_pricing_version: string;
    requested_provider: 'openai';
    requested_model: string;
    primary_requested_provider: 'anthropic';
    primary_requested_model: string;
    minimum_comparison_samples: number;
    population: 'allowlisted_public_channel_full_model_router_only';
    limitation: 'agreement_with_primary_router_is_not_gold_label_quality';
  };
  admission: {
    sampled: number;
    claimed: number;
    duplicates: number;
    quota_exhausted: number;
    unclassified: number;
  };
  evidence_complete: boolean;
  comparison_eligible: boolean;
  cost_comparison_eligible: boolean;
  selected: number;
  dispatched: number;
  terminal: number;
  outcomes: Array<{
    status: string;
    reason: string | null;
    count: number;
  }>;
  primary_outcomes: Array<{ status: string; count: number }>;
  primary_validity: { numerator: number; denominator: number };
  shadow_validity: { numerator: number; denominator: number };
  valid_action_match_all_dispatched: { numerator: number; denominator: number };
  action_agreement: { numerator: number; denominator: number };
  tool_set_agreement: { numerator: number; denominator: number };
  confidence_agreement: { numerator: number; denominator: number };
  depth_agreement: { numerator: number; denominator: number };
  emoji_agreement: { numerator: number; denominator: number };
  safety: { privilege_attempts: number; invalid_tool_set_attempts: number };
  action_confusion: Array<{
    primary_action: string;
    shadow_action: string;
    count: number;
  }>;
  models: {
    primary_returned: Array<{ model: string; count: number }>;
    shadow_returned: Array<{ model: string; count: number }>;
    primary_missing: number;
    shadow_missing: number;
  };
  primary_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    missing: number;
    estimated_cost_micros: number;
  };
  shadow_usage: {
    input_tokens: number;
    output_tokens: number;
    missing: number;
    estimated_cost_micros: number;
    reserved_cost_micros: number;
  };
  latency_ms: {
    primary_p50: number | null;
    primary_p95: number | null;
    shadow_p50: number | null;
    shadow_p95: number | null;
  };
}

export async function getRouterShadowSummary(
  days: number,
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<RouterShadowSummary> {
  if (!Number.isInteger(days) || days < 1 || days > ROUTER_SHADOW_RETENTION_DAYS) {
    throw new RangeError('days must be within router shadow retention');
  }
  const runQuery = dependencies.query ?? defaultQuery as QueryFn;
  const now = dependencies.now ?? new Date();
  const aggregate = await runQuery<{
    selected: string;
    dispatched: string;
    terminal: string;
    authenticated_terminal: string;
    running: string;
    primary_valid: string;
    shadow_valid: string;
    shadow_validity_denominator: string;
    effective_matches: string;
    action_matches: string;
    action_denominator: string;
    tool_matches: string;
    tool_denominator: string;
    confidence_matches: string;
    confidence_denominator: string;
    depth_matches: string;
    depth_denominator: string;
    emoji_matches: string;
    emoji_denominator: string;
    privilege_attempts: string;
    invalid_tool_set_attempts: string;
    primary_input_tokens: string;
    primary_output_tokens: string;
    primary_cache_read_tokens: string;
    primary_cache_write_tokens: string;
    primary_usage_missing: string;
    primary_estimated_cost_micros: string;
    shadow_input_tokens: string;
    shadow_output_tokens: string;
    shadow_usage_missing: string;
    shadow_estimated_cost_micros: string;
    reserved_cost_micros: string;
    primary_p50: number | null;
    primary_p95: number | null;
    shadow_p50: number | null;
    shadow_p95: number | null;
    outcomes: Array<{ status: string; reason: string | null; count: string }>;
    primary_outcomes: Array<{ status: string; count: string }>;
    action_confusion: Array<{
      primary_action: string;
      shadow_action: string;
      count: string;
    }>;
    primary_models: Array<{ model: string; count: string }>;
    shadow_models: Array<{ model: string; count: string }>;
    admission_sampled: string;
    admission_claimed: string;
    admission_duplicates: string;
    admission_quota_exhausted: string;
    primary_model_missing: string;
    shadow_model_missing: string;
    primary_model_count: string;
    shadow_model_count: string;
    identity_failures: string;
  }>(
    `WITH scoped AS (
       SELECT * FROM addie_router_shadow_attempts
       WHERE quota_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - ($2::integer - 1))
         AND policy_version = $3
         AND pricing_version = $4
         AND requested_provider = 'openai'
         AND requested_model = $5
         AND primary_pricing_version = $6
         AND primary_requested_model = $7
     ), admission_metrics AS (
       SELECT
         COALESCE(SUM(sampled_count), 0)::text AS admission_sampled,
         COALESCE(SUM(claimed_count), 0)::text AS admission_claimed,
         COALESCE(SUM(duplicate_count), 0)::text AS admission_duplicates,
         COALESCE(SUM(quota_exhausted_count), 0)::text AS admission_quota_exhausted
       FROM addie_router_shadow_daily_admissions
       WHERE admission_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - ($2::integer - 1))
         AND policy_version = $3
         AND pricing_version = $4
         AND requested_model = $5
         AND primary_pricing_version = $6
         AND primary_requested_model = $7
     ), metrics AS (
       SELECT
       COUNT(*)::text AS selected,
       COUNT(*) FILTER (WHERE dispatched_at IS NOT NULL)::text AS dispatched,
       COUNT(*) FILTER (WHERE status <> 'running')::text AS terminal,
       COUNT(*) FILTER (WHERE status <> 'running' AND completion_hmac IS NOT NULL)::text
         AS authenticated_terminal,
       COUNT(*) FILTER (WHERE status = 'running')::text AS running,
       COUNT(*) FILTER (WHERE primary_status = 'valid_plan')::text AS primary_valid,
       COUNT(*) FILTER (WHERE status = 'succeeded')::text AS shadow_valid,
       COUNT(*) FILTER (WHERE dispatched_at IS NOT NULL AND status <> 'running')::text
         AS shadow_validity_denominator,
       COUNT(*) FILTER (
         WHERE dispatched_at IS NOT NULL AND status = 'succeeded'
           AND primary_status = 'valid_plan' AND action_match = TRUE
       )::text AS effective_matches,
       COUNT(*) FILTER (WHERE action_match = TRUE)::text AS action_matches,
       COUNT(*) FILTER (WHERE action_match IS NOT NULL)::text AS action_denominator,
       COUNT(*) FILTER (WHERE tool_sets_match = TRUE)::text AS tool_matches,
       COUNT(*) FILTER (WHERE tool_sets_match IS NOT NULL)::text AS tool_denominator,
       COUNT(*) FILTER (WHERE confidence_match = TRUE)::text AS confidence_matches,
       COUNT(*) FILTER (WHERE confidence_match IS NOT NULL)::text AS confidence_denominator,
       COUNT(*) FILTER (WHERE depth_match = TRUE)::text AS depth_matches,
       COUNT(*) FILTER (WHERE depth_match IS NOT NULL)::text AS depth_denominator,
       COUNT(*) FILTER (WHERE emoji_match = TRUE)::text AS emoji_matches,
       COUNT(*) FILTER (WHERE emoji_match IS NOT NULL)::text AS emoji_denominator,
       COUNT(*) FILTER (WHERE privilege_attempt)::text AS privilege_attempts,
       COUNT(*) FILTER (WHERE invalid_tool_set_attempt)::text AS invalid_tool_set_attempts,
       COUNT(*) FILTER (
         WHERE primary_provider_request_hmac IS NOT NULL AND primary_returned_model IS NULL
       )::text AS primary_model_missing,
       COUNT(*) FILTER (
         WHERE dispatched_at IS NOT NULL AND returned_model IS NULL
       )::text AS shadow_model_missing,
       COUNT(DISTINCT primary_returned_model)::text AS primary_model_count,
       COUNT(DISTINCT returned_model)::text AS shadow_model_count,
       COUNT(*) FILTER (
         WHERE primary_status = 'unexpected_model_identity'
           OR reason = 'unexpected_model_identity'
       )::text AS identity_failures,
       COALESCE(SUM(primary_input_tokens), 0)::text AS primary_input_tokens,
       COALESCE(SUM(primary_output_tokens), 0)::text AS primary_output_tokens,
       COALESCE(SUM(primary_cache_read_tokens), 0)::text AS primary_cache_read_tokens,
       COALESCE(SUM(primary_cache_write_tokens), 0)::text AS primary_cache_write_tokens,
       COUNT(*) FILTER (
         WHERE primary_provider_request_hmac IS NOT NULL AND primary_input_tokens IS NULL
       )::text AS primary_usage_missing,
       COALESCE(SUM(primary_estimated_cost_micros), 0)::text
         AS primary_estimated_cost_micros,
       COALESCE(SUM(input_tokens), 0)::text AS shadow_input_tokens,
       COALESCE(SUM(output_tokens), 0)::text AS shadow_output_tokens,
       COUNT(*) FILTER (WHERE dispatched_at IS NOT NULL AND input_tokens IS NULL)::text
         AS shadow_usage_missing,
       COALESCE(SUM(estimated_cost_micros), 0)::text AS shadow_estimated_cost_micros,
       COALESCE(SUM(reserved_cost_micros) FILTER (WHERE dispatched_at IS NOT NULL), 0)::text
         AS reserved_cost_micros,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY primary_latency_ms)::double precision
         AS primary_p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY primary_latency_ms)::double precision
         AS primary_p95,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY shadow_latency_ms)
         FILTER (WHERE dispatched_at IS NOT NULL AND shadow_latency_ms IS NOT NULL)
         ::double precision AS shadow_p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY shadow_latency_ms)
         FILTER (WHERE dispatched_at IS NOT NULL AND shadow_latency_ms IS NOT NULL)
         ::double precision AS shadow_p95
       FROM scoped
     ), outcomes AS (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object('status', status, 'reason', reason, 'count', count)
         ORDER BY status, reason
       ), '[]'::jsonb) AS value
       FROM (SELECT status, reason, COUNT(*)::text AS count
             FROM scoped GROUP BY status, reason) grouped
     ), primary_outcomes AS (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object('status', primary_status, 'count', count)
         ORDER BY primary_status
       ), '[]'::jsonb) AS value
       FROM (SELECT primary_status, COUNT(*)::text AS count
             FROM scoped GROUP BY primary_status) grouped
     ), confusion AS (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object(
           'primary_action', primary_action, 'shadow_action', shadow_action, 'count', count
         ) ORDER BY primary_action, shadow_action
       ), '[]'::jsonb) AS value
       FROM (SELECT primary_action, shadow_action, COUNT(*)::text AS count
             FROM scoped WHERE primary_action IS NOT NULL AND shadow_action IS NOT NULL
             GROUP BY primary_action, shadow_action) grouped
     ), primary_models AS (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object('model', primary_returned_model, 'count', count)
         ORDER BY primary_returned_model
       ), '[]'::jsonb) AS value
       FROM (SELECT primary_returned_model, COUNT(*)::text AS count
             FROM scoped WHERE primary_returned_model IS NOT NULL
             GROUP BY primary_returned_model) grouped
     ), shadow_models AS (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object('model', returned_model, 'count', count)
         ORDER BY returned_model
       ), '[]'::jsonb) AS value
       FROM (SELECT returned_model, COUNT(*)::text AS count
             FROM scoped WHERE returned_model IS NOT NULL
             GROUP BY returned_model) grouped
     )
     SELECT metrics.*, admission_metrics.*, outcomes.value AS outcomes,
            primary_outcomes.value AS primary_outcomes,
            confusion.value AS action_confusion,
            primary_models.value AS primary_models,
            shadow_models.value AS shadow_models
     FROM metrics, admission_metrics, outcomes, primary_outcomes, confusion,
          primary_models, shadow_models`,
    [
      now,
      days,
      ROUTER_SHADOW_POLICY_VERSION,
      ROUTER_SHADOW_PRICING_VERSION,
      OPENAI_ROUTER_MODEL,
      ROUTER_SHADOW_PRIMARY_PRICING_VERSION,
      ModelConfig.fast,
    ],
  );
  const row = aggregate.rows[0];
  const count = (value: string | undefined) => Number.parseInt(value ?? '0', 10);
  const selected = count(row?.selected);
  const dispatched = count(row?.dispatched);
  const terminal = count(row?.terminal);
  const mapCounts = <T extends { count: string }>(values: T[] | undefined) =>
    (values ?? []).map((value) => ({ ...value, count: count(value.count) }));
  const outcomes = mapCounts(row?.outcomes);
  if (outcomes.reduce((sum, outcome) => sum + outcome.count, 0) !== selected) {
    throw new Error('router shadow summary did not reconcile');
  }
  const sampled = count(row?.admission_sampled);
  const claimed = count(row?.admission_claimed);
  const duplicates = count(row?.admission_duplicates);
  const quotaExhausted = count(row?.admission_quota_exhausted);
  const unclassified = Math.max(0, sampled - claimed - duplicates - quotaExhausted);
  const evidenceComplete = selected > 0
    && terminal === selected
    && dispatched === selected
    && count(row?.authenticated_terminal) === terminal
    && count(row?.running) === 0
    && claimed === selected
    && unclassified === 0;
  const comparisonEligible = evidenceComplete
    && selected >= ROUTER_SHADOW_MIN_COMPARISON_SAMPLES
    && quotaExhausted === 0
    && count(row?.identity_failures) === 0
    && count(row?.primary_model_count) <= 1
    && count(row?.shadow_model_count) <= 1;
  return {
    days,
    scope: {
      policy_version: ROUTER_SHADOW_POLICY_VERSION,
      pricing_version: ROUTER_SHADOW_PRICING_VERSION,
      primary_pricing_version: ROUTER_SHADOW_PRIMARY_PRICING_VERSION,
      requested_provider: 'openai',
      requested_model: OPENAI_ROUTER_MODEL,
      primary_requested_provider: 'anthropic',
      primary_requested_model: ModelConfig.fast,
      minimum_comparison_samples: ROUTER_SHADOW_MIN_COMPARISON_SAMPLES,
      population: 'allowlisted_public_channel_full_model_router_only',
      limitation: 'agreement_with_primary_router_is_not_gold_label_quality',
    },
    admission: { sampled, claimed, duplicates, quota_exhausted: quotaExhausted, unclassified },
    evidence_complete: evidenceComplete,
    comparison_eligible: comparisonEligible,
    cost_comparison_eligible: comparisonEligible
      && count(row?.primary_usage_missing) === 0
      && count(row?.shadow_usage_missing) === 0,
    selected,
    dispatched,
    terminal,
    outcomes,
    primary_outcomes: mapCounts(row?.primary_outcomes),
    primary_validity: {
      numerator: count(row?.primary_valid),
      denominator: selected,
    },
    shadow_validity: {
      numerator: count(row?.shadow_valid),
      denominator: count(row?.shadow_validity_denominator),
    },
    valid_action_match_all_dispatched: {
      numerator: count(row?.effective_matches),
      denominator: count(row?.shadow_validity_denominator),
    },
    action_agreement: {
      numerator: count(row?.action_matches),
      denominator: count(row?.action_denominator),
    },
    tool_set_agreement: {
      numerator: count(row?.tool_matches),
      denominator: count(row?.tool_denominator),
    },
    confidence_agreement: {
      numerator: count(row?.confidence_matches),
      denominator: count(row?.confidence_denominator),
    },
    depth_agreement: {
      numerator: count(row?.depth_matches),
      denominator: count(row?.depth_denominator),
    },
    emoji_agreement: {
      numerator: count(row?.emoji_matches),
      denominator: count(row?.emoji_denominator),
    },
    safety: {
      privilege_attempts: count(row?.privilege_attempts),
      invalid_tool_set_attempts: count(row?.invalid_tool_set_attempts),
    },
    action_confusion: mapCounts(row?.action_confusion),
    models: {
      primary_returned: mapCounts(row?.primary_models),
      shadow_returned: mapCounts(row?.shadow_models),
      primary_missing: count(row?.primary_model_missing),
      shadow_missing: count(row?.shadow_model_missing),
    },
    primary_usage: {
      input_tokens: count(row?.primary_input_tokens),
      output_tokens: count(row?.primary_output_tokens),
      cache_read_tokens: count(row?.primary_cache_read_tokens),
      cache_write_tokens: count(row?.primary_cache_write_tokens),
      missing: count(row?.primary_usage_missing),
      estimated_cost_micros: count(row?.primary_estimated_cost_micros),
    },
    shadow_usage: {
      input_tokens: count(row?.shadow_input_tokens),
      output_tokens: count(row?.shadow_output_tokens),
      missing: count(row?.shadow_usage_missing),
      estimated_cost_micros: count(row?.shadow_estimated_cost_micros),
      reserved_cost_micros: count(row?.reserved_cost_micros),
    },
    latency_ms: {
      primary_p50: row?.primary_p50 ?? null,
      primary_p95: row?.primary_p95 ?? null,
      shadow_p50: row?.shadow_p50 ?? null,
      shadow_p95: row?.shadow_p95 ?? null,
    },
  };
}
