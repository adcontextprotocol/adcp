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

export const SHADOW_REPLAY_TRACE_CAPTURE_VERSION = 1 as const;
export const SHADOW_REPLAY_TRACE_HASH_DOMAIN = 'addie-shadow-replay-trace:v1' as const;
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
  requestedAt: Date = new Date(),
): Record<string, unknown> {
  return {
    shadow_eval_status: 'pending',
    shadow_eval_requested_at: requestedAt.toISOString(),
    shadow_eval_type: 'suppressed_opportunity',
    shadow_eval_source: 'suppressed',
    shadow_eval_trace_id: traceId,
  };
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
    message_count: input.snapshot.message_count,
    question_hmac: digest(input.identity, 'question', input.question),
    source_binding_hmac: digest(input.identity, 'source-binding', source),
    member_context_hmac: digest(input.identity, 'member-context', input.memberContext),
    channel_context_hmac: digest(input.identity, 'channel-context', input.channelContext ?? null),
    plan_hmac: digest(input.identity, 'router-plan', input.plan),
    si_retrieval_hmac: digest(input.identity, 'si-retrieval', input.siRetrievalResult),
    request_context_hmac: digest(
      input.identity,
      'request-context',
      input.invocation.processOptions.requestContext ?? null,
    ),
    docs_corpus_hmac: digest(input.identity, 'docs-corpus', input.docsCorpusFingerprint),
    system_block_hmacs: input.snapshot.system_blocks,
    tool_schema_hmacs: input.snapshot.tool_schemas,
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
         provider_web_search_enabled, message_count, question_hmac,
         source_binding_hmac, member_context_hmac, channel_context_hmac,
         plan_hmac, si_retrieval_hmac, request_context_hmac, docs_corpus_hmac,
         system_block_hmacs, tool_schema_hmacs, authorization_hmac,
         created_at, expires_at, retained_until
       ) SELECT
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23::jsonb, $24,
         $25, $26, $27
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
        authorizationHmac,
        now,
        expiresAt,
        retainedUntil,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error('shadow_replay_trace_source_not_found');
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
       WHERE thread_id = $1`,
      [input.threadId, JSON.stringify(buildShadowEvalQueueContext(input.identity.traceId, now))],
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
  check('router-plan', input.plan, expected.plan_hmac, 'router_plan_drift');
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
  if (!compareSnapshotList(expected.system_block_hmacs, input.snapshot.system_blocks)) {
    reasons.push('system_blocks_drift');
  }
  if (!compareSnapshotList(expected.tool_schema_hmacs, input.snapshot.tool_schemas)) {
    reasons.push('tool_schemas_drift');
  }
  return { verified: reasons.length === 0, reasons };
}

export async function purgeRetainedShadowReplayTraces(
  dependencies: { query?: QueryFn } = {},
): Promise<number> {
  const runQuery = dependencies.query ?? query as QueryFn;
  const result = await runQuery(
    'DELETE FROM addie_shadow_replay_traces WHERE retained_until <= NOW()',
  );
  return result.rowCount ?? 0;
}
