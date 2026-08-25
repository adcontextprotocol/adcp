import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { getClient, query } from '../../db/client.js';
import { isUuid } from '../../utils/uuid.js';
import type { InvocationPreparedSnapshot } from '../claude-client.js';
import type { MemberContext } from '../member-context.js';
import type { SIRetrievalResult } from '../services/si-retriever.js';
import type { ThreadContext } from '../thread-service.js';
import type { ChannelRespondPlan, ChannelResponseInvocation } from '../bolt-app.js';
import { SHADOW_REPLAY_POLICY_VERSION } from './shadow-eval-metadata.js';
import {
  OFFICIAL_DOCS_ALLOWED_TOOLS,
  OFFICIAL_DOCS_POLICY_VERSION,
  OFFICIAL_DOCS_PROFILE,
  canonicalOfficialDocsPlan,
  isOfficialDocsProfile,
} from './shadow-replay-cohort.js';

export const SHADOW_REPLAY_TRACE_CAPTURE_VERSION = 2 as const;
export const SHADOW_REPLAY_TRACE_HASH_DOMAIN = 'addie-shadow-replay-trace:v2' as const;
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
  now?: Date;
}

interface TraceRow extends QueryResultRow {
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
         capability_profile, created_at, retained_until
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING attempt_id, thread_id
     )
     UPDATE addie_threads thread
     SET context = (
       COALESCE(thread.context, '{}'::jsonb) - ARRAY[
         'shadow_eval_trace_id', 'shadow_eval_capture_parity_verified',
         'shadow_eval_replay_drift_reasons', 'shadow_eval_completed_at',
         'shadow_eval_replay_error'
       ]::text[]
     ) || $7::jsonb,
         updated_at = NOW()
     FROM inserted
     WHERE thread.thread_id = inserted.thread_id
     RETURNING inserted.attempt_id`,
    [
      attemptId,
      input.threadId,
      input.sourceQuestionMessageId,
      OFFICIAL_DOCS_PROFILE,
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
         provider_request_hmac, authorization_hmac,
         created_at, expires_at, retained_until
       ) SELECT
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24,
         $25::jsonb, $26::jsonb, $27::jsonb, $28, $29, $30, $31, $32
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
         AND status = 'pending'`,
      [
        input.attemptId,
        input.identity.traceId,
        now,
        input.threadId,
        input.sourceQuestionMessageId,
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
      expected: row,
    },
  };
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
           capture_completed_at = $5
       WHERE trace_id = $1
         AND thread_id = $2
         AND capture_status = 'pending'
       RETURNING trace_id, thread_id
     ), patched AS (
       UPDATE addie_threads thread
       SET context = COALESCE(thread.context, '{}'::jsonb) || $6::jsonb,
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
      JSON.stringify(context),
    ],
  );
  return result.rows[0]?.completed === true;
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
       AND (trace.trace_id IS NULL OR trace.capture_version = $1)
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [SHADOW_REPLAY_TRACE_CAPTURE_VERSION, boundedDays],
  );
  return result.rows;
}
