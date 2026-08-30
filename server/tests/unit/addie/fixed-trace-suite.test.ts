import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CODE_VERSION } from '../../../src/addie/config-version.js';
import {
  FIXED_TRACE_SUITE,
  FIXED_TRACE_SUITE_VERSION,
  fixedTraceSuiteSha256,
  gradeFixedTrace,
  summarizeFixedTraceRun,
  type FixedTraceCase,
  type FixedTraceModelStageMetadata,
  type FixedTraceObservation,
  type FixedTraceRunMetadata,
} from '../../../src/addie/eval/fixed-trace-suite.js';

const HASH = createHash('sha256').update('fixture').digest('hex');

function stage(
  overrides: Partial<FixedTraceModelStageMetadata> = {},
): FixedTraceModelStageMetadata {
  return {
    source: 'provider',
    dispatched: true,
    requestedProvider: 'anthropic',
    requestedModel: 'requested-model',
    returnedProvider: 'anthropic',
    returnedModel: 'requested-model',
    modelResolution: 'exact',
    promptSha256: HASH,
    providerRequestSha256: HASH,
    reasoningEffort: 'none',
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations: 4,
    transportRetries: 0,
    samplingMode: 'temperature_zero',
    temperature: 0,
    usageKnown: true,
    usage: { inputTokens: 100, outputTokens: 20 },
    estimatedCostUsd: 0.0005,
    pricingSource: 'synthetic test rate',
    latencyMs: 5,
    ...overrides,
  };
}

function metadata(overrides: Partial<FixedTraceRunMetadata> = {}): FixedTraceRunMetadata {
  return {
    runId: 'run-synthetic-1',
    traceSuiteVersion: FIXED_TRACE_SUITE_VERSION,
    traceSuiteSha256: fixedTraceSuiteSha256(),
    sourceBundleSha256: HASH,
    gitCommit: '0123456789abcdef',
    gitDirty: false,
    addieCodeVersion: CODE_VERSION,
    promptConfigVersion: 'synthetic-config-v1',
    toolSchemaSha256: HASH,
    router: stage(),
    generation: stage(),
    ...overrides,
  };
}

function passingObservation(trace: FixedTraceCase): FixedTraceObservation {
  const outputMarkers = (trace.expectation.requiredTextAny ?? []).map((group) => group[0]);
  const terminalStatus = trace.expectation.terminalStatuses[0];
  const generation = ['ignored', 'reacted'].includes(terminalStatus)
    ? stage({
        source: 'not_run',
        dispatched: false,
        requestedProvider: null,
        requestedModel: null,
        returnedProvider: null,
        returnedModel: null,
        modelResolution: null,
        providerRequestSha256: null,
        maxOutputTokens: null,
        timeoutMs: null,
        maxIterations: null,
        transportRetries: null,
        samplingMode: null,
        temperature: null,
        usageKnown: false,
        usage: null,
        estimatedCostUsd: 0,
        pricingSource: null,
        latencyMs: 0,
      })
    : terminalStatus === 'provider_error'
      ? stage({
          source: 'local',
          dispatched: false,
          returnedProvider: null,
          returnedModel: null,
          modelResolution: 'local',
          usageKnown: false,
          usage: null,
          estimatedCostUsd: 0,
          pricingSource: null,
          latencyMs: 0,
        })
      : stage();
  return {
    traceId: trace.id,
    metadata: metadata({ generation }),
    terminalStage: ['ignored', 'reacted'].includes(terminalStatus) ? 'surface' : 'generation',
    terminalStatus,
    boundaryReason: null,
    localReplacementReason: null,
    finishReason: terminalStatus === 'truncated' ? 'length' : terminalStatus === 'provider_error' ? null : 'stop',
    output: outputMarkers.join(' '),
    flagged: trace.expectation.requireFlagged ?? false,
    route: { action: trace.routing.action, toolSets: [...trace.routing.toolSets] },
    tools: trace.expectation.requiredTools.map((name) => {
      const fixture = trace.toolFixtures.find((candidate) => candidate.name === name);
      return {
        name,
        description: `Synthetic ${name} fixture.`,
        input: {},
        effect: fixture?.effect ?? 'read',
        policyDisposition: 'allowed',
        resultStatus: fixture?.resultStatus ?? 'ok',
        simulated: true,
      };
    }),
  };
}

describe('fixed cross-provider trace suite', () => {
  it('is a fixed synthetic corpus covering every required risk category', () => {
    expect(FIXED_TRACE_SUITE_VERSION).toBe('addie-fixed-traces-v6');
    expect(FIXED_TRACE_SUITE).toHaveLength(11);
    expect(new Set(FIXED_TRACE_SUITE.map((trace) => trace.id)).size).toBe(FIXED_TRACE_SUITE.length);
    expect(new Set(FIXED_TRACE_SUITE.map((trace) => trace.category))).toEqual(new Set([
      'surface_policy', 'knowledge', 'member_context', 'admin_read', 'safe_mutation',
      'tool_error', 'prompt_injection', 'date_sensitive', 'truncation', 'provider_degradation',
    ]));
    expect(FIXED_TRACE_SUITE.every((trace) => trace.privacy === 'synthetic')).toBe(true);
    const serialized = JSON.stringify(FIXED_TRACE_SUITE);
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serialized).not.toMatch(/\b[UW][A-Z0-9]{8,}\b/);
    expect(serialized).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
  });

  it('has a stable version-bound fingerprint and no duplicate tool contracts', () => {
    expect(fixedTraceSuiteSha256()).toMatch(/^[a-f0-9]{64}$/);
    expect(fixedTraceSuiteSha256()).toBe(fixedTraceSuiteSha256(structuredClone(FIXED_TRACE_SUITE)));
    for (const trace of FIXED_TRACE_SUITE) {
      expect(new Date(trace.request.nowUtc).toISOString(), trace.id).toBe(trace.request.nowUtc);
      expect(trace.expectation.terminalStatuses.length, trace.id).toBeGreaterThan(0);
      expect(new Set(trace.expectation.requiredTools).size, trace.id).toBe(trace.expectation.requiredTools.length);
      expect(new Set(trace.expectation.allowedTools).size, trace.id).toBe(trace.expectation.allowedTools.length);
      expect(trace.expectation.requiredTools.every((name) => trace.expectation.allowedTools.includes(name)), trace.id).toBe(true);
      expect(trace.expectation.forbiddenTools.every((name) => !trace.expectation.allowedTools.includes(name)), trace.id).toBe(true);
      expect(trace.toolFixtures.map((fixture) => fixture.name).sort(), trace.id).toEqual([...trace.expectation.allowedTools].sort());
      expect((trace.expectation.requiredTextAny ?? []).every((group) => group.length > 0), trace.id).toBe(true);
    }
    expect(Object.isFrozen(FIXED_TRACE_SUITE)).toBe(true);
    expect(Object.isFrozen(FIXED_TRACE_SUITE[0].request)).toBe(true);
  });

  it('passes the deterministic smoke vector without consulting subjective rubrics', () => {
    const observations = FIXED_TRACE_SUITE.map(passingObservation);
    const { grades, summary } = summarizeFixedTraceRun(observations);
    expect(grades.every((grade) => grade.deterministicPass)).toBe(true);
    expect(summary).toMatchObject({
      expected: 11,
      observed: 11,
      omitted: 0,
      complete: true,
      deterministicPassRate: 1,
      answerPassRate: 1,
      routingPassRate: 1,
      toolSelectionPassRate: 1,
      mutationSafetyPassRate: 1,
      metadataPassRate: 1,
      latencyP95Ms: 10,
    });
    expect(summary.terminalFailureRate).toBeCloseTo(2 / 11);
    expect(summary.totalEstimatedCostUsd).toBeCloseTo(0.01);
    expect(summary.comparisonEligible).toBe(true);
    expect(summary.terminalStatusCounts).toMatchObject({
      complete: 8,
      ignored: 1,
      truncated: 1,
      provider_error: 1,
    });
  });

  it('keeps billing inputs executable and accepts equivalent authoritative UTC date formats', () => {
    for (const traceId of ['billing-invoice-preview-only', 'billing-invoice-confirmed']) {
      const billingTrace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === traceId)!;
      expect(JSON.stringify(billingTrace.request)).toContain('company_membership_annual_synthetic');
    }

    const dateTrace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'current-utc-date')!;
    const naturalLanguageDate = passingObservation(dateTrace);
    naturalLanguageDate.output = 'The current UTC date is August 28, 2026.';
    expect(gradeFixedTrace(dateTrace, naturalLanguageDate)).toMatchObject({
      deterministicPass: true,
      answerPass: true,
    });

    const toolErrorTrace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-tool-error')!;
    const smartPunctuation = passingObservation(toolErrorTrace);
    smartPunctuation.output = 'The search failed, so I can’t verify the official wording.';
    expect(gradeFixedTrace(toolErrorTrace, smartPunctuation)).toMatchObject({
      deterministicPass: true,
      answerPass: true,
    });

    const reachFailure = passingObservation(toolErrorTrace);
    reachFailure.output = "I couldn't reach documentation search in this session.";
    expect(gradeFixedTrace(toolErrorTrace, reachFailure)).toMatchObject({
      deterministicPass: true,
      answerPass: true,
    });
  });

  it('keeps malformed, truncated, provider errors, and budget skips in the denominator', () => {
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-task-model')!;
    const statuses = ['malformed', 'truncated', 'provider_error', 'not_dispatched_budget'] as const;
    const observations = statuses.map((terminalStatus, index) => ({
      ...passingObservation(trace),
      traceId: `${trace.id}-${index}`,
      terminalStatus,
    }));
    const syntheticSuite = observations.map((observation, index) => ({
      ...trace,
      id: observation.traceId,
      expectation: { ...trace.expectation, terminalStatuses: ['complete'] as const },
    }));
    const { grades, summary } = summarizeFixedTraceRun(observations, syntheticSuite);
    expect(grades).toHaveLength(4);
    expect(grades.every((grade) => !grade.deterministicPass && grade.terminalFailure)).toBe(true);
    expect(summary.deterministicPassRate).toBe(0);
    expect(summary.terminalFailureRate).toBe(1);
  });

  it('fails a real or unconfirmed mutation even when the answer and route look right', () => {
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'billing-invoice-preview-only')!;
    const observation = passingObservation(trace);
    observation.tools.push({
      name: 'confirm_send_invoice',
      description: 'Synthetic confirm_send_invoice fixture.',
      input: {},
      effect: 'mutation',
      policyDisposition: 'allowed',
      resultStatus: 'ok',
      simulated: false,
    });
    const grade = gradeFixedTrace(trace, observation);
    expect(grade.toolSelectionPass).toBe(false);
    expect(grade.mutationSafetyPass).toBe(false);
    expect(grade.failures).toEqual(expect.arrayContaining(['tool_selection_mismatch', 'mutation_safety_violation']));
  });

  it('does not treat a blocked or mismatched fixture execution as correct tool selection', () => {
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-tool-error')!;
    const observation = passingObservation(trace);
    observation.tools[0].policyDisposition = 'blocked';
    observation.tools[0].resultStatus = 'ok';
    expect(gradeFixedTrace(trace, observation)).toMatchObject({
      deterministicPass: false,
      toolSelectionPass: false,
    });
  });

  it('fails closed when executed tool evidence is missing or out of bounds', () => {
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-task-model')!;
    const missingDescription = passingObservation(trace);
    missingDescription.tools[0].description = '';
    expect(gradeFixedTrace(trace, missingDescription).failures).toContain('tool_evidence_invalid');

    const invalidInput = passingObservation(trace);
    invalidInput.tools[0].input = [] as unknown as typeof invalidInput.tools[0]['input'];
    expect(gradeFixedTrace(trace, invalidInput)).toMatchObject({
      deterministicPass: false,
      toolSelectionPass: false,
      failures: expect.arrayContaining(['tool_evidence_invalid']),
    });
  });

  it('fails closed when complete model, prompt, tool, usage, or cost provenance is missing', () => {
    const trace = FIXED_TRACE_SUITE[1];
    const observation = passingObservation(trace);
    observation.metadata = metadata({
      traceSuiteSha256: HASH,
      generation: stage({
        promptSha256: 'not-a-hash',
        returnedProvider: null,
        returnedModel: null,
        modelResolution: 'exact',
        usageKnown: true,
        usage: null,
        estimatedCostUsd: null,
        pricingSource: null,
      }),
    });
    const grade = gradeFixedTrace(trace, observation);
    expect(grade.metadataPass).toBe(false);
    expect(grade.deterministicPass).toBe(false);
    expect(grade.failures).toEqual(expect.arrayContaining([
      'trace_suite_hash_mismatch',
      'generation_prompt_hash_invalid',
      'generation_usage_consistency_invalid',
      'generation_cost_provenance_missing',
      'generation_provider_identity_missing',
    ]));
  });

  it('reports omissions instead of silently shrinking the requested matrix', () => {
    const { summary } = summarizeFixedTraceRun(FIXED_TRACE_SUITE.slice(0, 3).map(passingObservation));
    expect(summary).toMatchObject({ expected: 11, observed: 3, omitted: 8, complete: false });
  });

  it('rejects duplicate and unknown observations', () => {
    const observation = passingObservation(FIXED_TRACE_SUITE[0]);
    expect(() => summarizeFixedTraceRun([observation, observation])).toThrow('Duplicate fixed trace observation');
    expect(() => summarizeFixedTraceRun([{ ...observation, traceId: 'unknown' }])).toThrow('Unknown fixed trace observation');
  });

  it('rejects observations combined from different provider runs', () => {
    const first = passingObservation(FIXED_TRACE_SUITE[0]);
    const second = passingObservation(FIXED_TRACE_SUITE[1]);
    second.metadata = metadata({ runId: 'another-run' });
    expect(() => summarizeFixedTraceRun([first, second])).toThrow('Mixed fixed trace run metadata');
  });

  it('rejects observations combined from different tool schemas', () => {
    const first = passingObservation(FIXED_TRACE_SUITE[0]);
    const second = passingObservation(FIXED_TRACE_SUITE[1]);
    second.metadata = metadata({ toolSchemaSha256: createHash('sha256').update('other-schema').digest('hex') });
    expect(() => summarizeFixedTraceRun([first, second])).toThrow('Mixed fixed trace run metadata');
  });

  it('accepts an explicitly attributed malformed router result', () => {
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-task-model')!;
    const observation = passingObservation(trace);
    observation.terminalStage = 'router';
    observation.terminalStatus = 'malformed';
    observation.finishReason = 'stop';
    observation.output = 'not-json';
    observation.flagged = true;
    observation.route = null;
    observation.tools = [];
    observation.metadata = metadata({
      generation: stage({
        source: 'not_run',
        dispatched: false,
        requestedProvider: null,
        requestedModel: null,
        returnedProvider: null,
        returnedModel: null,
        modelResolution: null,
        providerRequestSha256: null,
        maxOutputTokens: null,
        timeoutMs: null,
        maxIterations: null,
        transportRetries: null,
        samplingMode: null,
        temperature: null,
        usageKnown: false,
        usage: null,
        estimatedCostUsd: 0,
        pricingSource: null,
        latencyMs: 0,
      }),
    });
    expect(gradeFixedTrace(trace, observation).failures).toEqual(expect.arrayContaining([
      'routing_mismatch',
      'answer_assertion_failed',
    ]));
    expect(gradeFixedTrace(trace, observation).failures).not.toContain('terminal_stage_mismatch');
  });

  it('rejects an unflagged local response replacement', () => {
    const trace = FIXED_TRACE_SUITE.find((candidate) => candidate.id === 'knowledge-tool-error')!;
    const observation = passingObservation(trace);
    observation.localReplacementReason = 'failed_lookup_evidence';
    observation.flagged = false;

    expect(gradeFixedTrace(trace, observation).failures).toContain(
      'local_replacement_metadata_invalid',
    );
  });
});
