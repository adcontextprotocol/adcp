import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitFixedTraceArchitectureDiagnostic,
  consumeFixedTraceArchitectureDiagnosticSelector,
  fixedTraceArchitectureDiagnosticCostCeiling,
  fixedTraceArchitectureDiagnosticPlan,
  reserveFixedTraceArchitectureDiagnosticOutput,
  runFixedTraceArchitectureDiagnosticArtifact,
} from '../../../src/addie/eval/fixed-trace-architecture-diagnostic-execution.js';
import { fixedTraceArchitectureDiagnosticPilotStageControls } from '../../../src/addie/eval/fixed-trace-architecture-diagnostic.js';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  fixedTraceResponsePricingPolicy,
} from '../../../src/addie/eval/fixed-trace-budget.js';
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
  streaming: false, structuredOutput: true, reasoning: true,
  reasoningEfforts: ['provider_default'], customTools: true,
  providerWebSearch: false, imageInput: false, documentInput: false,
};

class ScriptedAnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = CAPABILITIES;
  readonly calls: ModelRequest[] = [];

  constructor(private readonly unknownGenerationModel = false) {}

  prepare(request: ModelRequest): PreparedModelInvocation {
    return {
      provider: this.id,
      model: request.model,
      capabilities: this.capabilities,
      requestMetadata: request.requestMetadata,
      providerRequest: structuredClone(request) as unknown as Record<string, unknown>,
    };
  }

  async *respond(request: ModelRequest, options: ModelRespondOptions = {}): AsyncIterable<NormalizedModelEvent> {
    await options.beforeDispatch?.(this.prepare(request));
    this.calls.push(structuredClone(request));
    const router = request.requestMetadata?.purpose === 'fixed_trace_router';
    const response: ModelResponse = {
      provider: this.id,
      model: router ? 'claude-haiku-4-5' : this.unknownGenerationModel ? 'unapproved-model' : 'claude-sonnet-5',
      id: `synthetic-${this.calls.length}`,
      content: [{ type: 'text', text: router
        ? JSON.stringify({ action: 'respond', tool_sets: [], confidence: 'high', requires_depth: false, reason: 'Synthetic route.' })
        : 'Synthetic diagnostic response.' }],
      finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 },
    };
    yield { type: 'response_start', provider: this.id, model: response.model, id: response.id };
    yield { type: 'text_delta', index: 0, text: response.content[0]!.type === 'text' ? response.content[0].text : '' };
    yield { type: 'response_complete', response };
  }
}

function admitted(unknownGenerationModel = false) {
  const ceiling = fixedTraceArchitectureDiagnosticCostCeiling();
  const budget = new FixedTraceBudget(ceiling.requiredSoftMaxUsd);
  const raw = new ScriptedAnthropicProvider(unknownGenerationModel);
  const controls = fixedTraceArchitectureDiagnosticPilotStageControls();
  const router = new BudgetedFixedTraceProvider(
    raw, budget, controls.router.pricing,
    fixedTraceResponsePricingPolicy('anthropic', controls.router.model, controls.router.pricing),
  );
  const generation = new BudgetedFixedTraceProvider(
    raw, budget, controls.generation.pricing,
    fixedTraceResponsePricingPolicy('anthropic', controls.generation.model, controls.generation.pricing),
  );
  const admission = admitFixedTraceArchitectureDiagnostic({
    runRootId: 'architecture-test-root', sourceBundleSha256: 'a'.repeat(64),
    gitCommit: 'abcdef0', promptConfigVersion: 'architecture-test-prompt', router, generation, budget,
  });
  return { admission, budget, raw };
}

function plan() {
  return fixedTraceArchitectureDiagnosticPlan({
    sourceFiles: ['synthetic.ts'], sourceBundleSha256: 'a'.repeat(64), promptConfigVersion: 'architecture-test-prompt',
  });
}

describe('fixed-trace architecture diagnostic execution', () => {
  it('predeclares one bounded all-arm Anthropic cell and no external-final authority', () => {
    const ceiling = fixedTraceArchitectureDiagnosticCostCeiling();
    expect(ceiling).toMatchObject({
      preparedRequestBytes: 262_144,
      routerMaxDispatches: 40,
      generationMaxDispatches: 128,
      totalMaxDispatches: 168,
      requiredSoftMaxUsd: expect.any(Number),
    });
    expect(plan()).toMatchObject({
      architectureDiagnosticMode: 'synthetic_sonnet_full_pack_v1',
      traceCount: 24,
      arms: ['direct_generation', 'two_stage_llm_router', 'deterministic_policy_llm_fallback_hybrid'],
      diagnosticOnly: true,
      comparisonEligible: false,
      formalExternalFinal: 'unavailable',
    });
  });

  it('retains all three arms with provider identities, usage, and tool/continuation observations', async () => {
    const { admission, budget, raw } = admitted();
    const artifact = await runFixedTraceArchitectureDiagnosticArtifact({
      admission, budget, runRootId: 'architecture-test-root', runStartedAt: '2026-09-07T00:00:00.000Z', plan: plan(),
    });
    expect(raw.calls).toHaveLength(104);
    expect(artifact).toMatchObject({
      complete: true, diagnosticOnly: true, comparisonEligible: false,
      promotionEvidenceEligible: false, formalExternalFinal: 'unavailable', failure: null,
    });
    expect(artifact.runs).toHaveLength(3);
    for (const run of artifact.runs as Array<{ observations: Array<{ metadata: { router: { providerExposures: unknown[]; usage: unknown }; generation: { providerExposures: unknown[]; usage: unknown } }; tools: unknown[]; rejectedToolCalls: unknown[] }> }>) {
      expect(run.observations).toHaveLength(24);
      for (const observation of run.observations) {
        expect(Array.isArray(observation.tools)).toBe(true);
        expect(Array.isArray(observation.rejectedToolCalls)).toBe(true);
        expect(Array.isArray(observation.metadata.router.providerExposures)).toBe(true);
        expect(Array.isArray(observation.metadata.generation.providerExposures)).toBe(true);
      }
    }
    expect(budget.snapshot()).toMatchObject({ reservedUsd: 0, dispatchedCalls: 104, completedCalls: 104, exposureUnknown: false });
  });

  it('preserves unknown provider exposure in a finalized diagnostic artifact instead of inventing cost certainty', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'architecture-diagnostic-'));
    const output = join(directory, 'artifact.json');
    const { admission, budget } = admitted(true);
    const artifact = await runFixedTraceArchitectureDiagnosticArtifact({
      admission, budget, runRootId: 'architecture-test-root', runStartedAt: '2026-09-07T00:00:00.000Z', plan: plan(),
    });
    const reservation = reserveFixedTraceArchitectureDiagnosticOutput(output);
    const digest = reservation.finalize(artifact);
    // Denominator coverage remains retained, but unknown paid exposure cannot
    // be represented as a completed settled execution.
    expect(artifact).toMatchObject({ complete: false, comparisonEligible: false, failure: null });
    expect(artifact.runs).toHaveLength(3);
    expect(budget.snapshot()).toMatchObject({ exposureUnknown: true, completedCalls: 0, dispatchedCalls: 1, reservedUsd: 0 });
    expect(readFileSync(`${output}.sha256`, 'utf8')).toBe(`${digest}  ${output}\n`);
    expect(createHash('sha256').update(readFileSync(output, 'utf8')).digest('hex')).toBe(digest);
  });

  it('never overwrites an artifact, checksum, or selector identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'architecture-diagnostic-'));
    const output = join(directory, 'artifact.json');
    const selector = join(directory, 'cell.used');
    writeFileSync(output, 'existing');
    expect(() => reserveFixedTraceArchitectureDiagnosticOutput(output)).toThrow('Cannot exclusively reserve');
    expect(readFileSync(output, 'utf8')).toBe('existing');
    consumeFixedTraceArchitectureDiagnosticSelector(selector, {
      sourceBundleSha256: 'a'.repeat(64), promptConfigVersion: 'prompt',
    });
    expect(() => consumeFixedTraceArchitectureDiagnosticSelector(selector, {
      sourceBundleSha256: 'a'.repeat(64), promptConfigVersion: 'prompt',
    })).toThrow('already consumed');
  });
});
