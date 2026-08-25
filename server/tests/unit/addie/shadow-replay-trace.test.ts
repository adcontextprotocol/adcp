import { describe, expect, it, vi } from 'vitest';
import type { InvocationPreparedSnapshot } from '../../../src/addie/claude-client.js';
import {
  beginShadowReplayCaptureAttempt,
  claimShadowReplayGeneration,
  completeShadowReplayCaptureAttempt,
  completeShadowReplayCapture,
  completeShadowReplayGeneration,
  createShadowReplayCaptureIdentity,
  getShadowReplayCaptureSummary,
  getShadowReplayGenerationSummary,
  listPendingShadowReplayCaptures,
  purgeRetainedShadowReplayTraces,
  queueShadowReplayTrace,
  recoverStaleShadowReplayGenerations,
  renewShadowReplayGenerationLease,
  resolveShadowReplayTrace,
  verifyShadowReplayFirstInvocation,
  verifyShadowReplayTraceContext,
} from '../../../src/addie/jobs/shadow-replay-trace.js';
import {
  OFFICIAL_DOCS_ALLOWED_TOOLS,
  OFFICIAL_DOCS_POLICY_VERSION,
  OFFICIAL_DOCS_PROFILE,
  canonicalOfficialDocsPlan,
} from '../../../src/addie/jobs/shadow-replay-cohort.js';

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
    tool_schemas: [
      { index: 0, name: 'search_docs', sha256: 'b'.repeat(64) },
      { index: 1, name: 'get_doc', sha256: 'c'.repeat(64) },
    ],
    message_payloads: [{ index: 0, sha256: 'd'.repeat(64) }],
    provider_request_sha256: 'e'.repeat(64),
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
    capability_profile: OFFICIAL_DOCS_PROFILE,
    capability_profile_reason: 'eligible' as const,
  };
  const memberContext = { slackUserId: 'U_PRIVATE', email: 'private.person@example.test' } as never;
  const channelContext = {
    viewing_channel_id: 'C_PRIVATE',
    viewing_channel_name: 'private-channel',
    viewing_channel_topic: 'channel-topic-sentinel',
    viewing_channel_is_private: false,
  };
  const invocation = {
    requestTools: { tools: [], handlers: new Map() },
    processOptions: {
      requestContext: 'request-context-sentinel',
      disableServerTools: true,
      allowedToolNames: [...OFFICIAL_DOCS_ALLOWED_TOOLS],
    },
    effectiveModel: 'claude-test',
    selectedToolSets: ['knowledge'],
    isAdmin: false,
  };
  return {
    attemptId: '00000000-0000-4000-8000-000000000003',
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
          || sql.startsWith('UPDATE addie_shadow_replay_capture_attempts')
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
    capability_profile: p[12],
    capability_policy_version: p[13],
    approved_tool_names: JSON.parse(p[14] as string),
    message_count: p[15],
    question_hmac: p[16],
    source_binding_hmac: p[17],
    member_context_hmac: p[18],
    channel_context_hmac: p[19],
    plan_hmac: p[20],
    si_retrieval_hmac: p[21],
    request_context_hmac: p[22],
    docs_corpus_hmac: p[23],
    system_block_hmacs: JSON.parse(p[24] as string),
    tool_schema_hmacs: JSON.parse(p[25] as string),
    message_payload_hmacs: JSON.parse(p[26] as string),
    provider_request_hmac: p[27],
    authorization_hmac: p[28],
    created_at: p[29],
    expires_at: p[30],
    retained_until: p[31],
    revoked_at: null,
    question: input.question,
    source_user_id: input.sourceUserId,
    router_decision: canonicalOfficialDocsPlan(input.plan),
    thread_external_id: `${input.channelId}:${input.threadTs}`,
    thread_channel: 'slack',
  };
  return { calls, input, row };
}

async function authorizedTrace() {
  const persisted = await persistedTrace();
  const resolved = await resolveShadowReplayTrace(persisted.input.identity.traceId, {
    query: vi.fn(async () => ({ rows: [persisted.row], rowCount: 1 })) as never,
    keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
    now: NOW,
  });
  if (!resolved.authorized) throw new Error(resolved.reason);
  return { ...persisted, trace: resolved.trace };
}

describe('shadow replay trace authorization', () => {
  it('reports retention cleanup counts and propagates failures for caller observability', async () => {
    const cleanupQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });
    await expect(purgeRetainedShadowReplayTraces({
      query: cleanupQuery as never,
    })).resolves.toBe(4);
    await expect(purgeRetainedShadowReplayTraces({
      query: vi.fn(async () => { throw new Error('private database detail'); }) as never,
    })).rejects.toThrow('private database detail');
  });

  it('records pre-trace failures per opportunity and clears stale trace parity', async () => {
    const beginQuery = vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: [{ attempt_id: params[0] }],
      rowCount: 1,
    }));
    const attemptId = await beginShadowReplayCaptureAttempt({
      threadId: '00000000-0000-4000-8000-000000000001',
      sourceQuestionMessageId: '00000000-0000-4000-8000-000000000002',
      now: NOW,
    }, { query: beginQuery as never });
    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(beginQuery.mock.calls[0][0]).toContain("'shadow_eval_trace_id'");
    expect(beginQuery.mock.calls[0][0]).toContain("'shadow_eval_capture_parity_verified'");
    expect(JSON.parse(beginQuery.mock.calls[0][1][6] as string)).toMatchObject({
      shadow_eval_status: 'pending',
      shadow_eval_capture_attempt_id: attemptId,
    });

    const failQuery = vi.fn(async () => ({ rows: [{ completed: true }], rowCount: 1 }));
    await expect(completeShadowReplayCaptureAttempt(
      attemptId,
      '00000000-0000-4000-8000-000000000001',
      { status: 'error', reason: 'trace_capture_failed' },
      { query: failQuery as never, now: NOW },
    )).resolves.toBe(true);
    expect(failQuery.mock.calls[0][0]).toContain(
      "context->>'shadow_eval_capture_attempt_id' = completed.attempt_id::text",
    );
    expect(JSON.parse(failQuery.mock.calls[0][1][5] as string)).toEqual({
      shadow_eval_status: 'error',
      shadow_eval_type: 'suppressed_opportunity',
      shadow_eval_source: 'suppressed',
      shadow_eval_completed_at: NOW.toISOString(),
      shadow_eval_replay_error: 'trace_capture_failed',
      shadow_eval_capture_attempt_id: attemptId,
    });
  });

  it('atomically queues only references and keyed digests, never copied private payloads', async () => {
    const { calls, row } = await persistedTrace();
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
      'UPDATE',
      'COMMIT',
    ]);
    const contextPatch = calls.find((call) => call.sql.startsWith('UPDATE addie_threads'))!;
    expect(JSON.parse(contextPatch.params[1] as string)).toEqual(expect.objectContaining({
      shadow_eval_status: 'pending',
      shadow_eval_trace_id: expect.any(String),
    }));
    expect(contextPatch.params[1]).not.toContain('shadow_eval_question');
    expect(row).toMatchObject({
      capture_version: 2,
      capability_profile: OFFICIAL_DOCS_PROFILE,
      capability_policy_version: OFFICIAL_DOCS_POLICY_VERSION,
      approved_tool_names: [...OFFICIAL_DOCS_ALLOWED_TOOLS],
    });
  });

  it('rejects any capture outside the explicit official-docs profile', async () => {
    const input = captureInput();
    const unsupported = {
      ...input,
      plan: { ...input.plan, capability_profile: undefined },
    };
    await expect(queueShadowReplayTrace(unsupported)).rejects.toThrow(
      'shadow_replay_trace_capability_profile_unsupported',
    );
  });

  it('rejects a capture whose prepared schema boundary is incomplete', async () => {
    const input = captureInput();
    await expect(queueShadowReplayTrace({
      ...input,
      snapshot: {
        ...input.snapshot,
        tool_schemas: input.snapshot.tool_schemas.slice(0, 1),
      },
    })).rejects.toThrow('shadow_replay_trace_tool_boundary_mismatch');
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
      channelContext: { ...input.channelContext, viewing_channel_is_private: true },
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

  it('detects ordered message, provider request, and approved-tool drift', async () => {
    const { input, row } = await persistedTrace();
    const resolved = await resolveShadowReplayTrace(input.identity.traceId, {
      query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) as never,
      keyConfig: { key: TRACE_KEY, version: TRACE_KEY_VERSION },
      now: NOW,
    });
    if (!resolved.authorized) throw new Error(resolved.reason);

    const actual = verifyShadowReplayTraceContext(resolved.trace, {
      memberContext: input.memberContext,
      channelContext: input.channelContext,
      plan: input.plan,
      siRetrievalResult: input.siRetrievalResult,
      invocation: {
        ...input.invocation,
        processOptions: {
          ...input.invocation.processOptions,
          allowedToolNames: [...OFFICIAL_DOCS_ALLOWED_TOOLS].reverse(),
        },
      },
      snapshot: {
        ...input.snapshot,
        message_payloads: [{ index: 0, sha256: 'f'.repeat(64) }],
        provider_request_sha256: '0'.repeat(64),
      },
      docsCorpusFingerprint: input.docsCorpusFingerprint,
      providerWebSearchEnabled: input.providerWebSearchEnabled,
    });
    expect(actual).toEqual({
      verified: false,
      reasons: [
        'capability_policy_drift',
        'message_payloads_drift',
        'provider_request_drift',
      ],
    });
  });

  it('guards the exact replay request immediately before the first provider call', async () => {
    const { trace } = await authorizedTrace();
    const replaySnapshot = { ...snapshot(), execution_mode: 'replay' as const };
    expect(verifyShadowReplayFirstInvocation(trace, replaySnapshot)).toEqual({
      verified: true,
      reasons: [],
    });
    expect(verifyShadowReplayFirstInvocation(trace, {
      ...replaySnapshot,
      model: 'tampered-model',
      provider_request_sha256: '0'.repeat(64),
    })).toEqual({
      verified: false,
      reasons: ['model_drift', 'provider_request_drift'],
    });
  });

  it('lists and completes each signed opportunity independently of the mutable thread pointer', async () => {
    const pending = [
      { trace_id: '00000000-0000-4000-8000-000000000011', thread_id: '00000000-0000-4000-8000-000000000001' },
      { trace_id: '00000000-0000-4000-8000-000000000012', thread_id: '00000000-0000-4000-8000-000000000001' },
    ];
    const listQuery = vi.fn(async () => ({ rows: pending, rowCount: 2 }));
    await expect(listPendingShadowReplayCaptures(500, { query: listQuery as never }))
      .resolves.toEqual(pending);
    expect(listQuery.mock.calls[0][1]).toEqual([2, 100]);

    const completeQuery = vi.fn(async () => ({ rows: [{ completed: true }], rowCount: 1 }));
    await expect(completeShadowReplayCapture(
      pending[0].trace_id,
      pending[0].thread_id,
      {
        status: 'verified',
        reason: 'replay_generation_disabled',
        parityVerified: true,
      },
      { query: completeQuery as never, now: NOW },
    )).resolves.toBe(true);
    const serialized = JSON.stringify(completeQuery.mock.calls);
    expect(serialized).toContain("capture_status = $3");
    expect(serialized).toContain("context->>'shadow_eval_trace_id'");
    expect(serialized).not.toContain(QUESTION);
    expect(JSON.parse(completeQuery.mock.calls[0][1][5] as string)).toMatchObject({
      shadow_eval_status: 'skipped',
      shadow_eval_capture_parity_verified: true,
      shadow_eval_trace_id: pending[0].trace_id,
    });
  });

  it('reports categorical capture outcomes per trace', async () => {
    const rows = [
      { status: 'verified', reason: 'replay_generation_disabled', count: 3 },
      { status: 'skipped', reason: 'capture_parity_drift', count: 1 },
      { status: 'error', reason: 'trace_capture_failed', count: 1 },
    ];
    const runQuery = vi.fn(async () => ({ rows, rowCount: 2 }));
    await expect(getShadowReplayCaptureSummary(999, { query: runQuery as never }))
      .resolves.toEqual(rows);
    expect(runQuery.mock.calls[0][1]).toEqual([2, 7]);
    expect(runQuery.mock.calls[0][0]).toContain('addie_shadow_replay_capture_attempts');
  });

  it('claims one generation through a database-enforced daily slot quota', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn(async () => ({
      rows: [{ decision: 'claimed' }],
      rowCount: 1,
    }));
    await expect(claimShadowReplayGeneration(trace, 100, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe('claimed');
    expect(runQuery.mock.calls[0][0]).toContain('generate_series(1, $10::integer)');
    expect(runQuery.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
    expect(runQuery.mock.calls[0][1][9]).toBe(100);
    expect(JSON.stringify(runQuery.mock.calls)).not.toContain(QUESTION);
  });

  it('fails closed before SQL when the generation quota is not bounded', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn();
    await expect(claimShadowReplayGeneration(trace, 0, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe('trace_unavailable');
    await expect(claimShadowReplayGeneration(trace, 101, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe('trace_unavailable');
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('rechecks a slot conflict in a fresh snapshot before reporting quota exhaustion', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ decision: 'daily_limit_reached' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ claimed: true }], rowCount: 1 });
    await expect(claimShadowReplayGeneration(trace, 1, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe('already_claimed');
    expect(runQuery).toHaveBeenCalledTimes(2);
    expect(runQuery.mock.calls[1][0]).toContain('WHERE trace_id = $1');
  });

  it('renews only a live pending generation before provider dispatch', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn(async () => ({ rows: [{ renewed: true }], rowCount: 1 }));
    await expect(renewShadowReplayGenerationLease(trace, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe(true);
    expect(runQuery.mock.calls[0][0]).toContain("generation.status = 'running'");
    expect(runQuery.mock.calls[0][0]).toContain("trace.capture_status = 'pending'");
    expect(runQuery.mock.calls[0][0]).toContain('SET heartbeat_at = $3');
  });

  it('atomically completes a hash-only generation and its trace outcome', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn(async () => ({ rows: [{ completed: true }], rowCount: 1 }));
    const outcome = {
      status: 'succeeded' as const,
      reason: 'generation_succeeded',
      outputHmac: '1'.repeat(64),
      outputBytes: 128,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: trace.expected.provider_request_hmac!,
      }],
      toolExecutions: [{
        sequence: 1,
        name: 'search_docs' as const,
        schema_hmac: trace.expected.tool_schema_hmacs[0].sha256,
        input_hmac: '2'.repeat(64),
        result_hmac: '3'.repeat(64),
        disposition: 'live_read' as const,
      }],
      blockedCapabilities: [],
      inputTokens: 20,
      outputTokens: 10,
    };
    await expect(completeShadowReplayGeneration(trace, outcome, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe(true);
    expect(runQuery.mock.calls[0][0]).toContain("generation.status = 'running'");
    expect(runQuery.mock.calls[0][0]).toContain("trace.capture_status = 'pending'");
    expect(JSON.parse(runQuery.mock.calls[0][1][13] as string)).toMatchObject({
      shadow_eval_status: 'skipped',
      shadow_eval_capture_parity_verified: true,
      shadow_eval_replay_generation_status: 'succeeded',
    });
    expect(JSON.stringify(runQuery.mock.calls)).not.toContain(QUESTION);
  });

  it('rejects unsafe or unbounded generation evidence before persistence', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn();
    await expect(completeShadowReplayGeneration(trace, {
      status: 'blocked',
      reason: 'replay_generation_blocked',
      outputHmac: null,
      outputBytes: 0,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: trace.expected.provider_request_hmac!,
      }],
      toolExecutions: [],
      blockedCapabilities: ['private:value'],
      inputTokens: 0,
      outputTokens: 0,
    }, { query: runQuery as never })).rejects.toThrow(
      'shadow_replay_generation_blocked_capability_invalid',
    );
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('persists a pre-provider boundary outcome with no invocation evidence', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn(async () => ({ rows: [{ completed: true }], rowCount: 1 }));
    await expect(completeShadowReplayGeneration(trace, {
      status: 'blocked',
      reason: 'provider_request_drift',
      outputHmac: null,
      outputBytes: 0,
      invocations: [],
      toolExecutions: [],
      blockedCapabilities: ['provider_request_drift'],
      inputTokens: 0,
      outputTokens: 0,
    }, { query: runQuery as never, now: NOW })).resolves.toBe(true);
    expect(JSON.parse(runQuery.mock.calls[0][1][6] as string)).toEqual([]);
  });

  it('rejects a success row whose signed first request or policy outcome is inconsistent', async () => {
    const { trace } = await authorizedTrace();
    const runQuery = vi.fn();
    const base = {
      status: 'succeeded' as const,
      reason: 'generation_succeeded',
      outputHmac: '1'.repeat(64),
      outputBytes: 4,
      toolExecutions: [],
      blockedCapabilities: [],
      inputTokens: 1,
      outputTokens: 1,
    };
    await expect(completeShadowReplayGeneration(trace, {
      ...base,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: 'f'.repeat(64),
      }],
    }, { query: runQuery as never })).rejects.toThrow(
      'shadow_replay_generation_first_invocation_mismatch',
    );
    await expect(completeShadowReplayGeneration(trace, {
      ...base,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: trace.expected.provider_request_hmac!,
      }],
      blockedCapabilities: ['output_rejected'],
    }, { query: runQuery as never })).rejects.toThrow(
      'shadow_replay_generation_success_inconsistent',
    );
    await expect(completeShadowReplayGeneration(trace, {
      ...base,
      invocations: [{
        iteration: 1,
        attempt: 2,
        provider_request_hmac: trace.expected.provider_request_hmac!,
      }],
    }, { query: runQuery as never })).rejects.toThrow(
      'shadow_replay_generation_invocation_invalid',
    );
    await expect(completeShadowReplayGeneration(trace, {
      status: 'blocked',
      reason: 'unapproved_tool',
      outputHmac: null,
      outputBytes: 0,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: trace.expected.provider_request_hmac!,
      }],
      toolExecutions: [{
        sequence: 1,
        name: 'unapproved_tool',
        schema_hmac: null,
        input_hmac: '2'.repeat(64),
        result_hmac: '3'.repeat(64),
        disposition: 'live_read',
      }],
      blockedCapabilities: ['unapproved_tool'],
      inputTokens: 1,
      outputTokens: 1,
    }, { query: runQuery as never })).rejects.toThrow(
      'shadow_replay_generation_tool_binding_invalid',
    );
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('closes stale paid calls without making them retryable', async () => {
    const runQuery = vi.fn(async () => ({ rows: [{ recovered: 2 }], rowCount: 1 }));
    await expect(recoverStaleShadowReplayGenerations(999, {
      query: runQuery as never,
      now: NOW,
    })).resolves.toBe(2);
    expect(runQuery.mock.calls[0][1][1]).toBe(60);
    expect(runQuery.mock.calls[0][0]).toContain("reason = 'replay_generation_interrupted'");
    expect(runQuery.mock.calls[0][0]).toContain('generation.heartbeat_at');
    expect(runQuery.mock.calls[0][0]).toContain("trace.capture_status = 'pending'");

    const floorQuery = vi.fn(async () => ({ rows: [{ recovered: 0 }], rowCount: 1 }));
    await recoverStaleShadowReplayGenerations(1, {
      query: floorQuery as never,
      now: NOW,
    });
    expect(floorQuery.mock.calls[0][1][1]).toBe(15);
  });

  it('reports only categorical generation outcomes and token totals', async () => {
    const rows = [{
      status: 'succeeded',
      reason: 'replay_generation_succeeded',
      count: 2,
      input_tokens: 100,
      output_tokens: 40,
    }];
    const runQuery = vi.fn(async () => ({ rows, rowCount: 1 }));
    await expect(getShadowReplayGenerationSummary(999, { query: runQuery as never }))
      .resolves.toEqual(rows);
    expect(runQuery.mock.calls[0][1]).toEqual([7]);
    expect(runQuery.mock.calls[0][0]).not.toContain('trace_id');
  });
});
