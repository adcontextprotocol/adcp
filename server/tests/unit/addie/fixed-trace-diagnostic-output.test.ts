import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedTraceBudget } from '../../../src/addie/eval/fixed-trace-budget.js';
import {
  runFixedTraceDiagnosticArtifact,
  type FixedTraceDiagnosticProviderPlan,
} from '../../../src/addie/eval/fixed-trace-diagnostic-run.js';
import { reserveFixedTraceDiagnosticOutput } from '../../../src/addie/eval/fixed-trace-diagnostic-output.js';
import type { FixedTraceProviderStageConfig } from '../../../src/addie/eval/fixed-trace-runner.js';
import {
  FIXED_TRACE_SUITE,
  fixedTraceSuiteSha256,
  type FixedTracePricing,
} from '../../../src/addie/eval/fixed-trace-suite.js';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';

const CAPABILITIES: ModelProviderCapabilities = {
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  reasoningEfforts: ['none'],
  customTools: true,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
};

const PRICING: FixedTracePricing = {
  profileId: 'synthetic-manual-artifact-v1',
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  cacheReadUsdPerMillionTokens: null,
  cacheWriteUsdPerMillionTokens: null,
  cacheReadAccounting: 'unsupported',
  cacheWriteAccounting: 'unsupported',
  source: 'Synthetic manual artifact pricing.',
};

function scriptedRouter(afterFinalResponse?: () => void): { provider: ModelProvider; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const response: ModelResponse = {
    provider: 'anthropic',
    model: 'synthetic-manual-model',
    id: 'scripted-router-ignore',
    content: [{ type: 'text', text: JSON.stringify({ action: 'ignore', reason: 'Synthetic route.' }) }],
    finishReason: 'stop',
    providerFinishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  const provider: ModelProvider = {
    id: 'anthropic',
    capabilities: CAPABILITIES,
    prepare(request: ModelRequest): PreparedModelInvocation {
      return {
        provider: 'anthropic',
        model: request.model,
        capabilities: CAPABILITIES,
        requestMetadata: request.requestMetadata,
        providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>>,
      };
    },
    async *respond(request: ModelRequest, options: ModelRespondOptions = {}): AsyncIterable<NormalizedModelEvent> {
      await options.beforeDispatch?.(this.prepare(request));
      calls.push(structuredClone(request));
      yield { type: 'response_start', provider: 'anthropic', model: response.model, id: response.id };
      yield { type: 'text_delta', index: 0, text: response.content[0].type === 'text' ? response.content[0].text : '' };
      yield { type: 'response_complete', response };
      afterFinalResponse?.();
    },
  };
  return { provider, calls };
}

function stage(provider: ModelProvider): FixedTraceProviderStageConfig {
  return {
    provider,
    model: 'synthetic-manual-model',
    reasoningEffort: 'none',
    maxOutputTokens: 300,
    timeoutMs: 30_000,
    maxIterations: 1,
    transportRetries: 0,
    samplingMode: 'provider_no_sampling_control',
    temperature: null,
    pricing: PRICING,
  };
}

describe('fixed-trace diagnostic output reservation', () => {
  it('never overwrites an existing artifact', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fixed-trace-output-')), 'artifact.json');
    writeFileSync(path, 'existing');
    expect(() => reserveFixedTraceDiagnosticOutput(path)).toThrow('Cannot exclusively reserve');
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('rejects directory and missing-parent targets before dispatch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    expect(() => reserveFixedTraceDiagnosticOutput(directory)).toThrow('Cannot exclusively reserve');
    expect(() => reserveFixedTraceDiagnosticOutput(join(directory, 'missing', 'artifact.json'))).toThrow('Cannot exclusively reserve');
  });

  it('claims then finalizes through one exclusive descriptor', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fixed-trace-output-')), 'artifact.json');
    const reservation = reserveFixedTraceDiagnosticOutput(path);
    reservation.finalize('{"diagnosticOnly":true}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"diagnosticOnly":true}\n');
  });

  it('runs the manual diagnostic candidate path into a complete reserved artifact with scripted providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    const router = scriptedRouter();
    const plan: FixedTraceDiagnosticProviderPlan = {
      name: 'scripted',
      router: stage(router.provider),
      generation: stage(router.provider),
    };

    const artifact = await runFixedTraceDiagnosticArtifact({
      plans: [plan],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64),
        gitCommit: 'abcdef0',
        gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1',
        traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
        toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local',
        architectureArm: 'two_stage_llm_router',
      },
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget: new FixedTraceBudget(1),
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      artifactVersion: 'fixed_trace_provider_eval_v4',
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      traceSuiteVersion: 'synthetic-manual-suite-v1',
      addieCodeVersion: 'synthetic-code-v1',
      sourceBundleFiles: ['synthetic.ts'],
      budgetNote: 'Synthetic no-network budget note.',
    });

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as typeof artifact;
    expect(router.calls).toHaveLength(1);
    expect(persisted).toMatchObject({
      complete: true,
      diagnosticOnly: true,
      comparisonEligible: false,
      promotionEvidenceEligible: false,
      rolloutPass: false,
      runs: [{
        provider: 'scripted',
        summary: { complete: true, comparisonEligible: false },
        observations: [{ traceId: selectedTrace.id, terminalStatus: 'ignored' }],
      }],
    });
    expect(persisted.runs[0].observations).toHaveLength(1);
  });

  it('does not finalize a manual artifact after a final-response identity mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    const path = join(directory, 'artifact.json');
    const selectedTrace = FIXED_TRACE_SUITE.find((trace) => trace.id === 'surface-channel-chatter');
    if (!selectedTrace) throw new Error('Missing synthetic surface trace');
    let plan!: FixedTraceDiagnosticProviderPlan;
    const router = scriptedRouter(() => { plan.router.model = 'mutated-after-final-response'; });
    plan = { name: 'scripted', router: stage(router.provider), generation: stage(router.provider) };

    await expect(runFixedTraceDiagnosticArtifact({
      plans: [plan],
      baseConfig: {
        sourceBundleSha256: 'a'.repeat(64),
        gitCommit: 'abcdef0',
        gitDirty: false,
        promptConfigVersion: 'synthetic-manual-prompt-v1',
        traceSuite: [selectedTrace],
        traceSuiteSha256: fixedTraceSuiteSha256([selectedTrace]),
        toolDefinitions: [],
        toolDefinitionProvenance: 'fixture_local',
        architectureArm: 'two_stage_llm_router',
      },
      runIdForProvider: (provider) => `synthetic-manual-${provider}`,
      budget: new FixedTraceBudget(1),
      outputReservation: reserveFixedTraceDiagnosticOutput(path),
      artifactVersion: 'fixed_trace_provider_eval_v4',
      runRootId: 'synthetic-manual-root',
      runStartedAt: '2026-09-05T00:00:00.000Z',
      traceSuiteVersion: 'synthetic-manual-suite-v1',
      addieCodeVersion: 'synthetic-code-v1',
      sourceBundleFiles: ['synthetic.ts'],
      budgetNote: 'Synthetic no-network budget note.',
    })).rejects.toThrow('Fixed trace runner execution identity changed before provider dispatch');

    expect(router.calls).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe('');
  });
});
