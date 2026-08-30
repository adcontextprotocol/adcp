import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { getClient, query } from '../../db/client.js';
import { isUuid } from '../../utils/uuid.js';
import type { InvocationPreparedSnapshot } from '../claude-client.js';
import { CODE_VERSION } from '../config-version.js';
import type { MemberContext } from '../member-context.js';
import type { ModelProviderId } from '../model-providers/model-provider.js';
import type { SIRetrievalResult } from '../services/si-retriever.js';
import type { ThreadContext } from '../thread-service.js';
import type { ChannelRespondPlan, ChannelResponseInvocation } from '../bolt-app.js';
import { providerForModel, SHADOW_REPLAY_POLICY_VERSION } from './shadow-eval-metadata.js';
import {
  OFFICIAL_DOCS_ALLOWED_TOOLS,
  OFFICIAL_DOCS_POLICY_VERSION,
  OFFICIAL_DOCS_PROFILE,
  canonicalOfficialDocsPlan,
  isOfficialDocsProfile,
} from './shadow-replay-cohort.js';
import { resolveShadowReplayPricing } from './shadow-replay-pricing.js';

export const SHADOW_REPLAY_TRACE_CAPTURE_VERSION = 3 as const;
export const SHADOW_REPLAY_TRACE_HASH_DOMAIN = 'addie-shadow-replay-trace:v3' as const;
export const SHADOW_REPLAY_JUDGMENT_POLICY_VERSION = 'official-docs-judgment:v1' as const;
const TRACE_EXPIRY_MS = 60 * 60 * 1000;
const TRACE_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

interface TraceKeyConfig {
  key: string;
  version: string;
}

export interface ShadowReplayCaptureIdentity {
  traceId: string;
  salt: string;
  hashKey: string;
  hashDomain: typeof SHADOW_REPLAY_TRACE_HASH_DOMAIN;
  keyVersion: string;
}

export interface ShadowReplayHumanEvidenceInput {
  slackMessageTs: string;
  userId: string;
  content: string;
}

export interface ShadowReplayHumanEvidenceReference {
  slackMessageTs: string;
  userHmac: string;
  contentHmac: string;
}

export interface QueueShadowReplayTraceInput {
  attemptId: string;
  identity: ShadowReplayCaptureIdentity;
  threadId: string;
  sourceQuestionMessageId: string;
  sourceUserId: string;
  channelId: string;
  threadTs: string;
  questionTs: string;
  question: string;
  sourceConfigVersionId: number;
  memberContext: MemberContext | null;
  channelContext?: ThreadContext;
  plan: ChannelRespondPlan;
  siRetrievalResult: SIRetrievalResult | null;
  invocation: ChannelResponseInvocation;
  snapshot: InvocationPreparedSnapshot;
  docsCorpusFingerprint: string;
  providerWebSearchEnabled: boolean;
  humanEvidence?: ShadowReplayHumanEvidenceInput | null;
  now?: Date;
}

interface TraceRow extends QueryResultRow {
  trace_id: string;
  capture_version: number;
  capture_parity_verified: boolean;
  thread_id: string;
  source_question_message_id: string;
  source_slack_message_ts: string;
  source_config_version_id: number;
  hash_key_version: string;
  policy_version: string;
  capture_salt: string;
  effective_model: string;
  si_retrieval_present: boolean;
  provider_web_search_enabled: boolean;
  capability_profile: string | null;
  capability_policy_version: string | null;
  approved_tool_names: string[];
  message_count: number;
  question_hmac: string;
  source_binding_hmac: string;
  member_context_hmac: string;
  channel_context_hmac: string;
  plan_hmac: string;
  si_retrieval_hmac: string;
  request_context_hmac: string;
  docs_corpus_hmac: string;
  system_block_hmacs: Array<{ index: number; sha256: string }>;
  tool_schema_hmacs: Array<{ index: number; name: string; sha256: string }>;
  message_payload_hmacs: Array<{ index: number; sha256: string }>;
  provider_request_hmac: string | null;
  human_response_slack_message_ts: string | null;
  human_response_user_hmac: string | null;
  human_response_content_hmac: string | null;
  authorization_hmac: string;
  created_at: Date | string;
  expires_at: Date | string;
  retained_until: Date | string;
  revoked_at: Date | string | null;
}

interface TraceSourceRow extends QueryResultRow {
  question: string;
  source_user_id: string | null;
  router_decision: unknown;
  thread_external_id: string;
  thread_channel: string;
}

export interface PendingShadowReplayCapture extends QueryResultRow {
  trace_id: string;
  thread_id: string;
}

export type ShadowReplayCaptureStatus = 'verified' | 'skipped' | 'error';

export interface ShadowReplayCaptureSummaryRow extends QueryResultRow {
  status: string;
  reason: string;
  count: number;
}

export type ShadowReplayGenerationStatus = 'succeeded' | 'blocked' | 'error';

export interface ShadowReplayInvocationEvidence {
  iteration: number;
  attempt: number;
  provider_request_hmac: string;
}

export interface ShadowReplayToolEvidence {
  sequence: number;
  name: 'search_docs' | 'get_doc' | 'unapproved_tool';
  schema_hmac: string | null;
  input_hmac: string;
  result_hmac: string;
  disposition: 'live_read' | 'blocked_unknown' | 'blocked_policy' | 'error';
}

export interface ShadowReplayGenerationCompletion {
  status: ShadowReplayGenerationStatus;
  reason: string;
  outputHmac: string | null;
  outputBytes: number;
  invocations: ShadowReplayInvocationEvidence[];
  toolExecutions: ShadowReplayToolEvidence[];
  blockedCapabilities: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usageAvailable: boolean;
  latencyMs: number | null;
  returnedProvider?: ModelProviderId | null;
  returnedModel?: string | null;
}

export interface ShadowReplayGenerationTarget {
  provider: ModelProviderId;
  model: string;
  firstProviderRequestHmac: string;
}

export type ShadowReplayGenerationClaimDecision =
  | 'claimed'
  | 'already_claimed'
  | 'daily_limit_reached'
  | 'trace_unavailable';

export interface ShadowReplayGenerationSummaryRow extends QueryResultRow {
  capture_version: number;
  capture_policy_version: string;
  source_config_version_id: number;
  source_model: string;
  requested_provider: ModelProviderId;
  requested_model: string;
  addie_code_version: string;
  execution_policy_version: string;
  pricing_version: string;
  returned_provider: ModelProviderId | null;
  returned_model: string | null;
  status: string;
  reason: string;
  count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_complete_count: number;
  latency_count: number;
  estimated_cost_micros: string;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

export type ShadowReplayJudgmentStatus = 'judged' | 'deterministic_failure' | 'skipped' | 'error';
export type ShadowReplayGapSeverity = 'none' | 'minor' | 'significant' | 'critical';
export type ShadowReplayQuality = 'better' | 'equivalent' | 'worse' | 'different_focus';
export type ShadowReplayJudgeProvider = 'anthropic' | 'openai' | 'google' | 'unknown';

/** Hash-only judgment completion. Raw question/answer/reply text is intentionally absent. */
export interface ShadowReplayJudgmentCompletion {
  status: ShadowReplayJudgmentStatus;
  reason: string;
  evaluationValid: boolean;
  evaluationSkipped: boolean;
  knowledgeGap: boolean | null;
  gapSeverity: ShadowReplayGapSeverity | null;
  shadowQuality: ShadowReplayQuality | null;
  deterministicFailureLabels: string[];
  shapeWordCount: number;
  shapeExpectedMaxWords: number;
  shapeRatioToExpected: number;
  judgeProvider: ShadowReplayJudgeProvider | null;
  judgeModel: string | null;
  selfJudged: boolean | null;
  judgePromptVersion: string | null;
  judgePromptHmac: string | null;
  judgeRequestHmac: string | null;
  judgeResponseHmac: string | null;
  sourceOutputHmac: string | null;
  humanEvidenceContentHmac: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usageAvailable: boolean;
  pricingVersion: string;
  latencyMs: number | null;
  startedAt: Date;
  completedAt: Date;
}

export interface ShadowReplayJudgmentSummaryRow extends QueryResultRow {
  capture_version: number;
  capture_policy_version: string;
  source_config_version_id: number;
  source_model: string;
  has_human_evidence: boolean;
  requested_provider: ModelProviderId;
  requested_model: string;
  addie_code_version: string;
  execution_policy_version: string;
  returned_provider: ModelProviderId | null;
  returned_model: string | null;
  judgment_policy_version: string;
  judge_provider: ShadowReplayJudgeProvider | null;
  judge_model: string | null;
  self_judged: boolean | null;
  judge_prompt_version: string | null;
  pricing_version: string;
  status: string;
  reason: string;
  evaluation_valid: boolean;
  evaluation_skipped: boolean;
  knowledge_gap: boolean | null;
  gap_severity: ShadowReplayGapSeverity | null;
  shadow_quality: ShadowReplayQuality | null;
  deterministic_failure_labels: string[];
  count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usage_complete_count: number;
  latency_count: number;
  estimated_cost_micros: string;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}

export interface ShadowReplayFunnelSummary extends QueryResultRow {
  opportunities: number;
  traces_captured: number;
  parity_verified: number;
  capture_verified: number;
  capture_pending: number;
  capture_skipped: number;
  capture_error: number;
  generation_claimed: number;
  generation_succeeded: number;
  generation_blocked: number;
  generation_error: number;
  generation_running: number;
  judgment_judged: number;
  judgment_deterministic_failure: number;
  judgment_skipped: number;
  judgment_error: number;
  judgment_missing: number;
}

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

export type ShadowReplayTraceDenialReason =
  | 'invalid_trace_id'
  | 'trace_not_found'
  | 'trace_capture_version_mismatch'
  | 'trace_key_unavailable'
  | 'trace_key_version_mismatch'
  | 'trace_policy_version_mismatch'
  | 'trace_expired'
  | 'trace_revoked'
  | 'trace_authorization_invalid'
  | 'trace_thread_mismatch'
  | 'trace_source_invalid'
  | 'trace_human_evidence_invalid'
  | 'trace_capability_profile_unsupported'
  | 'trace_provider_tools_unsupported'
  | 'trace_si_context_unsupported';

export interface ResolvedShadowReplayTrace {
  identity: ShadowReplayCaptureIdentity;
  traceId: string;
  threadId: string;
  sourceQuestionMessageId: string;
  sourceUserId: string;
  sourceConfigVersionId: number;
  channelId: string;
  threadTs: string;
  questionTs: string;
  question: string;
  routerDecision: unknown;
  humanEvidence: ShadowReplayHumanEvidenceReference | null;
  expected: TraceRow;
}

export type ResolveShadowReplayTraceResult =
  | { authorized: true; trace: ResolvedShadowReplayTrace }
  | { authorized: false; reason: ShadowReplayTraceDenialReason };

export function buildShadowEvalQueueContext(
  traceId: string,
  attemptId: string,
  requestedAt: Date = new Date(),
): Record<string, unknown> {
  return {
    shadow_eval_status: 'pending',
    shadow_eval_requested_at: requestedAt.toISOString(),
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_trace_id: traceId,
    shadow_eval_capture_attempt_id: attemptId,
  };
}

export async function beginShadowReplayCaptureAttempt(
  input: {
    threadId: string;
    sourceQuestionMessageId: string | null;
    now?: Date;
  },
  dependencies: { query?: QueryFn } = {},
): Promise<string> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const attemptId = randomUUID();
  const now = input.now ?? new Date();
  const retainedUntil = new Date(now.getTime() + TRACE_RETENTION_MS);
  const context = {
    shadow_eval_status: 'pending',
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_requested_at: now.toISOString(),
    shadow_eval_capture_attempt_id: attemptId,
  };
  const result = await runQuery<{ attempt_id: string }>(
    `WITH inserted AS (
       INSERT INTO addie_shadow_replay_capture_attempts (
         attempt_id, thread_id, source_question_message_id,
         capability_profile, capture_version, created_at, retained_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING attempt_id, thread_id
     )
     UPDATE addie_threads thread
     SET context = (
       COALESCE(thread.context, '{}'::jsonb) - ARRAY[
         'shadow_eval_trace_id', 'shadow_eval_capture_parity_verified',
         'shadow_eval_replay_drift_reasons', 'shadow_eval_completed_at',
         'shadow_eval_replay_error'
       ]::text[]
     ) || $8::jsonb,
         updated_at = NOW()
     FROM inserted
     WHERE thread.thread_id = inserted.thread_id
     RETURNING inserted.attempt_id`,
    [
      attemptId,
      input.threadId,
      input.sourceQuestionMessageId,
      OFFICIAL_DOCS_PROFILE,
      SHADOW_REPLAY_TRACE_CAPTURE_VERSION,
      now,
      retainedUntil,
      JSON.stringify(context),
    ],
  );
  if (result.rows[0]?.attempt_id !== attemptId) {
    throw new Error('shadow_replay_capture_attempt_thread_not_found');
  }
  return attemptId;
}

export async function completeShadowReplayCaptureAttempt(
  attemptId: string,
  threadId: string,
  outcome: { status: 'skipped' | 'error'; reason: string },
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<boolean> {
  if (!isUuid(attemptId) || !isUuid(threadId)) return false;
  if (!/^[a-z0-9_]{1,96}$/.test(outcome.reason)) {
    throw new Error('shadow_replay_capture_reason_invalid');
  }
  const runQuery = dependencies.query ?? query as QueryFn;
  const completedAt = dependencies.now ?? new Date();
  const context = {
    shadow_eval_status: outcome.status,
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_completed_at: completedAt.toISOString(),
    shadow_eval_replay_error: outcome.reason,
    shadow_eval_capture_attempt_id: attemptId,
  };
  const result = await runQuery<{ completed: boolean }>(
    `WITH completed AS (
       UPDATE addie_shadow_replay_capture_attempts
       SET status = $3, reason = $4, completed_at = $5
       WHERE attempt_id = $1
         AND thread_id = $2
         AND status = 'pending'
       RETURNING attempt_id, thread_id
     ), patched AS (
       UPDATE addie_threads thread
       SET context = (
         COALESCE(thread.context, '{}'::jsonb) - ARRAY[
           'shadow_eval_trace_id', 'shadow_eval_capture_parity_verified',
           'shadow_eval_replay_drift_reasons'
         ]::text[]
       ) || $6::jsonb,
           updated_at = NOW()
       FROM completed
       WHERE thread.thread_id = completed.thread_id
         AND thread.context->>'shadow_eval_capture_attempt_id' = completed.attempt_id::text
       RETURNING thread.thread_id
     )
     SELECT EXISTS (SELECT 1 FROM completed) AS completed`,
    [attemptId, threadId, outcome.status, outcome.reason, completedAt, JSON.stringify(context)],
  );
  return result.rows[0]?.completed === true;
}

export function suppressedOpportunityFlagReason(
  kind: 'humans_already_answering' | 'human_replied_during_delay',
): string {
  return kind === 'humans_already_answering'
    ? 'Suppressed high-confidence response (humans already answering)'
    : 'Suppressed high-confidence response (human replied during delay)';
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const serializable = typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
    if (serializable !== value) return stableJson(serializable);
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function resolveTraceKeyConfig(): TraceKeyConfig | null {
  const key = process.env.SHADOW_EVAL_TRACE_KEY?.trim();
  const version = process.env.SHADOW_EVAL_TRACE_KEY_VERSION?.trim();
  if (!key || !version || key.length < 32) return null;
  return { key, version };
}

function deriveTraceKey(config: TraceKeyConfig, traceId: string, salt: string): string {
  return createHmac('sha256', config.key)
    .update(`${SHADOW_REPLAY_TRACE_HASH_DOMAIN}\0${traceId}\0${salt}`, 'utf8')
    .digest('hex');
}

function digest(identity: ShadowReplayCaptureIdentity, purpose: string, value: unknown): string {
  return createHmac('sha256', identity.hashKey)
    .update(`${SHADOW_REPLAY_TRACE_HASH_DOMAIN}\0${purpose}\0`, 'utf8')
    .update(stableJson(value), 'utf8')
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function slackTimestampMicros(value: string): bigint | null {
  const match = /^(\d{1,20})\.(\d{1,6})$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000n + BigInt(match[2].padEnd(6, '0'));
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function sourceBinding(input: {
  threadId: string;
  sourceQuestionMessageId: string;
  sourceUserId: string;
  channelId: string;
  threadTs: string;
  questionTs: string;
  sourceConfigVersionId: number;
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    sourceQuestionMessageId: input.sourceQuestionMessageId,
    sourceUserId: input.sourceUserId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    questionTs: input.questionTs,
    sourceConfigVersionId: input.sourceConfigVersionId,
  };
}

function authorizationPayload(row: {
  trace_id: string;
  capture_version: number;
  thread_id: string;
  source_question_message_id: string;
  source_slack_message_ts: string;
  source_config_version_id: number;
  hash_key_version: string;
  policy_version: string;
  capture_salt: string;
  effective_model: string;
  si_retrieval_present: boolean;
  provider_web_search_enabled: boolean;
  capability_profile: string | null;
  capability_policy_version: string | null;
  approved_tool_names: string[];
  message_count: number;
  question_hmac: string;
  source_binding_hmac: string;
  member_context_hmac: string;
  channel_context_hmac: string;
  plan_hmac: string;
  si_retrieval_hmac: string;
  request_context_hmac: string;
  docs_corpus_hmac: string;
  system_block_hmacs: Array<{ index: number; sha256: string }>;
  tool_schema_hmacs: Array<{ index: number; name: string; sha256: string }>;
  message_payload_hmacs: Array<{ index: number; sha256: string }>;
  provider_request_hmac: string | null;
  human_response_slack_message_ts: string | null;
  human_response_user_hmac: string | null;
  human_response_content_hmac: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  retained_until: Date | string;
}): Record<string, unknown> {
  return {
    trace_id: row.trace_id,
    capture_version: row.capture_version,
    thread_id: row.thread_id,
    source_question_message_id: row.source_question_message_id,
    source_slack_message_ts: row.source_slack_message_ts,
    source_config_version_id: row.source_config_version_id,
    hash_key_version: row.hash_key_version,
    policy_version: row.policy_version,
    capture_salt: row.capture_salt,
    effective_model: row.effective_model,
    si_retrieval_present: row.si_retrieval_present,
    provider_web_search_enabled: row.provider_web_search_enabled,
    capability_profile: row.capability_profile,
    capability_policy_version: row.capability_policy_version,
    approved_tool_names: row.approved_tool_names,
    message_count: row.message_count,
    question_hmac: row.question_hmac,
    source_binding_hmac: row.source_binding_hmac,
    member_context_hmac: row.member_context_hmac,
    channel_context_hmac: row.channel_context_hmac,
    plan_hmac: row.plan_hmac,
    si_retrieval_hmac: row.si_retrieval_hmac,
    request_context_hmac: row.request_context_hmac,
    docs_corpus_hmac: row.docs_corpus_hmac,
    system_block_hmacs: row.system_block_hmacs,
    tool_schema_hmacs: row.tool_schema_hmacs,
    message_payload_hmacs: row.message_payload_hmacs,
    provider_request_hmac: row.provider_request_hmac,
    human_response_slack_message_ts: row.human_response_slack_message_ts,
    human_response_user_hmac: row.human_response_user_hmac,
    human_response_content_hmac: row.human_response_content_hmac,
    created_at: timestamp(row.created_at),
    expires_at: timestamp(row.expires_at),
    retained_until: timestamp(row.retained_until),
  };
}

export function createShadowReplayCaptureIdentity(
  config: TraceKeyConfig | null = resolveTraceKeyConfig(),
): ShadowReplayCaptureIdentity {
  if (!config) throw new Error('shadow_replay_trace_key_unavailable');
  const traceId = randomUUID();
  const salt = randomBytes(16).toString('hex');
  return {
    traceId,
    salt,
    hashKey: deriveTraceKey(config, traceId, salt),
    hashDomain: SHADOW_REPLAY_TRACE_HASH_DOMAIN,
    keyVersion: config.version,
  };
}

export async function queueShadowReplayTrace(
  input: QueueShadowReplayTraceInput,
  dependencies: { getClient?: typeof getClient } = {},
): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TRACE_EXPIRY_MS);
  const retainedUntil = new Date(now.getTime() + TRACE_RETENTION_MS);
  const source = sourceBinding(input);
  if (!isOfficialDocsProfile(input.plan)) {
    throw new Error('shadow_replay_trace_capability_profile_unsupported');
  }
  const signedPlan = canonicalOfficialDocsPlan(input.plan);
  const capturedToolNames = input.snapshot.tool_schemas.map(({ name }) => name);
  if (
    capturedToolNames.length !== OFFICIAL_DOCS_ALLOWED_TOOLS.length
    || !OFFICIAL_DOCS_ALLOWED_TOOLS.every((name, index) => capturedToolNames[index] === name)
  ) {
    throw new Error('shadow_replay_trace_tool_boundary_mismatch');
  }
  const humanEvidence = input.humanEvidence ?? null;
  const questionTimestampMicros = slackTimestampMicros(input.questionTs);
  const humanTimestampMicros = humanEvidence
    ? slackTimestampMicros(humanEvidence.slackMessageTs)
    : null;
  if (humanEvidence && (
    humanEvidence.slackMessageTs.length < 1
    || humanEvidence.slackMessageTs.length > 64
    || /\s/.test(humanEvidence.slackMessageTs)
    || humanEvidence.userId.length < 1
    || humanEvidence.userId.length > 64
    || /\s/.test(humanEvidence.userId)
    || Buffer.byteLength(humanEvidence.content.trim(), 'utf8') < 20
    || Buffer.byteLength(humanEvidence.content.trim(), 'utf8') > 1_500
    || questionTimestampMicros === null
    || humanTimestampMicros === null
    || humanTimestampMicros <= questionTimestampMicros
  )) {
    throw new Error('shadow_replay_human_evidence_invalid');
  }
  const unsigned = {
    trace_id: input.identity.traceId,
    capture_version: SHADOW_REPLAY_TRACE_CAPTURE_VERSION,
    thread_id: input.threadId,
    source_question_message_id: input.sourceQuestionMessageId,
    source_slack_message_ts: input.questionTs,
    source_config_version_id: input.sourceConfigVersionId,
    hash_key_version: input.identity.keyVersion,
    policy_version: SHADOW_REPLAY_POLICY_VERSION,
    capture_salt: input.identity.salt,
    effective_model: input.invocation.effectiveModel,
    si_retrieval_present: input.siRetrievalResult !== null,
    provider_web_search_enabled: input.providerWebSearchEnabled,
    capability_profile: OFFICIAL_DOCS_PROFILE,
    capability_policy_version: OFFICIAL_DOCS_POLICY_VERSION,
    approved_tool_names: [...OFFICIAL_DOCS_ALLOWED_TOOLS],
    message_count: input.snapshot.message_count,
    question_hmac: digest(input.identity, 'question', input.question),
    source_binding_hmac: digest(input.identity, 'source-binding', source),
    member_context_hmac: digest(input.identity, 'member-context', input.memberContext),
    channel_context_hmac: digest(input.identity, 'channel-context', input.channelContext ?? null),
    plan_hmac: digest(input.identity, 'router-plan', signedPlan),
    si_retrieval_hmac: digest(input.identity, 'si-retrieval', input.siRetrievalResult),
    request_context_hmac: digest(
      input.identity,
      'request-context',
      input.invocation.processOptions.requestContext ?? null,
    ),
    docs_corpus_hmac: digest(input.identity, 'docs-corpus', input.docsCorpusFingerprint),
    system_block_hmacs: input.snapshot.system_blocks,
    tool_schema_hmacs: input.snapshot.tool_schemas,
    message_payload_hmacs: input.snapshot.message_payloads,
    provider_request_hmac: input.snapshot.provider_request_sha256,
    human_response_slack_message_ts: humanEvidence?.slackMessageTs ?? null,
    human_response_user_hmac: humanEvidence
      ? digest(input.identity, 'human-response-user', humanEvidence.userId)
      : null,
    human_response_content_hmac: humanEvidence
      ? digest(input.identity, 'human-response-content', humanEvidence.content)
      : null,
    created_at: now,
    expires_at: expiresAt,
    retained_until: retainedUntil,
  };
  const authorizationHmac = digest(
    input.identity,
    'authorization',
    authorizationPayload(unsigned),
  );

  const acquireClient = dependencies.getClient ?? getClient;
  const client = await acquireClient();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const inserted = await client.query(
      `INSERT INTO addie_shadow_replay_traces (
         trace_id, capture_version, thread_id, source_question_message_id,
         source_slack_message_ts, source_config_version_id, hash_key_version,
         policy_version, capture_salt, effective_model, si_retrieval_present,
         provider_web_search_enabled, capability_profile,
         capability_policy_version, approved_tool_names, message_count, question_hmac,
         source_binding_hmac, member_context_hmac, channel_context_hmac,
         plan_hmac, si_retrieval_hmac, request_context_hmac, docs_corpus_hmac,
         system_block_hmacs, tool_schema_hmacs, message_payload_hmacs,
         provider_request_hmac, human_response_slack_message_ts,
         human_response_user_hmac, human_response_content_hmac, authorization_hmac,
         created_at, expires_at, retained_until
       ) SELECT
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24,
         $25::jsonb, $26::jsonb, $27::jsonb, $28, $29, $30, $31, $32, $33, $34, $35
       WHERE EXISTS (
         SELECT 1
         FROM addie_thread_messages source
         WHERE source.message_id = $4
           AND source.thread_id = $3
           AND source.role = 'user'
           AND source.message_source = 'typed'
       )`,
      [
        unsigned.trace_id,
        unsigned.capture_version,
        unsigned.thread_id,
        unsigned.source_question_message_id,
        unsigned.source_slack_message_ts,
        unsigned.source_config_version_id,
        unsigned.hash_key_version,
        unsigned.policy_version,
        unsigned.capture_salt,
        unsigned.effective_model,
        unsigned.si_retrieval_present,
        unsigned.provider_web_search_enabled,
        unsigned.capability_profile,
        unsigned.capability_policy_version,
        JSON.stringify(unsigned.approved_tool_names),
        unsigned.message_count,
        unsigned.question_hmac,
        unsigned.source_binding_hmac,
        unsigned.member_context_hmac,
        unsigned.channel_context_hmac,
        unsigned.plan_hmac,
        unsigned.si_retrieval_hmac,
        unsigned.request_context_hmac,
        unsigned.docs_corpus_hmac,
        JSON.stringify(unsigned.system_block_hmacs),
        JSON.stringify(unsigned.tool_schema_hmacs),
        JSON.stringify(unsigned.message_payload_hmacs),
        unsigned.provider_request_hmac,
        unsigned.human_response_slack_message_ts,
        unsigned.human_response_user_hmac,
        unsigned.human_response_content_hmac,
        authorizationHmac,
        now,
        expiresAt,
        retainedUntil,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error('shadow_replay_trace_source_not_found');
    const linkedAttempt = await client.query(
      `UPDATE addie_shadow_replay_capture_attempts
       SET status = 'captured', reason = 'trace_queued', trace_id = $2, completed_at = $3
       WHERE attempt_id = $1
         AND thread_id = $4
         AND source_question_message_id = $5
         AND capture_version = $6
         AND status = 'pending'`,
      [
        input.attemptId,
        input.identity.traceId,
        now,
        input.threadId,
        input.sourceQuestionMessageId,
        SHADOW_REPLAY_TRACE_CAPTURE_VERSION,
      ],
    );
    if (linkedAttempt.rowCount !== 1) {
      throw new Error('shadow_replay_capture_attempt_invalid');
    }
    const queued = await client.query(
      `UPDATE addie_threads
       SET context = (
         COALESCE(context, '{}'::jsonb) - ARRAY[
           'shadow_eval_channel_id', 'shadow_eval_thread_ts', 'shadow_eval_question_ts',
           'shadow_eval_tool_sets', 'shadow_eval_question',
           'shadow_eval_source_question_message_id', 'shadow_eval_source_message_id',
           'shadow_eval_source_user_id', 'shadow_eval_source_config_version_id',
           'shadow_eval_router_decision', 'shadow_eval_si_retrieval'
         ]::text[]
       ) || $2::jsonb,
       updated_at = NOW()
       WHERE thread_id = $1
         AND context->>'shadow_eval_capture_attempt_id' = $3`,
      [
        input.threadId,
        JSON.stringify(buildShadowEvalQueueContext(
          input.identity.traceId,
          input.attemptId,
          now,
        )),
        input.attemptId,
      ],
    );
    if (queued.rowCount !== 1) throw new Error('shadow_replay_trace_thread_not_found');
    await client.query('COMMIT');
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveShadowReplayTrace(
  traceId: string,
  dependencies: {
    query?: QueryFn;
    keyConfig?: TraceKeyConfig | null;
    now?: Date;
    expectedThreadId?: string;
  } = {},
): Promise<ResolveShadowReplayTraceResult> {
  if (!isUuid(traceId)) return { authorized: false, reason: 'invalid_trace_id' };
  const runQuery = dependencies.query ?? query as QueryFn;
  // Load and authenticate bounded metadata before touching canonical private
  // source content. Unsupported traces are rejected after this first query.
  const result = await runQuery<TraceRow>(
    `SELECT trace.*
     FROM addie_shadow_replay_traces trace
     WHERE trace.trace_id = $1`,
    [traceId],
  );
  const row = result.rows[0];
  if (!row) return { authorized: false, reason: 'trace_not_found' };
  if (row.capture_version !== SHADOW_REPLAY_TRACE_CAPTURE_VERSION) {
    return { authorized: false, reason: 'trace_capture_version_mismatch' };
  }
  if (row.policy_version !== SHADOW_REPLAY_POLICY_VERSION) {
    return { authorized: false, reason: 'trace_policy_version_mismatch' };
  }
  const config = dependencies.keyConfig === undefined
    ? resolveTraceKeyConfig()
    : dependencies.keyConfig;
  if (!config) return { authorized: false, reason: 'trace_key_unavailable' };
  if (config.version !== row.hash_key_version) {
    return { authorized: false, reason: 'trace_key_version_mismatch' };
  }
  const now = dependencies.now ?? new Date();
  if (row.revoked_at) return { authorized: false, reason: 'trace_revoked' };
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return { authorized: false, reason: 'trace_expired' };
  }

  const identity: ShadowReplayCaptureIdentity = {
    traceId: row.trace_id,
    salt: row.capture_salt,
    hashKey: deriveTraceKey(config, row.trace_id, row.capture_salt),
    hashDomain: SHADOW_REPLAY_TRACE_HASH_DOMAIN,
    keyVersion: config.version,
  };
  const expectedAuthorization = digest(
    identity,
    'authorization',
    authorizationPayload(row),
  );
  if (!equalDigest(expectedAuthorization, row.authorization_hmac)) {
    return { authorized: false, reason: 'trace_authorization_invalid' };
  }
  const humanEvidenceValues = [
    row.human_response_slack_message_ts,
    row.human_response_user_hmac,
    row.human_response_content_hmac,
  ];
  if (
    !humanEvidenceValues.every((value) => value === null)
    && !(
      humanEvidenceValues.every((value) => value !== null)
      && row.human_response_slack_message_ts!.length <= 64
      && !/\s/.test(row.human_response_slack_message_ts!)
      && HMAC.test(row.human_response_user_hmac!)
      && HMAC.test(row.human_response_content_hmac!)
      && slackTimestampMicros(row.source_slack_message_ts) !== null
      && slackTimestampMicros(row.human_response_slack_message_ts!) !== null
      && slackTimestampMicros(row.human_response_slack_message_ts!)! >
        slackTimestampMicros(row.source_slack_message_ts)!
    )
  ) {
    return { authorized: false, reason: 'trace_human_evidence_invalid' };
  }
  if (dependencies.expectedThreadId && row.thread_id !== dependencies.expectedThreadId) {
    return { authorized: false, reason: 'trace_thread_mismatch' };
  }
  if (
    row.capability_profile !== OFFICIAL_DOCS_PROFILE
    || row.capability_policy_version !== OFFICIAL_DOCS_POLICY_VERSION
    || row.approved_tool_names.length !== OFFICIAL_DOCS_ALLOWED_TOOLS.length
    || !OFFICIAL_DOCS_ALLOWED_TOOLS.every(
      (name, index) => row.approved_tool_names[index] === name,
    )
    || row.tool_schema_hmacs.length !== OFFICIAL_DOCS_ALLOWED_TOOLS.length
    || !OFFICIAL_DOCS_ALLOWED_TOOLS.every(
      (name, index) => row.tool_schema_hmacs[index]?.name === name,
    )
    || !row.provider_request_hmac
  ) {
    return { authorized: false, reason: 'trace_capability_profile_unsupported' };
  }
  if (row.provider_web_search_enabled) {
    return { authorized: false, reason: 'trace_provider_tools_unsupported' };
  }
  if (row.si_retrieval_present) {
    return { authorized: false, reason: 'trace_si_context_unsupported' };
  }

  const sourceResult = await runQuery<TraceSourceRow>(
    `SELECT
       message.content AS question,
       message.user_id AS source_user_id,
       message.router_decision,
       thread.external_id AS thread_external_id,
       thread.channel AS thread_channel
     FROM addie_shadow_replay_traces trace
     JOIN addie_thread_messages message
       ON message.message_id = trace.source_question_message_id
      AND message.thread_id = trace.thread_id
      AND message.role = 'user'
      AND message.message_source = 'typed'
     JOIN addie_threads thread ON thread.thread_id = trace.thread_id
     WHERE trace.trace_id = $1`,
    [traceId],
  );
  const source = sourceResult.rows[0];
  if (!source) return { authorized: false, reason: 'trace_source_invalid' };

  const [channelId, threadTs] = source.thread_external_id.split(':', 2);
  if (
    source.thread_channel !== 'slack'
    || !source.source_user_id
    || !channelId
    || !threadTs
    || !equalDigest(digest(identity, 'question', source.question), row.question_hmac)
    || !equalDigest(digest(identity, 'router-plan', source.router_decision), row.plan_hmac)
    || !equalDigest(
      digest(identity, 'source-binding', sourceBinding({
        threadId: row.thread_id,
        sourceQuestionMessageId: row.source_question_message_id,
        sourceUserId: source.source_user_id,
        channelId,
        threadTs,
        questionTs: row.source_slack_message_ts,
        sourceConfigVersionId: row.source_config_version_id,
      })),
      row.source_binding_hmac,
    )
  ) {
    return { authorized: false, reason: 'trace_source_invalid' };
  }
  return {
    authorized: true,
    trace: {
      identity,
      traceId: row.trace_id,
      threadId: row.thread_id,
      sourceQuestionMessageId: row.source_question_message_id,
      sourceUserId: source.source_user_id,
      sourceConfigVersionId: row.source_config_version_id,
      channelId,
      threadTs,
      questionTs: row.source_slack_message_ts,
      question: source.question,
      routerDecision: source.router_decision,
      humanEvidence: row.human_response_slack_message_ts === null
        ? null
        : {
          slackMessageTs: row.human_response_slack_message_ts,
          userHmac: row.human_response_user_hmac!,
          contentHmac: row.human_response_content_hmac!,
        },
      expected: row,
    },
  };
}

/** Verify exact source evidence without persisting or returning its raw author/content. */
export function verifyShadowReplayHumanEvidence(
  trace: ResolvedShadowReplayTrace,
  candidate: ShadowReplayHumanEvidenceInput,
): { verified: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!trace.humanEvidence) return { verified: false, reasons: ['human_evidence_unavailable'] };
  if (
    candidate.slackMessageTs.length < 1
    || candidate.slackMessageTs.length > 64
    || /\s/.test(candidate.slackMessageTs)
    || candidate.userId.length < 1
    || candidate.userId.length > 64
    || /\s/.test(candidate.userId)
    || Buffer.byteLength(candidate.content.trim(), 'utf8') < 20
    || Buffer.byteLength(candidate.content.trim(), 'utf8') > 1_500
  ) {
    return { verified: false, reasons: ['human_evidence_invalid'] };
  }
  if (candidate.slackMessageTs !== trace.humanEvidence.slackMessageTs) {
    reasons.push('human_evidence_message_drift');
  }
  if (!equalDigest(
    digest(trace.identity, 'human-response-user', candidate.userId),
    trace.humanEvidence.userHmac,
  )) {
    reasons.push('human_evidence_user_drift');
  }
  if (!equalDigest(
    digest(trace.identity, 'human-response-content', candidate.content),
    trace.humanEvidence.contentHmac,
  )) {
    reasons.push('human_evidence_content_drift');
  }
  return { verified: reasons.length === 0, reasons };
}

function compareSnapshotList(
  expected: Array<{ index: number; name?: string; sha256: string }>,
  actual: Array<{ index: number; name?: string; sha256: string }>,
): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((item, index) => {
    const candidate = actual[index];
    return candidate?.index === item.index
      && candidate?.name === item.name
      && equalDigest(candidate.sha256, item.sha256);
  });
}

/**
 * Last-moment guard for the exact first request handed to the provider.
 * This is intentionally narrower than the full hydrated-context parity check:
 * callers run that first, then run this synchronously from
 * `onInvocationPrepared` before the SDK dispatch.
 */
export function verifyShadowReplayFirstInvocation(
  trace: ResolvedShadowReplayTrace,
  snapshot: InvocationPreparedSnapshot,
): { verified: boolean; reasons: string[] } {
  const expected = trace.expected;
  const reasons: string[] = [];
  if (snapshot.execution_mode !== 'replay') reasons.push('execution_mode_drift');
  if (snapshot.iteration !== 1 || snapshot.attempt !== 1) {
    reasons.push('first_invocation_position_drift');
  }
  if (snapshot.model !== expected.effective_model) reasons.push('model_drift');
  if (snapshot.message_count !== expected.message_count) reasons.push('message_count_drift');
  if (!compareSnapshotList(expected.system_block_hmacs, snapshot.system_blocks)) {
    reasons.push('system_blocks_drift');
  }
  if (!compareSnapshotList(expected.tool_schema_hmacs, snapshot.tool_schemas)) {
    reasons.push('tool_schemas_drift');
  }
  if (!compareSnapshotList(expected.message_payload_hmacs, snapshot.message_payloads)) {
    reasons.push('message_payloads_drift');
  }
  const actualToolNames = snapshot.tool_schemas.map(({ name }) => name);
  if (
    actualToolNames.length !== expected.approved_tool_names.length
    || !expected.approved_tool_names.every((name, index) => actualToolNames[index] === name)
  ) {
    reasons.push('capability_policy_drift');
  }
  if (
    !expected.provider_request_hmac
    || !equalDigest(expected.provider_request_hmac, snapshot.provider_request_sha256)
  ) {
    reasons.push('provider_request_drift');
  }
  return { verified: reasons.length === 0, reasons };
}

export function verifyShadowReplayTraceContext(
  trace: ResolvedShadowReplayTrace,
  input: {
    memberContext: MemberContext | null;
    channelContext?: ThreadContext;
    plan: ChannelRespondPlan;
    siRetrievalResult: SIRetrievalResult | null;
    invocation: ChannelResponseInvocation;
    snapshot: InvocationPreparedSnapshot;
    docsCorpusFingerprint: string;
    providerWebSearchEnabled: boolean;
  },
): { verified: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const expected = trace.expected;
  const check = (purpose: string, value: unknown, expectedDigest: string, reason: string) => {
    if (!equalDigest(digest(trace.identity, purpose, value), expectedDigest)) reasons.push(reason);
  };
  check('member-context', input.memberContext, expected.member_context_hmac, 'member_context_drift');
  check('channel-context', input.channelContext ?? null, expected.channel_context_hmac, 'channel_context_drift');
  check(
    'router-plan',
    canonicalOfficialDocsPlan(input.plan),
    expected.plan_hmac,
    'router_plan_drift',
  );
  check('si-retrieval', input.siRetrievalResult, expected.si_retrieval_hmac, 'si_retrieval_drift');
  check(
    'request-context',
    input.invocation.processOptions.requestContext ?? null,
    expected.request_context_hmac,
    'request_context_drift',
  );
  check('docs-corpus', input.docsCorpusFingerprint, expected.docs_corpus_hmac, 'docs_corpus_drift');
  if (input.invocation.effectiveModel !== expected.effective_model
    || input.snapshot.model !== expected.effective_model) reasons.push('model_drift');
  if (input.providerWebSearchEnabled !== expected.provider_web_search_enabled) {
    reasons.push('provider_tool_state_drift');
  }
  if (input.snapshot.message_count !== expected.message_count) reasons.push('message_count_drift');
  const allowedToolNames = input.invocation.processOptions.allowedToolNames ?? [];
  const actualToolNames = input.snapshot.tool_schemas.map(({ name }) => name);
  if (
    allowedToolNames.length !== expected.approved_tool_names.length
    || !expected.approved_tool_names.every((name, index) => allowedToolNames[index] === name)
    || actualToolNames.length !== expected.approved_tool_names.length
    || !expected.approved_tool_names.every((name, index) => actualToolNames[index] === name)
  ) {
    reasons.push('capability_policy_drift');
  }
  if (!compareSnapshotList(expected.system_block_hmacs, input.snapshot.system_blocks)) {
    reasons.push('system_blocks_drift');
  }
  if (!compareSnapshotList(expected.tool_schema_hmacs, input.snapshot.tool_schemas)) {
    reasons.push('tool_schemas_drift');
  }
  if (!compareSnapshotList(expected.message_payload_hmacs, input.snapshot.message_payloads)) {
    reasons.push('message_payloads_drift');
  }
  if (
    !expected.provider_request_hmac
    || !equalDigest(expected.provider_request_hmac, input.snapshot.provider_request_sha256)
  ) {
    reasons.push('provider_request_drift');
  }
  return { verified: reasons.length === 0, reasons };
}

export async function purgeRetainedShadowReplayTraces(
  dependencies: { query?: QueryFn } = {},
): Promise<number> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const attempts = await runQuery(
    'DELETE FROM addie_shadow_replay_capture_attempts WHERE retained_until <= NOW()',
  );
  const traces = await runQuery(
    'DELETE FROM addie_shadow_replay_traces WHERE retained_until <= NOW()',
  );
  return (attempts.rowCount ?? 0) + (traces.rowCount ?? 0);
}

export async function listPendingShadowReplayCaptures(
  limit: number,
  dependencies: { query?: QueryFn } = {},
): Promise<PendingShadowReplayCapture[]> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const result = await runQuery<PendingShadowReplayCapture>(
    `SELECT trace_id, thread_id
     FROM addie_shadow_replay_traces
     WHERE capture_version = $1
       AND capture_status = 'pending'
       AND created_at < NOW() - INTERVAL '10 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM addie_shadow_replay_generations generation
         WHERE generation.trace_id = addie_shadow_replay_traces.trace_id
       )
     ORDER BY created_at ASC, trace_id ASC
     LIMIT $2`,
    [SHADOW_REPLAY_TRACE_CAPTURE_VERSION, Math.max(1, Math.min(100, Math.trunc(limit)))],
  );
  return result.rows;
}

/** Persist one categorical outcome per signed opportunity and update only its current thread pointer. */
export async function completeShadowReplayCapture(
  traceId: string,
  threadId: string,
  outcome: {
    status: ShadowReplayCaptureStatus;
    reason: string;
    driftReasons?: string[];
    parityVerified?: boolean;
  },
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<boolean> {
  if (!isUuid(traceId) || !isUuid(threadId)) return false;
  if (!/^[a-z0-9_]{1,96}$/.test(outcome.reason)) {
    throw new Error('shadow_replay_capture_reason_invalid');
  }
  const runQuery = dependencies.query ?? query as QueryFn;
  const completedAt = dependencies.now ?? new Date();
  const driftReasons = outcome.driftReasons ?? [];
  if (driftReasons.some((reason) => !/^[a-z0-9_]{1,96}$/.test(reason))) {
    throw new Error('shadow_replay_capture_drift_reason_invalid');
  }
  const context = {
    shadow_eval_status: outcome.status === 'verified' ? 'skipped' : outcome.status,
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_completed_at: completedAt.toISOString(),
    shadow_eval_replay_error: outcome.reason,
    shadow_eval_trace_id: traceId,
    ...(driftReasons.length > 0
      ? { shadow_eval_replay_drift_reasons: driftReasons }
      : {}),
    ...(outcome.parityVerified
      ? { shadow_eval_capture_parity_verified: true }
      : {}),
  };
  const result = await runQuery<{ completed: boolean }>(
    `WITH completed AS (
       UPDATE addie_shadow_replay_traces
       SET capture_status = $3,
           capture_reason = $4,
           capture_completed_at = $5,
           capture_parity_verified = capture_parity_verified OR $6
       WHERE trace_id = $1
         AND thread_id = $2
         AND capture_status = 'pending'
       RETURNING trace_id, thread_id
     ), patched AS (
       UPDATE addie_threads thread
       SET context = COALESCE(thread.context, '{}'::jsonb) || $7::jsonb,
           updated_at = NOW()
       FROM completed
       WHERE thread.thread_id = completed.thread_id
         AND thread.context->>'shadow_eval_trace_id' = completed.trace_id::text
       RETURNING thread.thread_id
     )
     SELECT EXISTS (SELECT 1 FROM completed) AS completed`,
    [
      traceId,
      threadId,
      outcome.status,
      outcome.reason,
      completedAt,
      outcome.parityVerified === true,
      JSON.stringify(context),
    ],
  );
  return result.rows[0]?.completed === true;
}

const CATEGORICAL_REASON = /^[a-z0-9_]{1,96}$/;
const HMAC = /^[0-9a-f]{64}$/;
const BOUNDED_VERSION = /^[a-zA-Z0-9._:-]{1,64}$/;
const MAX_REPLAY_OUTPUT_BYTES = 128 * 1024;
const DETERMINISTIC_FAILURE_LABELS = new Set([
  'length_cap',
  'default_template',
  'structured_heavy',
  'comprehensive_dump',
  'signin_opener',
  'banned_ritual',
]);

function validateGenerationCompletion(
  trace: ResolvedShadowReplayTrace,
  outcome: ShadowReplayGenerationCompletion,
  target: ShadowReplayGenerationTarget,
): void {
  if (!CATEGORICAL_REASON.test(outcome.reason)) {
    throw new Error('shadow_replay_generation_reason_invalid');
  }
  if (outcome.outputHmac !== null && !HMAC.test(outcome.outputHmac)) {
    throw new Error('shadow_replay_generation_output_hmac_invalid');
  }
  if (outcome.status === 'succeeded' && !outcome.outputHmac) {
    throw new Error('shadow_replay_generation_output_hmac_required');
  }
  if (!Number.isInteger(outcome.outputBytes)
    || outcome.outputBytes < 0
    || outcome.outputBytes > MAX_REPLAY_OUTPUT_BYTES) {
    throw new Error('shadow_replay_generation_output_bytes_invalid');
  }
  if (!Number.isInteger(outcome.inputTokens) || outcome.inputTokens < 0
    || !Number.isInteger(outcome.outputTokens) || outcome.outputTokens < 0
    || !Number.isInteger(outcome.cacheReadTokens) || outcome.cacheReadTokens < 0
    || !Number.isInteger(outcome.cacheWriteTokens) || outcome.cacheWriteTokens < 0
    || [
      outcome.inputTokens,
      outcome.outputTokens,
      outcome.cacheReadTokens,
      outcome.cacheWriteTokens,
    ].some((value) => value > 2_147_483_647)) {
    throw new Error('shadow_replay_generation_usage_invalid');
  }
  if (typeof outcome.usageAvailable !== 'boolean'
    || (!outcome.usageAvailable && (
      outcome.inputTokens !== 0
      || outcome.outputTokens !== 0
      || outcome.cacheReadTokens !== 0
      || outcome.cacheWriteTokens !== 0
    ))) {
    throw new Error('shadow_replay_generation_usage_completeness_invalid');
  }
  if (outcome.latencyMs !== null && (
    !Number.isSafeInteger(outcome.latencyMs)
    || outcome.latencyMs < 0
    || outcome.latencyMs > 900_000
  )) {
    throw new Error('shadow_replay_generation_latency_invalid');
  }
  if (outcome.usageAvailable && outcome.latencyMs === null) {
    throw new Error('shadow_replay_generation_latency_required');
  }
  if (outcome.invocations.length > 4
    || (outcome.status === 'succeeded' && outcome.invocations.length === 0)) {
    throw new Error('shadow_replay_generation_invocations_invalid');
  }
  for (const [index, invocation] of outcome.invocations.entries()) {
    if (!Number.isInteger(invocation.iteration) || invocation.iteration < 1
      || invocation.iteration !== index + 1
      || invocation.attempt !== 1
      || !HMAC.test(invocation.provider_request_hmac)) {
      throw new Error('shadow_replay_generation_invocation_invalid');
    }
  }
  const firstInvocation = outcome.invocations[0];
  if (firstInvocation && (
    firstInvocation.iteration !== 1
    || firstInvocation.attempt !== 1
    || !equalDigest(
      firstInvocation.provider_request_hmac,
      target.firstProviderRequestHmac,
    )
  )) {
    throw new Error('shadow_replay_generation_first_invocation_mismatch');
  }
  if (outcome.toolExecutions.length > 8) {
    throw new Error('shadow_replay_generation_tool_limit_exceeded');
  }
  const expectedSchemaHmacs = new Map(
    trace.expected.tool_schema_hmacs.map(({ name, sha256 }) => [name, sha256]),
  );
  for (const [index, execution] of outcome.toolExecutions.entries()) {
    if (!Number.isInteger(execution.sequence) || execution.sequence < 1
      || execution.sequence !== index + 1
      || !['search_docs', 'get_doc', 'unapproved_tool'].includes(execution.name)
      || (execution.schema_hmac !== null && !HMAC.test(execution.schema_hmac))
      || !HMAC.test(execution.input_hmac)
      || !HMAC.test(execution.result_hmac)
      || !['live_read', 'blocked_unknown', 'blocked_policy', 'error'].includes(
        execution.disposition,
      )) {
      throw new Error('shadow_replay_generation_tool_evidence_invalid');
    }
    if (execution.name === 'unapproved_tool') {
      if (execution.schema_hmac !== null || execution.disposition === 'live_read') {
        throw new Error('shadow_replay_generation_tool_binding_invalid');
      }
    } else if (execution.schema_hmac !== expectedSchemaHmacs.get(execution.name)) {
      throw new Error('shadow_replay_generation_tool_binding_invalid');
    }
  }
  if (outcome.blockedCapabilities.length > 32
    || outcome.blockedCapabilities.some((reason) => !CATEGORICAL_REASON.test(reason))) {
    throw new Error('shadow_replay_generation_blocked_capability_invalid');
  }
  if (outcome.status === 'succeeded' && (
    outcome.blockedCapabilities.length > 0
    || outcome.toolExecutions.some(({ disposition }) => disposition !== 'live_read')
    || outcome.reason !== 'generation_succeeded'
    || !outcome.usageAvailable
    || outcome.latencyMs === null
  )) {
    throw new Error('shadow_replay_generation_success_inconsistent');
  }
  const returnedProvider = outcome.returnedProvider ?? null;
  const returnedModel = outcome.returnedModel ?? null;
  if ((returnedProvider === null) !== (returnedModel === null)
    || (returnedProvider !== null && (
      !isBoundedModel(returnedModel!)
      || providerForModel(returnedModel!) !== returnedProvider
    ))) {
    throw new Error('shadow_replay_generation_returned_model_invalid');
  }
}

function isBoundedModel(model: string): boolean {
  return model.length > 0
    && model.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(model);
}

function resolveGenerationTarget(
  trace: ResolvedShadowReplayTrace,
  target?: ShadowReplayGenerationTarget,
): ShadowReplayGenerationTarget | null {
  const resolved = target ?? {
    provider: providerForModel(trace.expected.effective_model),
    model: trace.expected.effective_model,
    firstProviderRequestHmac: trace.expected.provider_request_hmac ?? '',
  };
  if (!['anthropic', 'openai', 'google'].includes(resolved.provider)
    || !isBoundedModel(resolved.model)
    || providerForModel(resolved.model) !== resolved.provider
    || !HMAC.test(resolved.firstProviderRequestHmac)) {
    return null;
  }
  return resolved as ShadowReplayGenerationTarget;
}

function validateJudgmentCompletion(
  trace: ResolvedShadowReplayTrace,
  outcome: ShadowReplayGenerationCompletion,
  judgment: ShadowReplayJudgmentCompletion,
  persistedAt: Date,
  generatorModel: string,
): void {
  if (outcome.status !== 'succeeded' || !outcome.outputHmac) {
    throw new Error('shadow_replay_judgment_generation_incomplete');
  }
  if (
    !['judged', 'deterministic_failure', 'skipped', 'error'].includes(judgment.status)
    || !CATEGORICAL_REASON.test(judgment.reason)
  ) {
    throw new Error('shadow_replay_judgment_reason_invalid');
  }
  if (
    !Number.isSafeInteger(judgment.inputTokens) || judgment.inputTokens < 0
    || !Number.isSafeInteger(judgment.outputTokens) || judgment.outputTokens < 0
    || !Number.isSafeInteger(judgment.cacheReadTokens) || judgment.cacheReadTokens < 0
    || !Number.isSafeInteger(judgment.cacheWriteTokens) || judgment.cacheWriteTokens < 0
    || judgment.inputTokens > 2_147_483_647
    || judgment.outputTokens > 2_147_483_647
    || judgment.cacheReadTokens > 2_147_483_647
    || judgment.cacheWriteTokens > 2_147_483_647
  ) {
    throw new Error('shadow_replay_judgment_usage_invalid');
  }
  if (typeof judgment.usageAvailable !== 'boolean'
    || (!judgment.usageAvailable && (
      judgment.inputTokens !== 0
      || judgment.outputTokens !== 0
      || judgment.cacheReadTokens !== 0
      || judgment.cacheWriteTokens !== 0
    ))) {
    throw new Error('shadow_replay_judgment_usage_completeness_invalid');
  }
  if (!BOUNDED_VERSION.test(judgment.pricingVersion)) {
    throw new Error('shadow_replay_judgment_pricing_version_invalid');
  }
  if (judgment.latencyMs !== null && (
    !Number.isSafeInteger(judgment.latencyMs)
    || judgment.latencyMs < 0
    || judgment.latencyMs > 900_000
  )) {
    throw new Error('shadow_replay_judgment_latency_invalid');
  }
  if (
    !Number.isSafeInteger(judgment.shapeWordCount)
    || judgment.shapeWordCount < 0
    || judgment.shapeWordCount > 100_000
    || !Number.isSafeInteger(judgment.shapeExpectedMaxWords)
    || judgment.shapeExpectedMaxWords < 1
    || judgment.shapeExpectedMaxWords > 100_000
    || !Number.isFinite(judgment.shapeRatioToExpected)
    || judgment.shapeRatioToExpected < 0
    || judgment.shapeRatioToExpected > 1_000
  ) {
    throw new Error('shadow_replay_judgment_shape_invalid');
  }
  if (
    !Array.isArray(judgment.deterministicFailureLabels)
    || judgment.deterministicFailureLabels.length > 16
    || new Set(judgment.deterministicFailureLabels).size
      !== judgment.deterministicFailureLabels.length
    || judgment.deterministicFailureLabels.some(
      (label) => !DETERMINISTIC_FAILURE_LABELS.has(label),
    )
  ) {
    throw new Error('shadow_replay_judgment_shape_labels_invalid');
  }
  const startedAtMs = judgment.startedAt instanceof Date
    ? judgment.startedAt.getTime()
    : Number.NaN;
  const completedAtMs = judgment.completedAt instanceof Date
    ? judgment.completedAt.getTime()
    : Number.NaN;
  if (
    !Number.isFinite(startedAtMs)
    || !Number.isFinite(completedAtMs)
    || completedAtMs < startedAtMs
    || completedAtMs > persistedAt.getTime()
    || completedAtMs >= new Date(trace.expected.retained_until).getTime()
  ) {
    throw new Error('shadow_replay_judgment_time_invalid');
  }

  const executionFields = [
    judgment.judgeProvider,
    judgment.judgeModel,
    judgment.selfJudged,
    judgment.judgePromptVersion,
    judgment.judgePromptHmac,
    judgment.judgeRequestHmac,
  ];
  const judgeExecuted = judgment.judgeModel !== null;
  if (
    (judgeExecuted && executionFields.some((value) => value === null))
    || (!judgeExecuted && (
      executionFields.some((value) => value !== null)
      || judgment.judgeResponseHmac !== null
    ))
  ) {
    throw new Error('shadow_replay_judgment_provenance_incomplete');
  }
  if ((!judgeExecuted && (
    judgment.pricingVersion !== 'not-applicable'
    || judgment.usageAvailable
    || judgment.latencyMs !== null
  )) || (judgeExecuted && judgment.pricingVersion === 'not-applicable')) {
    throw new Error('shadow_replay_judgment_cost_provenance_invalid');
  }
  if (
    !judgment.sourceOutputHmac
    || !equalDigest(judgment.sourceOutputHmac, outcome.outputHmac)
    || ((trace.humanEvidence === null) !== (judgment.humanEvidenceContentHmac === null))
    || (trace.humanEvidence !== null && (
      !judgment.humanEvidenceContentHmac
      || !equalDigest(
        judgment.humanEvidenceContentHmac,
        trace.humanEvidence.contentHmac,
      )
    ))
  ) {
    throw new Error('shadow_replay_judgment_source_binding_invalid');
  }
  if (judgeExecuted) {
    if (
      !judgment.judgeModel
      || judgment.judgeModel.length > 160
      || /[\u0000-\u001f\u007f]/.test(judgment.judgeModel)
      || judgment.judgeProvider !== providerForModel(judgment.judgeModel)
      || judgment.selfJudged !== (judgment.judgeModel === generatorModel)
      || !judgment.judgePromptVersion
      || !BOUNDED_VERSION.test(judgment.judgePromptVersion)
      || !judgment.judgePromptHmac
      || !HMAC.test(judgment.judgePromptHmac)
      || !judgment.judgeRequestHmac
      || !HMAC.test(judgment.judgeRequestHmac)
      || (judgment.judgeResponseHmac !== null && !HMAC.test(judgment.judgeResponseHmac))
      || !trace.humanEvidence
    ) {
      throw new Error('shadow_replay_judgment_provenance_invalid');
    }
  }

  const hasVerdict = judgment.knowledgeGap !== null
    || judgment.gapSeverity !== null
    || judgment.shadowQuality !== null;
  if (judgment.status === 'judged') {
    if (
      !judgeExecuted
      || !judgment.judgeResponseHmac
      || judgment.selfJudged !== false
      || !judgment.evaluationValid
      || judgment.evaluationSkipped
      || judgment.knowledgeGap === null
      || judgment.gapSeverity === null
      || judgment.shadowQuality === null
      || !['none', 'minor', 'significant', 'critical'].includes(judgment.gapSeverity)
      || !['better', 'equivalent', 'worse', 'different_focus'].includes(
        judgment.shadowQuality,
      )
      || judgment.deterministicFailureLabels.length !== 0
      || !judgment.usageAvailable
      || judgment.latencyMs === null
      || (judgment.knowledgeGap && judgment.gapSeverity === 'none')
      || (!judgment.knowledgeGap && judgment.gapSeverity !== 'none')
    ) {
      throw new Error('shadow_replay_judgment_verdict_invalid');
    }
  } else if (judgment.status === 'deterministic_failure') {
    if (
      hasVerdict
      || judgeExecuted
      || !judgment.evaluationValid
      || judgment.evaluationSkipped
      || judgment.deterministicFailureLabels.length === 0
    ) {
      throw new Error('shadow_replay_judgment_deterministic_failure_invalid');
    }
  } else {
    if (hasVerdict || judgment.evaluationValid) {
      throw new Error('shadow_replay_judgment_verdict_invalid');
    }
    if (
      judgment.deterministicFailureLabels.length !== 0
      || (judgment.status === 'skipped' && (!judgment.evaluationSkipped || judgeExecuted))
      || (judgment.status === 'error' && judgment.evaluationSkipped)
    ) {
      throw new Error('shadow_replay_judgment_disposition_invalid');
    }
  }
}

/**
 * Claim one paid generation exactly once under a database-enforced UTC-day
 * slot quota. Unique `(quota_date, quota_slot)` reservations remain safe even
 * when concurrent statements begin with the same MVCC snapshot.
 */
export async function claimShadowReplayGeneration(
  trace: ResolvedShadowReplayTrace,
  dailyLimit: number,
  dependencies: {
    query?: QueryFn;
    now?: Date;
    target?: ShadowReplayGenerationTarget;
  } = {},
): Promise<ShadowReplayGenerationClaimDecision> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const now = dependencies.now ?? new Date();
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) {
    return 'trace_unavailable';
  }
  const target = resolveGenerationTarget(trace, dependencies.target);
  if (!target) return 'trace_unavailable';
  const pricing = resolveShadowReplayPricing(target.provider, target.model);
  if (!pricing || (pricing.validBefore && now >= pricing.validBefore)) {
    return 'trace_unavailable';
  }
  const boundedLimit = dailyLimit;
  const result = await runQuery<{ decision: ShadowReplayGenerationClaimDecision }>(
    `WITH eligible AS MATERIALIZED (
       SELECT trace.trace_id, trace.retained_until, trace.provider_request_hmac
       FROM addie_shadow_replay_traces trace
       WHERE trace.trace_id = $1
         AND trace.thread_id = $2
         AND trace.capture_version = $3
         AND trace.capture_status = 'pending'
         AND trace.revoked_at IS NULL
         AND trace.expires_at > $9
         AND trace.effective_model = $7
         AND trace.capability_profile = $4
         AND trace.capability_policy_version = $5
         AND trace.approved_tool_names = $6::jsonb
         AND trace.provider_request_hmac IS NOT NULL
     ), inserted AS (
       INSERT INTO addie_shadow_replay_generations (
         trace_id, execution_policy_version, requested_provider, model,
         addie_code_version, pricing_version,
         quota_date, quota_slot, first_provider_request_hmac,
         started_at, heartbeat_at, retained_until
       )
       SELECT eligible.trace_id, $8, $11, $12, $14, $15,
              ($9::timestamptz AT TIME ZONE 'UTC')::date, slot,
              $13, $9, $9, eligible.retained_until
       FROM eligible
       CROSS JOIN LATERAL generate_series(1, $10::integer) AS slot
       ORDER BY slot
       ON CONFLICT DO NOTHING
       RETURNING trace_id
     ), parity_marked AS (
       UPDATE addie_shadow_replay_traces trace
       SET capture_parity_verified = TRUE
       FROM inserted
       WHERE trace.trace_id = inserted.trace_id
       RETURNING trace.trace_id
     )
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM parity_marked) THEN 'claimed'
       WHEN EXISTS (
         SELECT 1 FROM addie_shadow_replay_generations generation
         WHERE generation.trace_id = $1
       ) THEN 'already_claimed'
       WHEN EXISTS (SELECT 1 FROM eligible) THEN 'daily_limit_reached'
       ELSE 'trace_unavailable'
     END AS decision`,
    [
      trace.traceId,
      trace.threadId,
      SHADOW_REPLAY_TRACE_CAPTURE_VERSION,
      OFFICIAL_DOCS_PROFILE,
      OFFICIAL_DOCS_POLICY_VERSION,
      JSON.stringify(OFFICIAL_DOCS_ALLOWED_TOOLS),
      trace.expected.effective_model,
      SHADOW_REPLAY_POLICY_VERSION,
      now,
      boundedLimit,
      target.provider,
      target.model,
      target.firstProviderRequestHmac,
      CODE_VERSION,
      pricing.version,
    ],
  );
  const decision = result.rows[0]?.decision ?? 'trace_unavailable';
  if (decision !== 'daily_limit_reached') return decision;

  // ON CONFLICT can observe an uncommitted same-trace winner that remains
  // invisible to this statement's original MVCC snapshot. Recheck with a new
  // statement before classifying the empty insert as quota exhaustion.
  const existing = await runQuery<{ claimed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM addie_shadow_replay_generations WHERE trace_id = $1
     ) AS claimed`,
    [trace.traceId],
  );
  return existing.rows[0]?.claimed ? 'already_claimed' : 'daily_limit_reached';
}

/**
 * Renew the paid-call lease immediately before an SDK dispatch. Recovery uses
 * this heartbeat rather than claim time, so a live multi-iteration run cannot
 * be terminalized between provider calls.
 */
export async function renewShadowReplayGenerationLease(
  trace: Pick<ResolvedShadowReplayTrace, 'traceId' | 'threadId'>,
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<boolean> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const now = dependencies.now ?? new Date();
  const result = await runQuery<{ renewed: boolean }>(
    `WITH renewed AS (
       UPDATE addie_shadow_replay_generations generation
       SET heartbeat_at = $3
       WHERE generation.trace_id = $1
         AND generation.status = 'running'
         AND EXISTS (
           SELECT 1 FROM addie_shadow_replay_traces trace
           WHERE trace.trace_id = generation.trace_id
             AND trace.thread_id = $2
             AND trace.capture_status = 'pending'
             AND trace.revoked_at IS NULL
             AND trace.expires_at > $3
         )
       RETURNING generation.trace_id
     )
     SELECT EXISTS (SELECT 1 FROM renewed) AS renewed`,
    [trace.traceId, trace.threadId, now],
  );
  return result.rows[0]?.renewed === true;
}

/** Finish the generation ledger and capture outcome in one database statement. */
export async function completeShadowReplayGeneration(
  trace: ResolvedShadowReplayTrace,
  outcome: ShadowReplayGenerationCompletion,
  dependencies: {
    judgment?: ShadowReplayJudgmentCompletion | null;
    query?: QueryFn;
    now?: Date;
    target?: ShadowReplayGenerationTarget;
  } = {},
): Promise<boolean> {
  const target = resolveGenerationTarget(trace, dependencies.target);
  if (!target) throw new Error('shadow_replay_generation_target_invalid');
  const pricing = resolveShadowReplayPricing(target.provider, target.model);
  if (!pricing) throw new Error('shadow_replay_generation_pricing_unavailable');
  validateGenerationCompletion(trace, outcome, target);
  const runQuery = dependencies.query ?? query as QueryFn;
  const completedAt = dependencies.now ?? new Date();
  const judgment = dependencies.judgment ?? null;
  if (judgment) {
    validateJudgmentCompletion(trace, outcome, judgment, completedAt, target.model);
  }
  const captureStatus = outcome.status === 'succeeded'
    ? 'verified'
    : outcome.status === 'blocked'
      ? 'skipped'
      : 'error';
  const estimatedCostMicros = outcome.usageAvailable
    ? pricing.estimateCostMicros({
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheReadTokens: outcome.cacheReadTokens,
      cacheWriteTokens: outcome.cacheWriteTokens,
    })
    : null;
  let judgmentEstimatedCostMicros: number | null = null;
  if (judgment?.judgeModel) {
    const judgmentPricing = resolveShadowReplayPricing(
      providerForModel(judgment.judgeModel) as ModelProviderId,
      judgment.judgeModel,
    );
    if (!judgmentPricing || judgmentPricing.version !== judgment.pricingVersion) {
      throw new Error('shadow_replay_judgment_pricing_unavailable');
    }
    judgmentEstimatedCostMicros = judgment.usageAvailable
      ? judgmentPricing.estimateCostMicros({
        inputTokens: judgment.inputTokens,
        outputTokens: judgment.outputTokens,
        cacheReadTokens: judgment.cacheReadTokens,
        cacheWriteTokens: judgment.cacheWriteTokens,
      })
      : null;
  }
  const context = {
    shadow_eval_status: outcome.status === 'error' ? 'error' : 'skipped',
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_completed_at: completedAt.toISOString(),
    shadow_eval_replay_error: outcome.reason,
    shadow_eval_trace_id: trace.traceId,
    shadow_eval_capture_parity_verified: true,
    shadow_eval_replay_generation_status: outcome.status,
    ...(judgment ? {
      shadow_eval_judgment_status: judgment.status,
      shadow_eval_judgment_reason: judgment.reason,
    } : {}),
  };
  const result = await runQuery<{ completed: boolean }>(
    `WITH finished AS (
       UPDATE addie_shadow_replay_generations generation
       SET status = $3,
           reason = $4,
           output_hmac = $5,
           output_bytes = $6,
           invocation_hmacs = $7::jsonb,
           tool_executions = $8::jsonb,
           blocked_capabilities = $9::jsonb,
           input_tokens = $10,
           output_tokens = $11,
           cache_read_tokens = $48,
           cache_write_tokens = $49,
           usage_complete = $50,
           latency_ms = $51,
           estimated_cost_micros = $52,
           returned_provider = $46,
           returned_model = $47,
           completed_at = $12
       WHERE generation.trace_id = $1
         AND generation.status = 'running'
         AND generation.requested_provider = $43
         AND generation.model = $44
         AND generation.first_provider_request_hmac = $45
         AND generation.pricing_version = $53
         AND EXISTS (
           SELECT 1 FROM addie_shadow_replay_traces trace
           WHERE trace.trace_id = generation.trace_id
             AND trace.thread_id = $2
             AND trace.capture_status = 'pending'
         )
       RETURNING generation.trace_id
     ), trace_completed AS (
       UPDATE addie_shadow_replay_traces trace
       SET capture_status = $13,
           capture_reason = $4,
           capture_completed_at = $12,
           capture_parity_verified = TRUE
       FROM finished
       WHERE trace.trace_id = finished.trace_id
         AND trace.thread_id = $2
         AND trace.capture_status = 'pending'
       RETURNING trace.trace_id, trace.thread_id
     ), judgment_inserted AS (
       INSERT INTO addie_shadow_replay_judgments (
         trace_id, status, reason, judgment_policy_version,
         evaluation_valid, evaluation_skipped, knowledge_gap, gap_severity,
         shadow_quality, deterministic_failure_labels,
         shape_word_count, shape_expected_max_words, shape_ratio_to_expected,
         judge_provider, judge_model, self_judged,
         judge_prompt_version, judge_prompt_hmac,
         judge_request_hmac, judge_response_hmac,
         question_hmac, source_output_hmac, human_evidence_content_hmac,
         input_tokens, output_tokens, started_at, completed_at, retained_until,
         pricing_version, usage_complete, cache_read_tokens, cache_write_tokens,
         latency_ms, estimated_cost_micros
       )
       SELECT
         trace_completed.trace_id, $16, $17, $18,
         $19, $20, $21, $22, $23, $24::text[],
         $25, $26, $27,
         $28, $29, $30, $31, $32, $33, $34,
         $35, $36, $37, $38, $39, $40, $41, $42,
         $54, $55, $56, $57, $58, $59
       FROM trace_completed
       WHERE $15::boolean
       RETURNING trace_id
     ), patched AS (
       UPDATE addie_threads thread
       SET context = COALESCE(thread.context, '{}'::jsonb) || $14::jsonb,
           updated_at = NOW()
       FROM trace_completed
       WHERE thread.thread_id = trace_completed.thread_id
         AND thread.context->>'shadow_eval_trace_id' = trace_completed.trace_id::text
       RETURNING thread.thread_id
     )
     SELECT EXISTS (SELECT 1 FROM trace_completed)
       AND (NOT $15::boolean OR EXISTS (SELECT 1 FROM judgment_inserted)) AS completed`,
    [
      trace.traceId,
      trace.threadId,
      outcome.status,
      outcome.reason,
      outcome.outputHmac,
      outcome.outputBytes,
      JSON.stringify(outcome.invocations),
      JSON.stringify(outcome.toolExecutions),
      JSON.stringify(outcome.blockedCapabilities),
      outcome.inputTokens,
      outcome.outputTokens,
      completedAt,
      captureStatus,
      JSON.stringify(context),
      judgment !== null,
      judgment?.status ?? null,
      judgment?.reason ?? null,
      SHADOW_REPLAY_JUDGMENT_POLICY_VERSION,
      judgment?.evaluationValid ?? null,
      judgment?.evaluationSkipped ?? null,
      judgment?.knowledgeGap ?? null,
      judgment?.gapSeverity ?? null,
      judgment?.shadowQuality ?? null,
      judgment?.deterministicFailureLabels ?? [],
      judgment?.shapeWordCount ?? null,
      judgment?.shapeExpectedMaxWords ?? null,
      judgment?.shapeRatioToExpected ?? null,
      judgment?.judgeProvider ?? null,
      judgment?.judgeModel ?? null,
      judgment?.selfJudged ?? null,
      judgment?.judgePromptVersion ?? null,
      judgment?.judgePromptHmac ?? null,
      judgment?.judgeRequestHmac ?? null,
      judgment?.judgeResponseHmac ?? null,
      trace.expected.question_hmac,
      judgment?.sourceOutputHmac ?? null,
      judgment?.humanEvidenceContentHmac ?? null,
      judgment?.inputTokens ?? null,
      judgment?.outputTokens ?? null,
      judgment?.startedAt ?? null,
      judgment?.completedAt ?? null,
      trace.expected.retained_until,
      target.provider,
      target.model,
      target.firstProviderRequestHmac,
      outcome.returnedProvider ?? null,
      outcome.returnedModel ?? null,
      outcome.cacheReadTokens,
      outcome.cacheWriteTokens,
      outcome.usageAvailable,
      outcome.latencyMs,
      estimatedCostMicros,
      pricing.version,
      judgment?.pricingVersion ?? null,
      judgment?.usageAvailable ?? null,
      judgment?.cacheReadTokens ?? null,
      judgment?.cacheWriteTokens ?? null,
      judgment?.latencyMs ?? null,
      judgmentEstimatedCostMicros,
    ],
  );
  return result.rows[0]?.completed === true;
}

/**
 * Close abandoned paid calls categorically. They are never made eligible for
 * retry, preventing duplicate generations and candidate cherry-picking.
 */
export async function recoverStaleShadowReplayGenerations(
  staleAfterMinutes: number = 20,
  dependencies: { query?: QueryFn; now?: Date } = {},
): Promise<number> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const now = dependencies.now ?? new Date();
  // Anthropic's per-request timeout is ten minutes. The recovery floor must
  // stay strictly above it; each later dispatch renews the lease first.
  const boundedMinutes = Math.max(15, Math.min(60, Math.trunc(staleAfterMinutes)));
  const context = {
    shadow_eval_status: 'error',
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_completed_at: now.toISOString(),
    shadow_eval_replay_error: 'replay_generation_interrupted',
    shadow_eval_capture_parity_verified: true,
    shadow_eval_replay_generation_status: 'error',
  };
  const result = await runQuery<{ recovered: number }>(
    `WITH stale AS (
       UPDATE addie_shadow_replay_generations generation
       SET status = 'error',
           reason = 'replay_generation_interrupted',
           completed_at = $1
       WHERE generation.status = 'running'
         AND generation.heartbeat_at <= $1 - ($2::integer * INTERVAL '1 minute')
       RETURNING generation.trace_id
     ), trace_completed AS (
       UPDATE addie_shadow_replay_traces trace
       SET capture_status = 'error',
           capture_reason = 'replay_generation_interrupted',
           capture_completed_at = $1,
           capture_parity_verified = TRUE
       FROM stale
       WHERE trace.trace_id = stale.trace_id
         AND trace.capture_status = 'pending'
       RETURNING trace.trace_id, trace.thread_id
     ), patched AS (
       UPDATE addie_threads thread
       SET context = COALESCE(thread.context, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       FROM trace_completed
       WHERE thread.thread_id = trace_completed.thread_id
         AND thread.context->>'shadow_eval_trace_id' = trace_completed.trace_id::text
       RETURNING thread.thread_id
     )
     SELECT COUNT(*)::integer AS recovered FROM trace_completed`,
    [now, boundedMinutes, JSON.stringify(context)],
  );
  return result.rows[0]?.recovered ?? 0;
}

export async function getShadowReplayCaptureSummary(
  days: number,
  dependencies: { query?: QueryFn } = {},
): Promise<ShadowReplayCaptureSummaryRow[]> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const boundedDays = Math.max(1, Math.min(7, Math.trunc(days)));
  const result = await runQuery<ShadowReplayCaptureSummaryRow>(
    `SELECT
            CASE WHEN attempt.trace_id IS NOT NULL
              THEN trace.capture_status ELSE attempt.status END AS status,
            CASE WHEN attempt.trace_id IS NOT NULL
              THEN COALESCE(trace.capture_reason, 'pending') ELSE attempt.reason END AS reason,
            COUNT(*)::integer AS count
     FROM addie_shadow_replay_capture_attempts attempt
     LEFT JOIN addie_shadow_replay_traces trace ON trace.trace_id = attempt.trace_id
     WHERE attempt.created_at >= NOW() - ($2::integer * INTERVAL '1 day')
       AND attempt.capture_version = $1
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [SHADOW_REPLAY_TRACE_CAPTURE_VERSION, boundedDays],
  );
  return result.rows;
}

export async function getShadowReplayGenerationSummary(
  days: number,
  dependencies: { query?: QueryFn } = {},
): Promise<ShadowReplayGenerationSummaryRow[]> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const boundedDays = Math.max(1, Math.min(7, Math.trunc(days)));
  const result = await runQuery<ShadowReplayGenerationSummaryRow>(
    `SELECT trace.capture_version,
            trace.policy_version AS capture_policy_version,
            trace.source_config_version_id,
            trace.effective_model AS source_model,
            generation.requested_provider,
            generation.model AS requested_model,
            generation.addie_code_version,
            generation.execution_policy_version,
            generation.pricing_version,
            generation.returned_provider,
            generation.returned_model,
            generation.status,
            generation.reason,
            COUNT(*)::integer AS count,
            COALESCE(SUM(generation.input_tokens), 0)::integer AS input_tokens,
            COALESCE(SUM(generation.output_tokens), 0)::integer AS output_tokens,
            COALESCE(SUM(generation.cache_read_tokens), 0)::integer AS cache_read_tokens,
            COALESCE(SUM(generation.cache_write_tokens), 0)::integer AS cache_write_tokens,
            COUNT(*) FILTER (WHERE generation.usage_complete)::integer
              AS usage_complete_count,
            COUNT(generation.latency_ms)::integer AS latency_count,
            COALESCE(SUM(generation.estimated_cost_micros), 0)::text
              AS estimated_cost_micros,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY generation.latency_ms)
              FILTER (WHERE generation.latency_ms IS NOT NULL)::double precision
              AS latency_p50_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY generation.latency_ms)
              FILTER (WHERE generation.latency_ms IS NOT NULL)::double precision
              AS latency_p95_ms
     FROM addie_shadow_replay_generations generation
     JOIN addie_shadow_replay_traces trace ON trace.trace_id = generation.trace_id
     WHERE generation.started_at >= NOW() - ($2::integer * INTERVAL '1 day')
       AND trace.capture_version = $1
     GROUP BY trace.capture_version, trace.policy_version,
              trace.source_config_version_id, trace.effective_model,
              generation.requested_provider, generation.model,
              generation.addie_code_version, generation.execution_policy_version,
              generation.pricing_version,
              generation.returned_provider,
              generation.returned_model, generation.status, generation.reason
     ORDER BY generation.requested_provider, generation.model,
              generation.status, generation.reason`,
    [SHADOW_REPLAY_TRACE_CAPTURE_VERSION, boundedDays],
  );
  return result.rows;
}

export async function getShadowReplayJudgmentSummary(
  days: number,
  dependencies: { query?: QueryFn } = {},
): Promise<ShadowReplayJudgmentSummaryRow[]> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const boundedDays = Math.max(1, Math.min(7, Math.trunc(days)));
  const result = await runQuery<ShadowReplayJudgmentSummaryRow>(
    `SELECT trace.capture_version,
            trace.policy_version AS capture_policy_version,
            trace.source_config_version_id,
            trace.effective_model AS source_model,
            judgment.human_evidence_content_hmac IS NOT NULL AS has_human_evidence,
            generation.requested_provider,
            generation.model AS requested_model,
            generation.addie_code_version,
            generation.execution_policy_version,
            generation.returned_provider,
            generation.returned_model,
            judgment.judgment_policy_version,
            judgment.judge_provider,
            judgment.judge_model,
            judgment.self_judged,
            judgment.judge_prompt_version,
            judgment.pricing_version,
            judgment.status,
            judgment.reason,
            judgment.evaluation_valid,
            judgment.evaluation_skipped,
            judgment.knowledge_gap,
            judgment.gap_severity,
            judgment.shadow_quality,
            judgment.deterministic_failure_labels,
            COUNT(*)::integer AS count,
            COALESCE(SUM(judgment.input_tokens), 0)::integer AS input_tokens,
            COALESCE(SUM(judgment.output_tokens), 0)::integer AS output_tokens,
            COALESCE(SUM(judgment.cache_read_tokens), 0)::integer AS cache_read_tokens,
            COALESCE(SUM(judgment.cache_write_tokens), 0)::integer AS cache_write_tokens,
            COUNT(*) FILTER (WHERE judgment.usage_complete)::integer AS usage_complete_count,
            COUNT(judgment.latency_ms)::integer AS latency_count,
            COALESCE(SUM(judgment.estimated_cost_micros), 0)::text
              AS estimated_cost_micros,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY judgment.latency_ms)::double precision
              AS latency_p50_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY judgment.latency_ms)::double precision
              AS latency_p95_ms
     FROM addie_shadow_replay_judgments judgment
     JOIN addie_shadow_replay_generations generation
       ON generation.trace_id = judgment.trace_id
     JOIN addie_shadow_replay_traces trace ON trace.trace_id = generation.trace_id
     WHERE judgment.completed_at >= NOW() - ($2::integer * INTERVAL '1 day')
       AND trace.capture_version = $1
     GROUP BY trace.capture_version, trace.policy_version,
              trace.source_config_version_id, trace.effective_model,
              (judgment.human_evidence_content_hmac IS NOT NULL),
              generation.requested_provider, generation.model,
              generation.addie_code_version, generation.execution_policy_version,
              generation.returned_provider, generation.returned_model,
              judgment.judgment_policy_version, judgment.judge_provider,
              judgment.judge_model, judgment.self_judged,
              judgment.judge_prompt_version, judgment.pricing_version, judgment.status,
              judgment.reason, judgment.evaluation_valid,
              judgment.evaluation_skipped, judgment.knowledge_gap,
              judgment.gap_severity, judgment.shadow_quality,
              judgment.deterministic_failure_labels
     ORDER BY generation.requested_provider, generation.model,
              judgment.judge_provider, judgment.judge_model,
              judgment.status, judgment.reason`,
    [SHADOW_REPLAY_TRACE_CAPTURE_VERSION, boundedDays],
  );
  return result.rows;
}

/** One no-payload funnel row; each count is per capture opportunity, never per message. */
export async function getShadowReplayFunnelSummary(
  days: number,
  dependencies: { query?: QueryFn } = {},
): Promise<ShadowReplayFunnelSummary> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const boundedDays = Math.max(1, Math.min(7, Math.trunc(days)));
  const result = await runQuery<ShadowReplayFunnelSummary>(
    `WITH cohort AS (
       SELECT attempt.attempt_id,
              trace.trace_id,
              trace.capture_parity_verified,
              CASE WHEN trace.trace_id IS NULL THEN attempt.status ELSE trace.capture_status END
                AS capture_status,
              generation.status AS generation_status,
              judgment.status AS judgment_status
       FROM addie_shadow_replay_capture_attempts attempt
       LEFT JOIN addie_shadow_replay_traces trace
         ON trace.trace_id = attempt.trace_id
       LEFT JOIN addie_shadow_replay_generations generation
         ON generation.trace_id = trace.trace_id
       LEFT JOIN addie_shadow_replay_judgments judgment
         ON judgment.trace_id = generation.trace_id
       WHERE attempt.created_at >= NOW() - ($2::integer * INTERVAL '1 day')
         AND attempt.capture_version = $1
         AND (trace.trace_id IS NULL OR trace.capture_version = attempt.capture_version)
         AND (attempt.trace_id IS NULL OR trace.trace_id IS NOT NULL)
     )
     SELECT
       COUNT(*)::integer AS opportunities,
       COUNT(trace_id)::integer AS traces_captured,
       COUNT(*) FILTER (WHERE capture_parity_verified)::integer AS parity_verified,
       COUNT(*) FILTER (WHERE capture_status = 'verified')::integer AS capture_verified,
       COUNT(*) FILTER (WHERE capture_status = 'pending')::integer AS capture_pending,
       COUNT(*) FILTER (WHERE capture_status = 'skipped')::integer AS capture_skipped,
       COUNT(*) FILTER (WHERE capture_status = 'error')::integer AS capture_error,
       COUNT(*) FILTER (WHERE generation_status IS NOT NULL)::integer AS generation_claimed,
       COUNT(*) FILTER (WHERE generation_status = 'succeeded')::integer AS generation_succeeded,
       COUNT(*) FILTER (WHERE generation_status = 'blocked')::integer AS generation_blocked,
       COUNT(*) FILTER (WHERE generation_status = 'error')::integer AS generation_error,
       COUNT(*) FILTER (WHERE generation_status = 'running')::integer AS generation_running,
       COUNT(*) FILTER (WHERE judgment_status = 'judged')::integer AS judgment_judged,
       COUNT(*) FILTER (WHERE judgment_status = 'deterministic_failure')::integer
         AS judgment_deterministic_failure,
       COUNT(*) FILTER (WHERE judgment_status = 'skipped')::integer AS judgment_skipped,
       COUNT(*) FILTER (WHERE judgment_status = 'error')::integer AS judgment_error,
       COUNT(*) FILTER (
           WHERE generation_status = 'succeeded' AND judgment_status IS NULL
         )::integer AS judgment_missing
     FROM cohort`,
    [SHADOW_REPLAY_TRACE_CAPTURE_VERSION, boundedDays],
  );
  return result.rows[0] ?? {
    opportunities: 0,
    traces_captured: 0,
    parity_verified: 0,
    capture_verified: 0,
    capture_pending: 0,
    capture_skipped: 0,
    capture_error: 0,
    generation_claimed: 0,
    generation_succeeded: 0,
    generation_blocked: 0,
    generation_error: 0,
    generation_running: 0,
    judgment_judged: 0,
    judgment_deterministic_failure: 0,
    judgment_skipped: 0,
    judgment_error: 0,
    judgment_missing: 0,
  };
}
