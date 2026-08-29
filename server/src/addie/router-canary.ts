import { createHmac } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { query as defaultQuery } from '../db/client.js';
import { createLogger } from '../logger.js';
import { FIXED_TRACE_ROLLOUT_POLICY_VERSION } from './eval/fixed-trace-rollout.js';
import { OPENAI_ROUTER_MODEL } from './model-providers/openai-responses-provider.js';
import { ROUTER_SHADOW_PROMOTION_POLICY_VERSION } from './router-shadow.js';

const logger = createLogger('addie-router-canary');

export const ROUTER_CANARY_POLICY_VERSION = 'addie-router-luna-canary:v1';
export const ROUTER_CANARY_PRICING_VERSION = 'openai-gpt-5.6-luna-2026-08-26';
export const ROUTER_CANARY_MAX_CHANNELS = 4;
export const ROUTER_CANARY_MAX_DEADLINE_MS = 15_000;
export const ROUTER_CANARY_SUMMARY_MAX_DAYS = 90;
export const ROUTER_CANARY_STALE_INFLIGHT_MS = 15 * 60 * 1000;
export const ROUTER_CANARY_ROLLBACK_POLICY = Object.freeze({
  minimumCompleted: 5,
  maximumFailureRate: 0.2,
  maximumAverageLatencyMs: 10_000,
  maximumAverageCostMicros: 5_000,
});

const LUNA_INPUT_MICROS_PER_TOKEN = 0.2;
const LUNA_OUTPUT_MICROS_PER_TOKEN = 1.2;
export const ROUTER_CANARY_MAX_REQUEST_BYTES = 65_536;
const MAX_OUTPUT_TOKENS = 300;
export const ROUTER_CANARY_RESERVED_COST_MICROS = Math.ceil(
  ROUTER_CANARY_MAX_REQUEST_BYTES * LUNA_INPUT_MICROS_PER_TOKEN
  + MAX_OUTPUT_TOKENS * LUNA_OUTPUT_MICROS_PER_TOKEN,
);

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>;

type RouterCanaryEnvironment = Record<string, string | undefined>;

export type RouterCanarySelectionReason =
  | 'selected'
  | 'disabled'
  | 'production_data_not_approved'
  | 'evidence_not_approved'
  | 'invalid_configuration'
  | 'private_channel'
  | 'shared_channel'
  | 'channel_not_allowlisted'
  | 'sample_excluded';

export type RouterCanaryAdmissionReason =
  | RouterCanarySelectionReason
  | 'daily_limit_reached'
  | 'rolled_back'
  | 'ledger_unavailable';

export interface RouterCanaryCohortInput {
  channelId: string;
  opportunityId: string;
  channelIsPublic: boolean;
  channelIsShared: boolean;
}

export interface RouterCanarySelection {
  selected: boolean;
  reason: RouterCanarySelectionReason;
}

interface RouterCanaryConfig {
  hmacKeyVersion: string;
  sampleBps: number;
  dailyLimit: number;
  dailyBudgetMicros: number;
  deadlineMs: number;
}

export interface RouterCanaryAdmission {
  status: 'admitted';
  admissionDate: string;
  deadlineMs: number;
  policyVersion: typeof ROUTER_CANARY_POLICY_VERSION;
  pricingVersion: typeof ROUTER_CANARY_PRICING_VERSION;
  hashKeyVersion: string;
  requestedModel: typeof OPENAI_ROUTER_MODEL;
}

export type AdmitRouterCanaryResult =
  | RouterCanaryAdmission
  | { status: 'not_admitted'; reason: RouterCanaryAdmissionReason };

export type RouterCanaryFailureReason =
  | 'timeout'
  | 'invalid_output'
  | 'unexpected_model_identity'
  | 'invalid_provider_event_stream'
  | 'unsupported_provider_capability'
  | 'provider_error';

export interface RouterCanaryOutcome {
  status: 'candidate_succeeded' | 'fallback_succeeded' | 'fallback_safe_default';
  failureReason?: RouterCanaryFailureReason;
  candidateLatencyMs: number;
  candidateCostMicros: number;
  fallbackLatencyMs?: number;
}

export interface RouterCanaryRecordResult {
  recorded: boolean;
  rolledBack: boolean;
  rollbackReason: string | null;
}

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

function digest(key: string, value: string): string {
  return createHmac('sha256', key)
    .update(`${ROUTER_CANARY_POLICY_VERSION}\0sample\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function resolveRouterCanaryCohort(
  input: RouterCanaryCohortInput,
  env: RouterCanaryEnvironment = process.env,
): RouterCanarySelection & { config?: RouterCanaryConfig } {
  if (env.ADDIE_ROUTER_LUNA_CANARY_ENABLED !== 'true') {
    return { selected: false, reason: 'disabled' };
  }
  if (env.ADDIE_ROUTER_LUNA_CANARY_PRODUCTION_DATA_APPROVED !== 'true') {
    return { selected: false, reason: 'production_data_not_approved' };
  }
  if (
    env.ADDIE_ROUTER_LUNA_CANARY_FIXED_TRACE_POLICY_VERSION
      !== FIXED_TRACE_ROLLOUT_POLICY_VERSION
    || env.ADDIE_ROUTER_LUNA_CANARY_SHADOW_PROMOTION_POLICY_VERSION
      !== ROUTER_SHADOW_PROMOTION_POLICY_VERSION
  ) {
    return { selected: false, reason: 'evidence_not_approved' };
  }
  if (!input.channelIsPublic) return { selected: false, reason: 'private_channel' };
  if (input.channelIsShared) return { selected: false, reason: 'shared_channel' };

  const channels = (env.ADDIE_ROUTER_LUNA_CANARY_CHANNEL_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const hmacKey = env.ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY?.trim();
  const hmacKeyVersion = env.ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY_VERSION?.trim();
  const sampleBps = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_CANARY_SAMPLE_BPS,
    1,
    10_000,
  );
  const configuredDailyLimit = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_CANARY_DAILY_LIMIT,
    1,
    100,
  );
  const dailyBudgetMicros = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_CANARY_DAILY_BUDGET_MICROS,
    ROUTER_CANARY_RESERVED_COST_MICROS,
    10_000_000,
  );
  const deadlineMs = parseBoundedInteger(
    env.ADDIE_ROUTER_LUNA_CANARY_DEADLINE_MS,
    1_000,
    ROUTER_CANARY_MAX_DEADLINE_MS,
  );
  const channelsValid = channels.length >= 1
    && channels.length <= ROUTER_CANARY_MAX_CHANNELS
    && new Set(channels).size === channels.length
    && channels.every((channel) => /^C[A-Z0-9]{8,}$/.test(channel));
  if (
    !channelsValid
    || !hmacKey
    || hmacKey.length < 32
    || !hmacKeyVersion
    || !/^[A-Za-z0-9._:-]{1,64}$/.test(hmacKeyVersion)
    || !env.OPENAI_API_KEY?.trim()
    || sampleBps === null
    || configuredDailyLimit === null
    || dailyBudgetMicros === null
    || deadlineMs === null
    || !input.channelId
    || !input.opportunityId
  ) {
    return { selected: false, reason: 'invalid_configuration' };
  }
  if (!channels.includes(input.channelId)) {
    return { selected: false, reason: 'channel_not_allowlisted' };
  }
  const bucket = Number.parseInt(
    digest(hmacKey, `${input.channelId}\0${input.opportunityId}`).slice(0, 8),
    16,
  ) % 10_000;
  if (bucket >= sampleBps) return { selected: false, reason: 'sample_excluded' };

  const budgetSlots = Math.floor(dailyBudgetMicros / ROUTER_CANARY_RESERVED_COST_MICROS);
  const dailyLimit = Math.min(configuredDailyLimit, budgetSlots);
  if (dailyLimit < 1) return { selected: false, reason: 'invalid_configuration' };
  return {
    selected: true,
    reason: 'selected',
    config: {
      hmacKeyVersion,
      sampleBps,
      dailyLimit,
      dailyBudgetMicros,
      deadlineMs,
    },
  };
}

/** Pure, fail-closed selection. Configuration secrets never leave this module. */
export function selectRouterCanaryCohort(
  input: RouterCanaryCohortInput,
  env: RouterCanaryEnvironment = process.env,
): RouterCanarySelection {
  const { selected, reason } = resolveRouterCanaryCohort(input, env);
  return { selected, reason };
}

interface AdmissionRow {
  admitted: boolean;
  reason: 'admitted' | 'daily_limit_reached' | 'rolled_back' | 'invalid_configuration';
  admission_date: string;
}

/**
 * Atomically claims a bounded paid-call slot. No production identifier or
 * per-opportunity hash is passed to or persisted by the ledger.
 */
export async function admitRouterCanary(
  input: RouterCanaryCohortInput,
  dependencies: {
    env?: RouterCanaryEnvironment;
    query?: QueryFn;
    now?: Date;
  } = {},
): Promise<AdmitRouterCanaryResult> {
  const selection = resolveRouterCanaryCohort(input, dependencies.env);
  if (!selection.selected || !selection.config) {
    return { status: 'not_admitted', reason: selection.reason };
  }
  const config = selection.config;
  const runQuery = dependencies.query ?? defaultQuery as QueryFn;
  const now = dependencies.now ?? new Date();
  try {
    await runQuery(
      `INSERT INTO addie_router_canary_state (
         policy_version, pricing_version, hash_key_version, requested_model,
         sample_bps, daily_limit, daily_budget_micros, reserved_cost_micros,
         deadline_ms, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT DO NOTHING`,
      [
        ROUTER_CANARY_POLICY_VERSION,
        ROUTER_CANARY_PRICING_VERSION,
        config.hmacKeyVersion,
        OPENAI_ROUTER_MODEL,
        config.sampleBps,
        config.dailyLimit,
        config.dailyBudgetMicros,
        ROUTER_CANARY_RESERVED_COST_MICROS,
        config.deadlineMs,
        now,
      ],
    );
    await runQuery(
      `INSERT INTO addie_router_canary_daily_metrics (
         metric_date, policy_version, pricing_version, hash_key_version,
         requested_model, created_at, updated_at
       ) VALUES (($1::timestamptz AT TIME ZONE 'UTC')::date, $2, $3, $4, $5, $1, $1)
       ON CONFLICT DO NOTHING`,
      [
        now,
        ROUTER_CANARY_POLICY_VERSION,
        ROUTER_CANARY_PRICING_VERSION,
        config.hmacKeyVersion,
        OPENAI_ROUTER_MODEL,
      ],
    );
    const result = await runQuery<AdmissionRow>(
      `WITH current AS (
         SELECT metrics.metric_date, metrics.admitted_count, state.daily_limit,
                state.rolled_back_at, state.inflight_count, state.last_admitted_at,
                state.sample_bps, state.daily_budget_micros,
                state.reserved_cost_micros, state.deadline_ms
         FROM addie_router_canary_daily_metrics metrics
         JOIN addie_router_canary_state state USING (
           policy_version, pricing_version, hash_key_version, requested_model
         )
         WHERE metrics.metric_date = ($1::timestamptz AT TIME ZONE 'UTC')::date
           AND metrics.policy_version = $2 AND metrics.pricing_version = $3
           AND metrics.hash_key_version = $4 AND metrics.requested_model = $5
         FOR UPDATE OF metrics, state
       ), decision AS (
         SELECT *,
           rolled_back_at IS NULL
             AND NOT (
               inflight_count > 0
               AND last_admitted_at < $1::timestamptz - ($10::integer * INTERVAL '1 millisecond')
             )
             AND admitted_count < daily_limit
             AND sample_bps = $6 AND daily_limit = $7
             AND daily_budget_micros = $8 AND reserved_cost_micros = $9
             AND deadline_ms = $11 AS admitted,
           CASE
             WHEN sample_bps <> $6 OR daily_limit <> $7
               OR daily_budget_micros <> $8 OR reserved_cost_micros <> $9
               OR deadline_ms <> $11 THEN 'invalid_configuration'
             WHEN rolled_back_at IS NOT NULL OR (
               inflight_count > 0
               AND last_admitted_at < $1::timestamptz - ($10::integer * INTERVAL '1 millisecond')
             ) THEN 'rolled_back'
             WHEN admitted_count >= daily_limit THEN 'daily_limit_reached'
             ELSE 'admitted'
           END AS reason
         FROM current
       ), state_update AS (
         UPDATE addie_router_canary_state state
         SET inflight_count = state.inflight_count + CASE WHEN decision.admitted THEN 1 ELSE 0 END,
             last_admitted_at = CASE WHEN decision.admitted THEN $1::timestamptz ELSE state.last_admitted_at END,
             rolled_back_at = CASE
               WHEN decision.reason = 'rolled_back' AND state.rolled_back_at IS NULL
                 THEN $1::timestamptz
               ELSE state.rolled_back_at
             END,
             rollback_reason = CASE
               WHEN decision.reason = 'rolled_back' AND state.rolled_back_at IS NULL
                 THEN 'stale_inflight'
               ELSE state.rollback_reason
             END,
             updated_at = $1::timestamptz
         FROM decision
         WHERE state.policy_version = $2 AND state.pricing_version = $3
           AND state.hash_key_version = $4 AND state.requested_model = $5
       ), metrics_update AS (
         UPDATE addie_router_canary_daily_metrics metrics
         SET sampled_count = metrics.sampled_count + 1,
             admitted_count = metrics.admitted_count + CASE WHEN decision.admitted THEN 1 ELSE 0 END,
             quota_rejected_count = metrics.quota_rejected_count
               + CASE WHEN decision.reason = 'daily_limit_reached' THEN 1 ELSE 0 END,
             rollback_rejected_count = metrics.rollback_rejected_count
               + CASE WHEN decision.reason = 'rolled_back' THEN 1 ELSE 0 END,
             invalid_config_count = metrics.invalid_config_count
               + CASE WHEN decision.reason = 'invalid_configuration' THEN 1 ELSE 0 END,
             updated_at = $1::timestamptz
         FROM decision
         WHERE metrics.metric_date = decision.metric_date
           AND metrics.policy_version = $2 AND metrics.pricing_version = $3
           AND metrics.hash_key_version = $4 AND metrics.requested_model = $5
         RETURNING decision.admitted, decision.reason, metrics.metric_date::text AS admission_date
       )
       SELECT admitted, reason, admission_date FROM metrics_update`,
      [
        now,
        ROUTER_CANARY_POLICY_VERSION,
        ROUTER_CANARY_PRICING_VERSION,
        config.hmacKeyVersion,
        OPENAI_ROUTER_MODEL,
        config.sampleBps,
        config.dailyLimit,
        config.dailyBudgetMicros,
        ROUTER_CANARY_RESERVED_COST_MICROS,
        ROUTER_CANARY_STALE_INFLIGHT_MS,
        config.deadlineMs,
      ],
    );
    const row = result.rows[0];
    if (!row) return { status: 'not_admitted', reason: 'ledger_unavailable' };
    if (!row.admitted) {
      return {
        status: 'not_admitted',
        reason: row.reason === 'rolled_back'
          ? 'rolled_back'
          : row.reason === 'daily_limit_reached'
            ? 'daily_limit_reached'
            : 'invalid_configuration',
      };
    }
    return {
      status: 'admitted',
      admissionDate: row.admission_date,
      deadlineMs: config.deadlineMs,
      policyVersion: ROUTER_CANARY_POLICY_VERSION,
      pricingVersion: ROUTER_CANARY_PRICING_VERSION,
      hashKeyVersion: config.hmacKeyVersion,
      requestedModel: OPENAI_ROUTER_MODEL,
    };
  } catch {
    // Do not attach the database error or cohort input: either could contain
    // details outside this aggregate-only observability boundary.
    logger.error('Router canary admission ledger unavailable');
    return { status: 'not_admitted', reason: 'ledger_unavailable' };
  }
}

function validMetric(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Records one aggregate terminal outcome and atomically latches rollback. */
export async function recordRouterCanaryOutcome(
  admission: RouterCanaryAdmission,
  outcome: RouterCanaryOutcome,
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<RouterCanaryRecordResult> {
  if (
    !validMetric(outcome.candidateLatencyMs)
    || !validMetric(outcome.candidateCostMicros)
    || (outcome.fallbackLatencyMs !== undefined && !validMetric(outcome.fallbackLatencyMs))
    || (outcome.status === 'candidate_succeeded' && outcome.failureReason !== undefined)
    || (outcome.status !== 'candidate_succeeded' && outcome.failureReason === undefined)
  ) {
    throw new Error('Invalid router canary outcome');
  }
  const runQuery = dependencies.query ?? defaultQuery as QueryFn;
  const now = dependencies.now ?? new Date();
  const failureReason = outcome.failureReason ?? null;
  const result = await runQuery<{
    rolled_back: boolean;
    rollback_reason: string | null;
  }>(
    `WITH current AS (
       SELECT metrics.*, state.inflight_count, state.rolled_back_at
       FROM addie_router_canary_daily_metrics metrics
       JOIN addie_router_canary_state state USING (
         policy_version, pricing_version, hash_key_version, requested_model
       )
       WHERE metrics.metric_date = $1::date
         AND metrics.policy_version = $2 AND metrics.pricing_version = $3
         AND metrics.hash_key_version = $4 AND metrics.requested_model = $5
       FOR UPDATE OF metrics, state
     ), updated_metrics AS (
       UPDATE addie_router_canary_daily_metrics metrics
       SET completed_count = metrics.completed_count + 1,
           candidate_success_count = metrics.candidate_success_count
             + CASE WHEN $6 = 'candidate_succeeded' THEN 1 ELSE 0 END,
           candidate_failure_count = metrics.candidate_failure_count
             + CASE WHEN $6 <> 'candidate_succeeded' THEN 1 ELSE 0 END,
           fallback_success_count = metrics.fallback_success_count
             + CASE WHEN $6 = 'fallback_succeeded' THEN 1 ELSE 0 END,
           fallback_safe_default_count = metrics.fallback_safe_default_count
             + CASE WHEN $6 = 'fallback_safe_default' THEN 1 ELSE 0 END,
           timeout_count = metrics.timeout_count + CASE WHEN $7 = 'timeout' THEN 1 ELSE 0 END,
           invalid_output_count = metrics.invalid_output_count
             + CASE WHEN $7 = 'invalid_output' THEN 1 ELSE 0 END,
           identity_error_count = metrics.identity_error_count + CASE
             WHEN $7 IN ('unexpected_model_identity', 'invalid_provider_event_stream',
                         'unsupported_provider_capability') THEN 1 ELSE 0 END,
           provider_error_count = metrics.provider_error_count
             + CASE WHEN $7 = 'provider_error' THEN 1 ELSE 0 END,
           candidate_latency_ms_sum = metrics.candidate_latency_ms_sum + $8,
           candidate_latency_ms_max = GREATEST(metrics.candidate_latency_ms_max, $8),
           candidate_cost_micros_sum = metrics.candidate_cost_micros_sum + $9,
           fallback_latency_ms_sum = metrics.fallback_latency_ms_sum + COALESCE($10, 0),
           updated_at = $11::timestamptz
       FROM current
       WHERE metrics.metric_date = current.metric_date
         AND metrics.policy_version = $2 AND metrics.pricing_version = $3
         AND metrics.hash_key_version = $4 AND metrics.requested_model = $5
         AND current.inflight_count > 0
         AND current.completed_count < current.admitted_count
       RETURNING metrics.*
     ), decision AS (
       SELECT *, CASE
         WHEN $6 = 'fallback_safe_default' THEN 'fallback_safe_default'
         WHEN $7 IN ('unexpected_model_identity', 'invalid_provider_event_stream',
                     'unsupported_provider_capability') THEN 'provider_identity_or_capability'
         WHEN completed_count >= $12
           AND candidate_failure_count::numeric / completed_count > $13 THEN 'failure_rate'
         WHEN completed_count >= $12
           AND candidate_latency_ms_sum / completed_count > $14 THEN 'average_latency'
         WHEN completed_count >= $12
           AND candidate_cost_micros_sum / completed_count > $15 THEN 'average_cost'
         ELSE NULL
       END AS new_rollback_reason
       FROM updated_metrics
     ), updated_state AS (
       UPDATE addie_router_canary_state state
       SET inflight_count = state.inflight_count - 1,
           rolled_back_at = CASE
             WHEN state.rolled_back_at IS NULL AND decision.new_rollback_reason IS NOT NULL
               THEN $11::timestamptz
             ELSE state.rolled_back_at
           END,
           rollback_reason = COALESCE(state.rollback_reason, decision.new_rollback_reason),
           updated_at = $11::timestamptz
       FROM decision
       WHERE state.policy_version = $2 AND state.pricing_version = $3
         AND state.hash_key_version = $4 AND state.requested_model = $5
       RETURNING state.rolled_back_at IS NOT NULL AS rolled_back, state.rollback_reason
     )
     SELECT rolled_back, rollback_reason FROM updated_state`,
    [
      admission.admissionDate,
      admission.policyVersion,
      admission.pricingVersion,
      admission.hashKeyVersion,
      admission.requestedModel,
      outcome.status,
      failureReason,
      outcome.candidateLatencyMs,
      outcome.candidateCostMicros,
      outcome.fallbackLatencyMs ?? null,
      now,
      ROUTER_CANARY_ROLLBACK_POLICY.minimumCompleted,
      ROUTER_CANARY_ROLLBACK_POLICY.maximumFailureRate,
      ROUTER_CANARY_ROLLBACK_POLICY.maximumAverageLatencyMs,
      ROUTER_CANARY_ROLLBACK_POLICY.maximumAverageCostMicros,
    ],
  );
  const row = result.rows[0];
  return {
    recorded: Boolean(row),
    rolledBack: row?.rolled_back ?? false,
    rollbackReason: row?.rollback_reason ?? null,
  };
}

interface RouterCanarySummaryRow {
  hash_key_version: string;
  sample_bps: number;
  daily_limit: number;
  daily_budget_micros: number;
  reserved_cost_micros: number;
  deadline_ms: number;
  inflight_count: number;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  sampled_count: string;
  admitted_count: string;
  completed_count: string;
  quota_rejected_count: string;
  rollback_rejected_count: string;
  invalid_config_count: string;
  candidate_success_count: string;
  candidate_failure_count: string;
  fallback_success_count: string;
  fallback_safe_default_count: string;
  timeout_count: string;
  invalid_output_count: string;
  identity_error_count: string;
  provider_error_count: string;
  candidate_latency_ms_sum: string;
  candidate_latency_ms_max: number;
  candidate_cost_micros_sum: string;
  fallback_latency_ms_sum: string;
}

function count(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export interface RouterCanarySummary {
  days: number;
  scope: {
    policy_version: typeof ROUTER_CANARY_POLICY_VERSION;
    pricing_version: typeof ROUTER_CANARY_PRICING_VERSION;
    requested_provider: 'openai';
    requested_model: typeof OPENAI_ROUTER_MODEL;
    population: 'allowlisted_public_channel_full_model_router_only';
  };
  rollback_thresholds: typeof ROUTER_CANARY_ROLLBACK_POLICY;
  cohorts: Array<{
    hash_key_version: string;
    config: {
      sample_bps: number;
      daily_limit: number;
      daily_budget_micros: number;
      reserved_cost_micros: number;
      deadline_ms: number;
    };
    state: {
      inflight: number;
      rolled_back: boolean;
      rolled_back_at: string | null;
      rollback_reason: string | null;
    };
    admission: {
      sampled: number;
      admitted: number;
      quota_rejected: number;
      rollback_rejected: number;
      invalid_configuration: number;
    };
    outcomes: {
      completed: number;
      candidate_succeeded: number;
      candidate_failed: number;
      fallback_succeeded: number;
      fallback_safe_default: number;
      timeout: number;
      invalid_output: number;
      identity_or_capability_error: number;
      provider_error: number;
    };
    rates: {
      completion: number | null;
      candidate_success: number | null;
      fallback_safe_default: number | null;
    };
    candidate: {
      latency_ms_average: number | null;
      latency_ms_max: number | null;
      estimated_cost_micros: number;
      estimated_cost_micros_average: number | null;
    };
    fallback: { latency_ms_average: number | null };
  }>;
}

/** Aggregate-only operator visibility for the dormant or active canary. */
export async function getRouterCanarySummary(
  days = 7,
  dependencies: { query?: QueryFn } = {},
): Promise<RouterCanarySummary> {
  if (!Number.isInteger(days) || days < 1 || days > ROUTER_CANARY_SUMMARY_MAX_DAYS) {
    throw new RangeError('Invalid router canary summary window');
  }
  const runQuery = dependencies.query ?? defaultQuery as QueryFn;
  const result = await runQuery<RouterCanarySummaryRow>(
    `SELECT state.hash_key_version, state.sample_bps, state.daily_limit,
            state.daily_budget_micros, state.reserved_cost_micros,
            state.deadline_ms, state.inflight_count, state.rolled_back_at,
            state.rollback_reason,
            COALESCE(SUM(metrics.sampled_count), 0)::text AS sampled_count,
            COALESCE(SUM(metrics.admitted_count), 0)::text AS admitted_count,
            COALESCE(SUM(metrics.completed_count), 0)::text AS completed_count,
            COALESCE(SUM(metrics.quota_rejected_count), 0)::text AS quota_rejected_count,
            COALESCE(SUM(metrics.rollback_rejected_count), 0)::text AS rollback_rejected_count,
            COALESCE(SUM(metrics.invalid_config_count), 0)::text AS invalid_config_count,
            COALESCE(SUM(metrics.candidate_success_count), 0)::text AS candidate_success_count,
            COALESCE(SUM(metrics.candidate_failure_count), 0)::text AS candidate_failure_count,
            COALESCE(SUM(metrics.fallback_success_count), 0)::text AS fallback_success_count,
            COALESCE(SUM(metrics.fallback_safe_default_count), 0)::text
              AS fallback_safe_default_count,
            COALESCE(SUM(metrics.timeout_count), 0)::text AS timeout_count,
            COALESCE(SUM(metrics.invalid_output_count), 0)::text AS invalid_output_count,
            COALESCE(SUM(metrics.identity_error_count), 0)::text AS identity_error_count,
            COALESCE(SUM(metrics.provider_error_count), 0)::text AS provider_error_count,
            COALESCE(SUM(metrics.candidate_latency_ms_sum), 0)::text
              AS candidate_latency_ms_sum,
            COALESCE(MAX(metrics.candidate_latency_ms_max), 0)::integer
              AS candidate_latency_ms_max,
            COALESCE(SUM(metrics.candidate_cost_micros_sum), 0)::text
              AS candidate_cost_micros_sum,
            COALESCE(SUM(metrics.fallback_latency_ms_sum), 0)::text
              AS fallback_latency_ms_sum
     FROM addie_router_canary_state state
     LEFT JOIN addie_router_canary_daily_metrics metrics
       ON metrics.policy_version = state.policy_version
      AND metrics.pricing_version = state.pricing_version
      AND metrics.hash_key_version = state.hash_key_version
      AND metrics.requested_model = state.requested_model
      AND metrics.metric_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
        - ($1::integer - 1)
     WHERE state.policy_version = $2 AND state.pricing_version = $3
       AND state.requested_model = $4
     GROUP BY state.policy_version, state.pricing_version, state.requested_model,
              state.hash_key_version, state.sample_bps, state.daily_limit,
              state.daily_budget_micros, state.reserved_cost_micros,
              state.deadline_ms, state.inflight_count, state.rolled_back_at,
              state.rollback_reason, state.created_at
     ORDER BY state.created_at DESC`,
    [
      days,
      ROUTER_CANARY_POLICY_VERSION,
      ROUTER_CANARY_PRICING_VERSION,
      OPENAI_ROUTER_MODEL,
    ],
  );
  return {
    days,
    scope: {
      policy_version: ROUTER_CANARY_POLICY_VERSION,
      pricing_version: ROUTER_CANARY_PRICING_VERSION,
      requested_provider: 'openai',
      requested_model: OPENAI_ROUTER_MODEL,
      population: 'allowlisted_public_channel_full_model_router_only',
    },
    rollback_thresholds: ROUTER_CANARY_ROLLBACK_POLICY,
    cohorts: result.rows.map((row) => {
      const admitted = count(row.admitted_count);
      const completed = count(row.completed_count);
      const candidateSucceeded = count(row.candidate_success_count);
      const fallbackSafeDefault = count(row.fallback_safe_default_count);
      const candidateLatency = count(row.candidate_latency_ms_sum);
      const candidateCost = count(row.candidate_cost_micros_sum);
      const fallbackLatency = count(row.fallback_latency_ms_sum);
      return {
        hash_key_version: row.hash_key_version,
        config: {
          sample_bps: row.sample_bps,
          daily_limit: row.daily_limit,
          daily_budget_micros: row.daily_budget_micros,
          reserved_cost_micros: row.reserved_cost_micros,
          deadline_ms: row.deadline_ms,
        },
        state: {
          inflight: row.inflight_count,
          rolled_back: row.rolled_back_at !== null,
          rolled_back_at: row.rolled_back_at?.toISOString() ?? null,
          rollback_reason: row.rollback_reason,
        },
        admission: {
          sampled: count(row.sampled_count),
          admitted,
          quota_rejected: count(row.quota_rejected_count),
          rollback_rejected: count(row.rollback_rejected_count),
          invalid_configuration: count(row.invalid_config_count),
        },
        outcomes: {
          completed,
          candidate_succeeded: candidateSucceeded,
          candidate_failed: count(row.candidate_failure_count),
          fallback_succeeded: count(row.fallback_success_count),
          fallback_safe_default: fallbackSafeDefault,
          timeout: count(row.timeout_count),
          invalid_output: count(row.invalid_output_count),
          identity_or_capability_error: count(row.identity_error_count),
          provider_error: count(row.provider_error_count),
        },
        rates: {
          completion: admitted > 0 ? completed / admitted : null,
          candidate_success: completed > 0 ? candidateSucceeded / completed : null,
          fallback_safe_default: completed > 0 ? fallbackSafeDefault / completed : null,
        },
        candidate: {
          latency_ms_average: completed > 0 ? candidateLatency / completed : null,
          latency_ms_max: completed > 0 ? row.candidate_latency_ms_max : null,
          estimated_cost_micros: candidateCost,
          estimated_cost_micros_average: completed > 0 ? candidateCost / completed : null,
        },
        fallback: {
          latency_ms_average: count(row.candidate_failure_count) > 0
            ? fallbackLatency / count(row.candidate_failure_count)
            : null,
        },
      };
    }),
  };
}
