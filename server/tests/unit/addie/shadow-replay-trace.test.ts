import { describe, expect, it, vi } from 'vitest';
import type { InvocationPreparedSnapshot } from '../../../src/addie/claude-client.js';
import {
  createShadowReplayCaptureIdentity,
  purgeRetainedShadowReplayTraces,
  queueShadowReplayTrace,
  resolveShadowReplayTrace,
  verifyShadowReplayTraceContext,
} from '../../../src/addie/jobs/shadow-replay-trace.js';

const TRACE_KEY = 'trace-test-key-that-is-at-least-thirty-two-bytes';
const TRACE_KEY_VERSION = 'test-v1';
const NOW = new Date('2026-08-25T08:00:00.000Z');
const QUESTION = 'private.person@example.test secret-question-sentinel';

function snapshot(): InvocationPreparedSnapshot {
  return {
    execution_mode: 'production',
    model: 'claude-test',
    iteration: 1,
    attempt: 1,
    system_blocks: [{ index: 0, sha256: 'a'.repeat(64) }],
    tool_schemas: [{ index: 0, name: 'search_docs', sha256: 'b'.repeat(64) }],
    message_count: 1,
  };
}

function captureInput(identity = createShadowReplayCaptureIdentity({
  key: TRACE_KEY,
  version: TRACE_KEY_VERSION,
})) {
  const plan = {
    action: 'respond' as const,
    tool_sets: ['knowledge'],
    confidence: 'high' as const,
    requires_precision: false,
    requires_depth: false,
    reason: 'protocol question',
    decision_method: 'quick_match' as const,
    latency_ms: 1,
  };
  const memberContext = { slackUserId: 'U_PRIVATE', email: 'private.person@example.test' } as never;
  const channelContext = {
    viewing_channel_id: 'C_PRIVATE',
    viewing_channel_name: 'private-channel',
    viewing_channel_topic: 'channel-topic-sentinel',
    viewing_channel_is_private: true,
  };
  const invocation = {
    requestTools: { tools: [], handlers: new Map() },
    processOptions: { requestContext: 'request-context-sentinel' },
    effectiveModel: 'claude-test',
    selectedToolSets: ['knowledge'],
    isAdmin: false,
  };
  return {
    identity,
    threadId: '00000000-0000-4000-8000-000000000001',
    sourceQuestionMessageId: '00000000-0000-4000-8000-000000000002',
    sourceUserId: 'U_PRIVATE',
    channelId: 'C_PRIVATE',
    threadTs: '1000.0001',
    questionTs: '1000.0002',
    question: QUESTION,
    sourceConfigVersionId: 42,
    memberContext,
    channelContext,
    plan,
    siRetrievalResult: null,
    invocation,
    snapshot: snapshot(),
    docsCorpusFingerprint: 'docs-corpus-sentinel',
    providerWebSearchEnabled: false,
    now: NOW,
  };
}

async function persistedTrace(input = captureInput()) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rows: [],
        rowCount: sql.includes('INSERT INTO addie_shadow_replay_traces')
          || sql.startsWith('UPDATE addie_threads')
          ? 1
          : null,
      };
    }),
    release: vi.fn(),
  };
  await queueShadowReplayTrace(input, { getClient: vi.fn(async () => client as never) });
  const insert = calls.find((call) => call.sql.includes('INSERT INTO addie_shadow_replay_traces'))!;
  const p = insert.params;
  const row = {
    trace_id: p[0],
    capture_version: p[1],
    thread_id: p[2],
    source_question_message_id: p[3],
    source_slack_message_ts: p[4],
    source_config_version_id: p[5],
    hash_key_version: p[6],
    policy_version: p[7],
    capture_salt: p[8],
    effective_model: p[9],
    si_retrieval_present: p[10],
    provider_web_search_enabled: p[11],
    message_count: p[12],
    question_hmac: p[13],
    source_binding_hmac: p[14],
    member_context_hmac: p[15],
    channel_context_hmac: p[16],
    plan_hmac: p[17],
    si_retrieval_hmac: p[18],
    request_context_hmac: p[19],
    docs_corpus_hmac: p[20],
    system_block_hmacs: JSON.parse(p[21] as string),
    tool_schema_hmacs: JSON.parse(p[22] as string),
    authorization_hmac: p[23],
    created_at: p[24],
    expires_at: p[25],
    retained_until: p[26],
    revoked_at: null,
    question: input.question,
    source_user_id: input.sourceUserId,
    router_decision: input.plan,
    thread_external_id: `${input.channelId}:${input.threadTs}`,
    thread_channel: 'slack',
  };
  return { calls, input, row };
}

describe('shadow replay trace authorization', () => {
  it('reports retention cleanup counts and propagates failures for caller observability', async () => {
    await expect(purgeRetainedShadowReplayTraces({
      query: vi.fn(async () => ({ rows: [], rowCount: 4 })) as never,
    })).resolves.toBe(4);
    await expect(purgeRetainedShadowReplayTraces({
      query: vi.fn(async () => { throw new Error('private database detail'); }) as never,
    })).rejects.toThrow('private database detail');
  });

  it('atomically queues only references and keyed digests, never copied private payloads', async () => {
    const { calls } = await persistedTrace();
    const serializedWrites = JSON.stringify(calls);

    expect(serializedWrites).not.toContain(QUESTION);
    expect(serializedWrites).not.toContain('private.person@example.test');
    expect(serializedWrites).not.toContain('channel-topic-sentinel');
    expect(serializedWrites).not.toContain('request-context-sentinel');
    expect(serializedWrites).not.toContain('docs-corpus-sentinel');
    expect(calls.map((call) => call.sql.trim().split(/\s+/, 1)[0])).toEqual([
      'BEGIN',
      'INSERT',
      'UPDATE',
      'COMMIT',
    ]);
    const contextPatch = calls.find((call) => call.sql.startsWith('UPDATE addie_threads'))!;
    expect(JSON.parse(contextPatch.params[1] as string)).toEqual(expect.objectContaining({
      shadow_eval_status: 'pending',
      shadow_eval_trace_id: expect.any(String),
    }));
    expect(contextPatch.params[1]).not.toContain('shadow_eval_question');
  });

  it('salts identical private values differently for every capture', async () => {
    const first = await persistedTrace();
    const second = await persistedTrace();
    expect(first.row.question_hmac).not.toBe(second.row.question_hmac);
    expect(first.row.member_context_hmac).not.toBe(second.row.member_context_hmac);
  });

  it('rehydrates an attributable, signed source and rejects source tampering', async () => {
    const { input, row } = await persistedTrace();
    const runQuery = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const resolved = await resolveShadowReplayTrace(input.identity.traceId, {
      query: runQuery as never,
      keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
      now: NOW,
    });

    if (!resolved.authorized) throw new Error(resolved.reason);
    expect(resolved.trace).toMatchObject({
      traceId: input.identity.traceId,
      threadId: input.threadId,
      sourceQuestionMessageId: input.sourceQuestionMessageId,
      sourceUserId: input.sourceUserId,
      question: QUESTION,
    });

    const tampered = await resolveShadowReplayTrace(input.identity.traceId, {
      query: vi.fn(async () => ({
        rows: [{ ...row, question: `${QUESTION}-changed` }],
        rowCount: 1,
      })) as never,
      keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
      now: NOW,
    });
    expect(tampered).toEqual({ authorized: false, reason: 'trace_source_invalid' });
  });

  it('binds a mutable queue pointer to the trace owning thread', async () => {
    const { input, row } = await persistedTrace();
    const runQuery = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    await expect(resolveShadowReplayTrace(input.identity.traceId, {
      query: runQuery as never,
      keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
      now: NOW,
      expectedThreadId: '00000000-0000-4000-8000-000000000099',
    })).resolves.toEqual({ authorized: false, reason: 'trace_thread_mismatch' });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it('fails closed for expired, revoked, rotated-key, and mutated authorization rows', async () => {
    const { input, row } = await persistedTrace();
    const resolve = (candidate: typeof row, options: Record<string, unknown> = {}) =>
      resolveShadowReplayTrace(input.identity.traceId, {
        query: vi.fn(async () => ({ rows: [candidate], rowCount: 1 })) as never,
        keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
        now: NOW,
        ...options,
      });

    await expect(resolve({ ...row, expires_at: new Date(NOW.getTime() - 1) })).resolves.toEqual({
      authorized: false,
      reason: 'trace_expired',
    });
    await expect(resolve({ ...row, revoked_at: NOW })).resolves.toEqual({
      authorized: false,
      reason: 'trace_revoked',
    });
    await expect(resolve(row, {
      keyConfig: { key: TRACE_KEY, version: 'rotated-v2' },
    })).resolves.toEqual({ authorized: false, reason: 'trace_key_version_mismatch' });
    await expect(resolve({ ...row, effective_model: 'tampered-model' })).resolves.toEqual({
      authorized: false,
      reason: 'trace_authorization_invalid',
    });
  });

  it('rejects captured production provider tools before replay hydration or generation', async () => {
    const input = { ...captureInput(), providerWebSearchEnabled: true };
    const { row } = await persistedTrace(input);
    const runQuery = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    await expect(resolveShadowReplayTrace(input.identity.traceId, {
      query: runQuery as never,
      keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
      now: NOW,
    })).resolves.toEqual({
      authorized: false,
      reason: 'trace_provider_tools_unsupported',
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it('verifies every live context binding and reports drift without private values', async () => {
    const { input, row } = await persistedTrace();
    const resolved = await resolveShadowReplayTrace(input.identity.traceId, {
      query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) as never,
      keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
      now: NOW,
    });
    if (!resolved.authorized) throw new Error(resolved.reason);

    expect(verifyShadowReplayTraceContext(resolved.trace, {
      memberContext: input.memberContext,
      channelContext: input.channelContext,
      plan: input.plan,
      siRetrievalResult: input.siRetrievalResult,
      invocation: input.invocation,
      snapshot: input.snapshot,
      docsCorpusFingerprint: input.docsCorpusFingerprint,
      providerWebSearchEnabled: input.providerWebSearchEnabled,
    })).toEqual({ verified: true, reasons: [] });

    const drift = verifyShadowReplayTraceContext(resolved.trace, {
      memberContext: input.memberContext,
      channelContext: { ...input.channelContext, viewing_channel_is_private: false },
      plan: input.plan,
      siRetrievalResult: input.siRetrievalResult,
      invocation: input.invocation,
      snapshot: input.snapshot,
      docsCorpusFingerprint: 'changed-corpus',
      providerWebSearchEnabled: true,
    });
    expect(drift).toEqual({
      verified: false,
      reasons: [
        'channel_context_drift',
        'docs_corpus_drift',
        'provider_tool_state_drift',
      ],
    });
    expect(JSON.stringify(drift)).not.toContain('changed-corpus');
  });
});
