import { describe, expect, it, vi } from 'vitest';
import { runShadowEvaluatorJob } from '../../../src/addie/jobs/shadow-evaluator.js';
import { OFFICIAL_DOCS_PROFILE } from '../../../src/addie/jobs/shadow-replay-cohort.js';
import {
  OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
  OfficialDocsReplayBoundaryError,
  OfficialDocsReplayExecutionError,
  OfficialDocsReplayOutputConsumerError,
} from '../../../src/addie/jobs/shadow-replay.js';
import { ShadowReplayJudgeBoundaryError } from '../../../src/addie/jobs/shadow-replay-judge.js';

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

function authorizedTrace(withHumanEvidence = true) {
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
      humanEvidence: withHumanEvidence ? {
        slackMessageTs: '1000.3',
        userHmac: 'e'.repeat(64),
        contentHmac: 'f'.repeat(64),
      } : null,
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
  const forkForIsolatedProvider = vi.fn();
  const sourceClient = {
    prepareMessageInvocation,
    isWebSearchEnabled: () => true,
    processMessage: providerCall,
    forkForIsolatedProvider,
  };
  return {
    providerCall,
    judgeCall,
    completeCapture,
    getMember,
    getChannel,
    resolveTrace,
    sourceClient,
    forkForIsolatedProvider,
    dependencies: {
      purgeTraces: vi.fn().mockResolvedValue(0),
      recoverGenerations: vi.fn().mockResolvedValue(0),
      listPending: vi.fn().mockResolvedValue([capture]),
      resolveTrace,
      completeCapture,
      getClient: vi.fn().mockReturnValue(sourceClient),
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
      selectReplayActivation: vi.fn().mockReturnValue({
        enabled: false,
        reason: 'generation_disabled',
        dailyLimit: 0,
      }),
      selectReplayTarget: vi.fn().mockReturnValue({
        mode: 'source',
        reason: 'google_disabled',
      }),
      createGoogleProvider: vi.fn(),
      prepareReplayTarget: vi.fn(),
      selectJudgeActivation: vi.fn().mockReturnValue({
        enabled: false,
        reason: 'judge_disabled',
        dailyLimit: 0,
      }),
      claimGeneration: vi.fn(),
      executeReplay: vi.fn(),
      completeGeneration: vi.fn().mockResolvedValue(true),
      hydrateHumanEvidence: vi.fn(),
      resolveJudgeModel: vi.fn(),
      getJudgeClient: vi.fn(),
      createOutputConsumer: vi.fn().mockReturnValue(vi.fn()),
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
    expect(fixture.dependencies.claimGeneration).not.toHaveBeenCalled();
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

  it('blocks a partially configured alternate target before claim', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.selectReplayTarget = vi.fn().mockReturnValue({
      mode: 'blocked',
      reason: 'google_model_invalid',
    });

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ skipped: 1, errors: 0 });
    expect(fixture.completeCapture).toHaveBeenCalledWith(
      capture.trace_id,
      capture.thread_id,
      expect.objectContaining({
        status: 'verified',
        reason: 'replay_google_model_invalid',
        parityVerified: true,
      }),
    );
    expect(fixture.dependencies.claimGeneration).not.toHaveBeenCalled();
    expect(fixture.forkForIsolatedProvider).not.toHaveBeenCalled();
  });

  it('binds one prepared Google target through claim, execution, and completion', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    const selection = {
      mode: 'alternate' as const,
      reason: 'google_enabled' as const,
      provider: 'google' as const,
      model: 'gemini-3.7-flash' as const,
    };
    const provider = { id: 'google' as const };
    const candidateClient = { processMessage: vi.fn() };
    const target = {
      provider: selection.provider,
      model: selection.model,
      firstInvocation: {
        execution_mode: 'replay' as const,
        model: selection.model,
        iteration: 1,
        attempt: 1,
        system_blocks: [],
        tool_schemas: [],
        message_payloads: [],
        message_count: 1,
        provider_request_sha256: '9'.repeat(64),
      },
    };
    const generationTarget = {
      provider: selection.provider,
      model: selection.model,
      firstProviderRequestHmac: target.firstInvocation.provider_request_sha256,
    };
    fixture.dependencies.selectReplayTarget = vi.fn().mockReturnValue(selection);
    fixture.dependencies.createGoogleProvider = vi.fn().mockReturnValue(provider);
    fixture.forkForIsolatedProvider.mockReturnValue(candidateClient);
    fixture.dependencies.prepareReplayTarget = vi.fn().mockReturnValue(target);
    fixture.dependencies.selectJudgeActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.hydrateHumanEvidence = vi.fn().mockResolvedValue({
      slackMessageTs: '1000.3',
      userId: 'U_HUMAN',
      content: 'A substantive human answer used only in memory.',
    });
    fixture.dependencies.resolveJudgeModel = vi.fn().mockReturnValue('claude-judge');
    fixture.dependencies.getJudgeClient = vi.fn().mockReturnValue({ messages: {} });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    const generation = {
      traceId: capture.trace_id,
      provider: selection.provider,
      model: selection.model,
      returnedProvider: 'google' as const,
      returnedModel: 'gemini-3.7-flash-20260801',
      executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
      completeFidelity: false,
      status: 'blocked' as const,
      reason: 'generation_blocked',
      outputHmac: 'b'.repeat(64),
      outputBytes: 42,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: target.firstInvocation.provider_request_sha256,
      }],
      toolExecutions: [],
      blockedCapabilities: ['generation_blocked'],
      inputTokens: 20,
      outputTokens: 10,
    };
    fixture.dependencies.executeReplay = vi.fn().mockResolvedValue(generation);

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ skipped: 1, errors: 0 });
    expect(fixture.forkForIsolatedProvider).toHaveBeenCalledWith(selection.model, { provider });
    expect(fixture.dependencies.claimGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      5,
      { target: generationTarget },
    );
    expect(fixture.dependencies.resolveJudgeModel).toHaveBeenCalledWith([
      'claude-test',
      selection.model,
    ]);
    expect(fixture.dependencies.executeReplay).toHaveBeenCalledWith(
      expect.objectContaining({ target }),
      expect.objectContaining({ client: candidateClient }),
    );
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      generation,
      { target: generationTarget },
    );
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

  it('closes a successful generation that omitted judgment as a categorical error', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    fixture.dependencies.executeReplay = vi.fn().mockResolvedValue({
      traceId: capture.trace_id,
      model: 'claude-test',
      executionPolicyVersion: 'official-docs-read-only:v1',
      completeFidelity: true,
      status: 'succeeded',
      reason: 'generation_succeeded',
      outputHmac: 'b'.repeat(64),
      outputBytes: 42,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: 'a'.repeat(64),
      }],
      toolExecutions: [],
      blockedCapabilities: [],
      inputTokens: 20,
      outputTokens: 10,
    });

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 0, errors: 1 });
    expect(fixture.dependencies.claimGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      5,
    );
    expect(fixture.dependencies.executeReplay).toHaveBeenCalledOnce();
    expect(fixture.dependencies.executeReplay).toHaveBeenCalledWith(
      expect.objectContaining({ trace: expect.objectContaining({ traceId: capture.trace_id }) }),
      expect.objectContaining({
        renewLease: expect.any(Function),
        outputConsumer: expect.any(Function),
      }),
    );
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      expect.objectContaining({
        status: 'succeeded',
        outputHmac: 'b'.repeat(64),
      }),
      {
        judgment: expect.objectContaining({
          status: 'error',
          reason: 'judgment_internal_error',
          sourceOutputHmac: 'b'.repeat(64),
        }),
      },
    );
    expect(fixture.completeCapture).not.toHaveBeenCalled();
    expect(fixture.providerCall).not.toHaveBeenCalled();
    expect(fixture.judgeCall).not.toHaveBeenCalled();
  });

  it('hydrates signed human evidence before claiming and persists an atomic judgment', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.selectJudgeActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    const humanEvidence = {
      slackMessageTs: '1000.3',
      userId: 'U_HUMAN',
      content: 'A substantive human answer used only in memory.',
    };
    fixture.dependencies.hydrateHumanEvidence = vi.fn().mockResolvedValue(humanEvidence);
    fixture.dependencies.resolveJudgeModel = vi.fn().mockReturnValue('claude-judge');
    fixture.dependencies.getJudgeClient = vi.fn().mockReturnValue({ messages: {} });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    const judgment = {
      status: 'judged' as const,
      reason: 'judgment_succeeded',
      evaluationValid: true,
      evaluationSkipped: false,
      knowledgeGap: true,
      gapSeverity: 'significant' as const,
      shadowQuality: 'worse' as const,
      deterministicFailureLabels: [],
      shapeWordCount: 42,
      shapeExpectedMaxWords: 100,
      shapeRatioToExpected: 0.42,
      judgeProvider: 'anthropic' as const,
      judgeModel: 'claude-judge',
      selfJudged: false,
      judgePromptVersion: 'official-docs-independent-judge:v1',
      judgePromptHmac: 'c'.repeat(64),
      judgeRequestHmac: 'd'.repeat(64),
      judgeResponseHmac: 'e'.repeat(64),
      sourceOutputHmac: 'b'.repeat(64),
      humanEvidenceContentHmac: 'f'.repeat(64),
      inputTokens: 30,
      outputTokens: 8,
      startedAt: new Date('2026-08-25T08:00:00.000Z'),
      completedAt: new Date('2026-08-25T08:00:01.000Z'),
    };
    const consumer = vi.fn().mockResolvedValue(judgment);
    fixture.dependencies.createOutputConsumer = vi.fn().mockReturnValue(consumer);
    fixture.dependencies.executeReplay = vi.fn().mockResolvedValue({
      traceId: capture.trace_id,
      model: 'claude-test',
      executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
      completeFidelity: true,
      status: 'succeeded',
      reason: 'generation_succeeded',
      outputHmac: 'b'.repeat(64),
      outputBytes: 42,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: 'a'.repeat(64),
      }],
      toolExecutions: [],
      blockedCapabilities: [],
      inputTokens: 20,
      outputTokens: 10,
      judgment,
    });

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({
      evaluated: 1,
      knowledge_gaps: 1,
      shape_regressions: 0,
      skipped: 0,
      errors: 0,
    });
    expect(fixture.dependencies.hydrateHumanEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
    );
    expect(fixture.dependencies.hydrateHumanEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.dependencies.claimGeneration.mock.invocationCallOrder[0]);
    expect(fixture.dependencies.createOutputConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        humanEvidence,
        judgeEnabled: true,
        judgeModel: 'claude-judge',
      }),
      expect.objectContaining({ client: expect.any(Object), renewLease: expect.any(Function) }),
    );
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      expect.objectContaining({ judgment }),
      { judgment },
    );
  });

  it('fails closed before claim or provider calls when signed human evidence cannot hydrate', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.selectJudgeActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.hydrateHumanEvidence = vi.fn().mockRejectedValue(
      new ShadowReplayJudgeBoundaryError('human_evidence_drift'),
    );

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 1, errors: 0 });
    expect(fixture.completeCapture).toHaveBeenCalledWith(
      capture.trace_id,
      capture.thread_id,
      expect.objectContaining({
        status: 'skipped',
        reason: 'human_evidence_drift',
        parityVerified: true,
      }),
    );
    expect(fixture.dependencies.claimGeneration).not.toHaveBeenCalled();
    expect(fixture.dependencies.executeReplay).not.toHaveBeenCalled();
  });

  it('still runs deterministic grading when the signed trace has no comparison target', async () => {
    const fixture = baseDependencies();
    const withoutHuman = authorizedTrace(false);
    fixture.dependencies.resolveTrace = vi.fn().mockResolvedValue(withoutHuman);
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.selectJudgeActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    const judgment = {
      status: 'skipped' as const,
      reason: 'comparison_target_unattributable',
    };
    const consumer = vi.fn().mockResolvedValue(judgment);
    fixture.dependencies.createOutputConsumer = vi.fn().mockReturnValue(consumer);
    fixture.dependencies.executeReplay = vi.fn(async (
      _input: unknown,
      options: {
        outputConsumer: (input: {
          text: string;
          outputHmac: string;
          outputBytes: number;
          generatorModel: string;
        }) => Promise<typeof judgment>;
      },
    ) => ({
      traceId: capture.trace_id,
      model: 'claude-test',
      executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
      completeFidelity: true,
      status: 'succeeded' as const,
      reason: 'generation_succeeded',
      outputHmac: 'b'.repeat(64),
      outputBytes: 20,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: 'a'.repeat(64),
      }],
      toolExecutions: [],
      blockedCapabilities: [],
      inputTokens: 20,
      outputTokens: 10,
      judgment: await options.outputConsumer({
        text: 'A concise answer.',
        outputHmac: 'b'.repeat(64),
        outputBytes: 17,
        generatorModel: 'claude-test',
      }),
    }));

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 1, errors: 0 });
    expect(fixture.dependencies.hydrateHumanEvidence).not.toHaveBeenCalled();
    expect(fixture.dependencies.resolveJudgeModel).not.toHaveBeenCalled();
    expect(fixture.dependencies.getJudgeClient).not.toHaveBeenCalled();
    expect(consumer).toHaveBeenCalledOnce();
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ judgment }),
      { judgment },
    );
  });

  it('does not generate when another worker wins the claim', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('already_claimed');

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 1, errors: 0 });
    expect(fixture.dependencies.executeReplay).not.toHaveBeenCalled();
    expect(fixture.dependencies.completeGeneration).not.toHaveBeenCalled();
    expect(fixture.completeCapture).not.toHaveBeenCalled();
  });

  it('records the daily quota outcome without making a provider call', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('daily_limit_reached');

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 1, errors: 0 });
    expect(fixture.completeCapture).toHaveBeenCalledWith(
      capture.trace_id,
      capture.thread_id,
      expect.objectContaining({
        status: 'skipped',
        reason: 'replay_daily_limit_reached',
        parityVerified: true,
      }),
    );
    expect(fixture.dependencies.executeReplay).not.toHaveBeenCalled();
  });

  it('persists a categorical boundary failure with no raw exception text', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    fixture.dependencies.executeReplay = vi.fn().mockRejectedValue(
      new OfficialDocsReplayBoundaryError('provider_request_drift'),
    );

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 1, errors: 0 });
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      expect.objectContaining({
        status: 'blocked',
        reason: 'provider_request_drift',
        invocations: [],
        blockedCapabilities: ['provider_request_drift'],
      }),
    );
  });

  it('closes a claimed operational failure without retrying generation', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    fixture.dependencies.executeReplay = vi.fn().mockRejectedValue(new Error('private detail'));

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 0, errors: 1 });
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      {
        status: 'error',
        reason: 'replay_generation_failed',
        outputHmac: null,
        outputBytes: 0,
        invocations: [],
        toolExecutions: [],
        blockedCapabilities: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageAvailable: false,
        latencyMs: null,
      },
    );
    expect(fixture.completeCapture).not.toHaveBeenCalled();
  });

  it('preserves hash-only invocation evidence from a post-dispatch failure', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    const completion = {
      traceId: capture.trace_id,
      model: 'claude-test',
      executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
      completeFidelity: false,
      status: 'error' as const,
      reason: 'provider_execution_failed',
      outputHmac: null,
      outputBytes: 0,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: 'a'.repeat(64),
      }],
      toolExecutions: [],
      blockedCapabilities: ['provider_execution_failed', 'usage_unavailable'],
      inputTokens: 0,
      outputTokens: 0,
    };
    fixture.dependencies.executeReplay = vi.fn().mockRejectedValue(
      new OfficialDocsReplayExecutionError(completion),
    );

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 0, errors: 1 });
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      completion,
    );
  });

  it('persists categorical judgment failure when the output consumer throws', async () => {
    const fixture = baseDependencies();
    fixture.dependencies.selectReplayActivation = vi.fn().mockReturnValue({
      enabled: true,
      reason: 'enabled',
      dailyLimit: 5,
    });
    fixture.dependencies.claimGeneration = vi.fn().mockResolvedValue('claimed');
    const completion = {
      traceId: capture.trace_id,
      model: 'claude-test',
      executionPolicyVersion: OFFICIAL_DOCS_REPLAY_EXECUTION_POLICY_VERSION,
      completeFidelity: true,
      status: 'succeeded' as const,
      reason: 'generation_succeeded',
      outputHmac: 'b'.repeat(64),
      outputBytes: 42,
      invocations: [{
        iteration: 1,
        attempt: 1,
        provider_request_hmac: 'a'.repeat(64),
      }],
      toolExecutions: [],
      blockedCapabilities: [],
      inputTokens: 20,
      outputTokens: 10,
    };
    fixture.dependencies.executeReplay = vi.fn().mockRejectedValue(
      new OfficialDocsReplayOutputConsumerError(completion),
    );

    const result = await runShadowEvaluatorJob({ limit: 5 }, fixture.dependencies as never);

    expect(result).toMatchObject({ evaluated: 0, skipped: 0, errors: 1 });
    expect(fixture.dependencies.completeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: capture.trace_id }),
      completion,
      {
        judgment: expect.objectContaining({
          status: 'error',
          reason: 'judgment_internal_error',
          sourceOutputHmac: 'b'.repeat(64),
        }),
      },
    );
  });
});
