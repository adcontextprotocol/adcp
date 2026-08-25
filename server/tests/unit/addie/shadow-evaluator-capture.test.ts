import { describe, expect, it, vi } from 'vitest';
import { runShadowEvaluatorJob } from '../../../src/addie/jobs/shadow-evaluator.js';
import { OFFICIAL_DOCS_PROFILE } from '../../../src/addie/jobs/shadow-replay-cohort.js';

const capture = {
  trace_id: '00000000-0000-4000-8000-000000000011',
  thread_id: '00000000-0000-4000-8000-000000000001',
};

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

function authorizedTrace() {
  return {
    authorized: true as const,
    trace: {
      identity: {
        traceId: capture.trace_id,
        salt: 'a'.repeat(32),
        hashKey: 'derived-key',
        hashDomain: 'addie-shadow-replay-trace:v2' as const,
        keyVersion: 'test-v1',
      },
      traceId: capture.trace_id,
      threadId: capture.thread_id,
      sourceQuestionMessageId: '00000000-0000-4000-8000-000000000002',
      sourceUserId: 'U_TEST',
      sourceConfigVersionId: 42,
      channelId: 'C_TEST',
      threadTs: '1000.1',
      questionTs: '1000.2',
      question: 'How does AdCP work?',
      routerDecision: plan,
      expected: {},
    },
  };
}

function baseDependencies() {
  const completeCapture = vi.fn().mockResolvedValue(true);
  const prepareMessageInvocation = vi.fn().mockReturnValue({
    execution_mode: 'production',
    model: 'claude-test',
    iteration: 1,
    attempt: 1,
    system_blocks: [],
    tool_schemas: [],
    message_payloads: [],
    message_count: 1,
    provider_request_sha256: 'a'.repeat(64),
  });
  const providerCall = vi.fn();
  const judgeCall = vi.fn();
  const getMember = vi.fn().mockResolvedValue({ slackUserId: 'U_TEST' });
  const getChannel = vi.fn().mockResolvedValue({ viewing_channel_is_private: false });
  const resolveTrace = vi.fn().mockResolvedValue(authorizedTrace());
  return {
    providerCall,
    judgeCall,
    completeCapture,
    getMember,
    getChannel,
    resolveTrace,
    dependencies: {
      purgeTraces: vi.fn().mockResolvedValue(0),
      listPending: vi.fn().mockResolvedValue([capture]),
      resolveTrace,
      completeCapture,
      getClient: vi.fn().mockReturnValue({
        prepareMessageInvocation,
        isWebSearchEnabled: () => true,
        processMessage: providerCall,
      }),
      getDocsFingerprint: vi.fn().mockReturnValue('docs-fingerprint'),
      getConfigVersionId: vi.fn().mockResolvedValue(42),
      getMember,
      getChannel,
      buildInvocation: vi.fn().mockResolvedValue({
        requestTools: { tools: [], handlers: new Map() },
        processOptions: {
          disableServerTools: true,
          allowedToolNames: ['search_docs', 'get_doc'],
        },
        effectiveModel: 'claude-test',
        selectedToolSets: ['knowledge'],
        isAdmin: false,
      }),
      verifyTraceContext: vi.fn().mockReturnValue({ verified: true, reasons: [] }),
    },
  };
}

describe('shadow evaluator capture-only orchestration', () => {
  it('verifies exact parity without calling a generator or judge', async () => {
    const fixture = baseDependencies();
    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 1, errors: 0 });
    expect(fixture.completeCapture).toHaveBeenCalledWith(
      capture.trace_id,
      capture.thread_id,
      expect.objectContaining({
        status: 'verified',
        reason: 'replay_generation_disabled',
        parityVerified: true,
      }),
    );
    expect(fixture.resolveTrace.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.getMember.mock.invocationCallOrder[0]);
    expect(fixture.providerCall).not.toHaveBeenCalled();
    expect(fixture.judgeCall).not.toHaveBeenCalled();
  });

  it('terminates configuration drift before private hydration', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.getConfigVersionId = vi.fn().mockResolvedValue(43);
    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result.skipped).toBe(1);
    expect(fixture.completeCapture).toHaveBeenCalledWith(
      capture.trace_id,
      capture.thread_id,
      expect.objectContaining({ status: 'skipped', reason: 'config_version_drift' }),
    );
    expect(fixture.getMember).not.toHaveBeenCalled();
    expect(fixture.providerCall).not.toHaveBeenCalled();
  });

  it('persists categorical parity drift per opportunity', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.verifyTraceContext = vi.fn().mockReturnValue({
      verified: false,
      reasons: ['provider_request_drift'],
    });
    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result.skipped).toBe(1);
    expect(fixture.completeCapture).toHaveBeenCalledWith(
      capture.trace_id,
      capture.thread_id,
      expect.objectContaining({
        status: 'skipped',
        reason: 'capture_parity_drift',
        driftReasons: ['provider_request_drift'],
      }),
    );
    expect(fixture.providerCall).not.toHaveBeenCalled();
  });
});
