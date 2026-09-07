import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModelProvider, ModelProviderCapabilities, ModelProviderId, ModelRequest, ModelRespondOptions, ModelResponse, NormalizedModelEvent, PreparedModelInvocation } from '../../../src/addie/model-providers/model-provider.js';
import { BudgetedFixedTraceProvider, FixedTraceBudget, fixedTraceDirectFullSuiteResponsePricingPolicy, fixedTraceEstimatedCostUsd, fixedTraceResponseUsesPricingPolicy } from '../../../src/addie/eval/fixed-trace-budget.js';
import { datedPricingProfilesForFixedTrace } from '../../../src/addie/eval/dated-pricing-cohort.js';
import { FIXED_TRACE_DIRECT_FULL_SUITE_CELLS, admitFixedTraceDirectFullSuiteComparison, assertFixedTraceDirectFullSuiteCostCeiling, consumeFixedTraceDirectFullSuiteSelector, fixedTraceDirectFullSuiteAnthropicApiKey, fixedTraceDirectFullSuiteCell, fixedTraceDirectFullSuiteConfig, fixedTraceDirectFullSuiteCostCeiling, fixedTraceDirectFullSuitePlan, reserveFixedTraceDirectFullSuiteOutput, runFixedTraceDirectFullSuiteComparisonArtifact } from '../../../src/addie/eval/fixed-trace-direct-full-suite.js';
import { FIXED_TRACE_SUITE, FIXED_TRACE_SUITE_VERSION, fixedTraceSuiteSha256 } from '../../../src/addie/eval/fixed-trace-suite.js';

const CAPABILITIES: ModelProviderCapabilities = { streaming: false, structuredOutput: true, reasoning: true, reasoningEfforts: ['provider_default', 'low', 'medium', 'high'], customTools: true, providerWebSearch: false, imageInput: false, documentInput: false };
const HASH = createHash('sha256').update('direct-full-suite-test').digest('hex');

class FakeProvider implements ModelProvider {
  readonly capabilities = CAPABILITIES;
  readonly requests: ModelRequest[] = [];
  /** Boundary values observed before an SDK request is allowed to leave. */
  readonly boundaryInvocations: PreparedModelInvocation[] = [];
  readonly prepare = vi.fn((request: ModelRequest): PreparedModelInvocation => ({ provider: this.id, model: request.model, capabilities: this.capabilities, requestMetadata: request.requestMetadata, providerRequest: structuredClone(request) as unknown as Readonly<Record<string, unknown>> }));
  constructor(
    readonly id: ModelProviderId,
    readonly failAfterDispatch = false,
    readonly responsePatch: Partial<ModelResponse> = {},
    readonly dispatchPreparation?: (request: ModelRequest, preliminary: PreparedModelInvocation) => PreparedModelInvocation,
  ) {}
  async *respond(request: ModelRequest, options: ModelRespondOptions = {}): AsyncIterable<NormalizedModelEvent> {
    const preliminary = this.prepare(request);
    const prepared = this.dispatchPreparation?.(request, preliminary) ?? preliminary;
    this.boundaryInvocations.push(structuredClone(prepared));
    await options.beforeDispatch?.(prepared);
    // This is intentionally after the policy boundary: it represents the
    // fake's one actual SDK dispatch, not merely a prepared invocation.
    this.requests.push(structuredClone(request));
    if (this.failAfterDispatch) throw new Error('synthetic post-dispatch transport loss');
    const judge = request.requestMetadata?.purpose === 'fixed_trace_blinded_judge';
    const response: ModelResponse = { provider: this.id, model: request.model, id: `${this.id}-${this.requests.length}`, content: [{ type: 'text', text: judge ? '{"pass":true,"finding":"synthetic"}' : 'Synthetic fixed-trace response.' }], finishReason: 'stop', providerFinishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, ...this.responsePatch };
    yield { type: 'response_start', provider: response.provider, model: response.model, id: response.id };
    yield { type: 'text_delta', index: 0, text: response.content[0]!.type === 'text' ? response.content[0]!.text : '' };
    yield { type: 'response_complete', response };
  }
}

function budgeted(provider: ModelProvider, model: string, budget: FixedTraceBudget): BudgetedFixedTraceProvider {
  const pricing = datedPricingProfilesForFixedTrace().find((entry) => entry.provider === provider.id && entry.model === model)!;
  return new BudgetedFixedTraceProvider(provider, budget, pricing, fixedTraceDirectFullSuiteResponsePricingPolicy(provider.id, model, pricing));
}

async function run(
  cellId: typeof FIXED_TRACE_DIRECT_FULL_SUITE_CELLS[number],
  fail = false,
  judgeResponsePatch: Partial<ModelResponse> = {},
  judgeOverrides: Partial<Record<ModelProviderId, FakeProvider>> = {},
  candidateResponsePatch: Partial<ModelResponse> = {},
) {
  const cell = fixedTraceDirectFullSuiteCell(cellId); const budget = new FixedTraceBudget(fixedTraceDirectFullSuiteCostCeiling(cellId).requiredSoftMaxUsd);
  const rawCandidate = new FakeProvider(cell.provider, fail, candidateResponsePatch);
  const candidate = budgeted(rawCandidate, cell.model, budget);
  const rawJudges = {
    anthropic: judgeOverrides.anthropic ?? new FakeProvider('anthropic', false, judgeResponsePatch),
    google: judgeOverrides.google ?? new FakeProvider('google', false, judgeResponsePatch),
    openai: judgeOverrides.openai ?? new FakeProvider('openai', false, judgeResponsePatch),
  };
  const judges = {
    anthropic: budgeted(rawJudges.anthropic, 'claude-haiku-4-5', budget),
    google: budgeted(rawJudges.google, 'gemini-3.7-flash', budget),
    openai: budgeted(rawJudges.openai, 'gpt-5.6-luna', budget),
  };
  const candidateConfig = fixedTraceDirectFullSuiteConfig({ runId: `test-${cellId}`, sourceBundleSha256: HASH, gitCommit: 'abcdef0', provider: candidate, cellId, promptConfigVersion: HASH });
  return { cell, budget, rawCandidate, rawJudges, result: await runFixedTraceDirectFullSuiteComparisonArtifact({ candidate: candidateConfig, judgeProviders: judges, budget }) };
}

describe('fixed-trace direct full-suite comparison', () => {
  it('selects the Addie Anthropic credential alias before the generic fallback without constructing a provider', () => {
    expect(fixedTraceDirectFullSuiteAnthropicApiKey({ ADDIE_ANTHROPIC_API_KEY: 'session-only' })).toBe('session-only');
    expect(fixedTraceDirectFullSuiteAnthropicApiKey({ ANTHROPIC_API_KEY: 'fallback-only' })).toBe('fallback-only');
    expect(fixedTraceDirectFullSuiteAnthropicApiKey({ ADDIE_ANTHROPIC_API_KEY: 'session', ANTHROPIC_API_KEY: 'fallback' })).toBe('session');
    expect(fixedTraceDirectFullSuiteAnthropicApiKey({})).toBeUndefined();
  });

  it.each(FIXED_TRACE_DIRECT_FULL_SUITE_CELLS)('runs only the exact direct candidate and two provider-excluding judge slots for %s', async (cellId) => {
    const { cell, budget, rawCandidate, rawJudges, result } = await run(cellId);
    expect(FIXED_TRACE_SUITE_VERSION).toBe('addie-fixed-traces-v32');
    expect(FIXED_TRACE_SUITE).toHaveLength(32);
    expect(fixedTraceSuiteSha256(FIXED_TRACE_SUITE)).toBe('5f7f0a6d653a4757991728a1d9de8aee69b40d580dafb65e98941c1f9e3fea83');
    expect(result.observations).toHaveLength(32);
    expect(result.observations.every((entry) => entry.metadata.router.source === 'not_run' && entry.routeDisposition === 'direct_surface_policy')).toBe(true);
    expect(result.observations.find((observation) => observation.traceId === 'surface-channel-chatter')?.metadata.generation).toMatchObject({ source: 'not_run', dispatched: false, dispatchedCalls: 0, requestedProvider: null, returnedProvider: null });
    expect(result.observations.find((observation) => observation.traceId === 'provider-unavailable')?.metadata.generation).toMatchObject({ source: 'local', dispatched: false, dispatchedCalls: 0, returnedProvider: null, returnedModel: null, modelResolution: 'local' });
    expect(result.grades.find((grade) => grade.traceId === 'provider-unavailable')?.failures).not.toContain('direct_full_suite_local_generation_identity_invalid');
    expect(result.judgments).toHaveLength(64);
    expect(new Set(result.judgments.map((entry) => entry.judgeProvider))).toEqual(new Set(cell.judgeProviders));
    // The canonical corpus's two deterministic ignore/react surfaces remain
    // in the 32-case denominator without a generation request.
    expect(rawCandidate.requests).toHaveLength(30);
    expect(rawCandidate.requests.every((request) => request.requestMetadata?.purpose === 'fixed_trace_generation')).toBe(true);
    expect(Object.values(rawJudges).flatMap((provider) => provider.requests).every((request) => request.requestMetadata?.purpose === 'fixed_trace_blinded_judge')).toBe(true);
    expect(result.judgments[0]).toMatchObject({
      requestedProvider: cell.judgeProviders[0], requestedReasoningEffort: 'provider_default',
      returnedReasoningEffort: null, usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop', promptConfigVersion: 'addie-fixed-trace-blinded-judge-v2',
    });
    expect(result.judgments[0]?.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.judgments[0]?.providerRequestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.judgments[0]?.judgeConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.judgments[0]?.pricingProfileId).toBeTruthy();
    expect(result.judgments[0]?.pricingSource).toBeTruthy();
    expect(budget.snapshot().reservedUsd).toBe(0);
  }, 30_000);

  it('publishes deterministic per-cell whole-run ceilings with all 384 candidate and 64 judge calls', () => {
    expect(FIXED_TRACE_DIRECT_FULL_SUITE_CELLS.map((cellId) => [cellId, fixedTraceDirectFullSuiteCostCeiling(cellId).requiredSoftMaxUsd])).toEqual([
      ['generation:anthropic:claude-sonnet-5:provider_default', 478.71816320000005],
      ['generation:anthropic:claude-haiku-4-5:provider_default', 240.43141760000003],
      ['generation:google:gemini-3.7-flash:provider_default', 82.30558719999999],
      ['generation:google:gemini-3.7-flash:low', 82.30558719999999],
      ['generation:google:gemini-3.7-flash:medium', 82.30558719999999],
      ['generation:google:gemini-3.7-flash:high', 82.30558719999999],
    ]);
    const ceiling = fixedTraceDirectFullSuiteCostCeiling('generation:anthropic:claude-sonnet-5:provider_default');
    expect(ceiling).toMatchObject({ candidateMaxDispatches: 384, judgeMaxDispatches: 64, requiredSoftMaxUsd: ceiling.totalUsd });
    expect(ceiling.components.reduce((calls, component) => calls + component.dispatches, 0)).toBe(448);
    expect(ceiling.components.flatMap((component) => component.pricingBuckets).some((bucket) => bucket.accounting === 'additive')).toBe(true);
  });

  it('escrows the whole cell before execution without double-counting per-call reservations', async () => {
    const cell = fixedTraceDirectFullSuiteCell('generation:google:gemini-3.7-flash:high');
    const budget = new FixedTraceBudget(300);
    const rawCandidate = new FakeProvider('google');
    const candidate = budgeted(rawCandidate, cell.model, budget);
    const rawJudges = { anthropic: new FakeProvider('anthropic'), google: new FakeProvider('google'), openai: new FakeProvider('openai') };
    const judges = {
      anthropic: budgeted(rawJudges.anthropic, 'claude-haiku-4-5', budget),
      google: budgeted(rawJudges.google, 'gemini-3.7-flash', budget),
      openai: budgeted(rawJudges.openai, 'gpt-5.6-luna', budget),
    };
    const config = fixedTraceDirectFullSuiteConfig({ runId: 'admission', sourceBundleSha256: HASH, gitCommit: 'abcdef0', provider: candidate, cellId: cell.id, promptConfigVersion: HASH });
    const admission = admitFixedTraceDirectFullSuiteComparison({ candidate: config, judgeProviders: judges, budget });
    expect(budget.snapshot().reservedUsd).toBe(fixedTraceDirectFullSuiteCostCeiling(cell.id).totalUsd);
    expect(rawCandidate.requests).toHaveLength(0);
    const result = await runFixedTraceDirectFullSuiteComparisonArtifact({ candidate: config, judgeProviders: judges, budget, admission });
    const candidatePricing = datedPricingProfilesForFixedTrace().find((entry) => entry.provider === cell.provider && entry.model === cell.model)!;
    const expectedCandidateCost = 30 * fixedTraceEstimatedCostUsd({ inputTokens: 1, outputTokens: 1 }, candidatePricing);
    const expectedJudgeCost = result.judgments.reduce((total, judgment) => total + (judgment.estimatedCostUsd ?? 0), 0);
    expect(budget.snapshot()).toMatchObject({ reservedUsd: 0, exposureUnknown: false });
    expect(budget.snapshot().accountedSpendUsd).toBeCloseTo(expectedCandidateCost + expectedJudgeCost, 14);
  }, 30_000);

  it('preserves exact judge provenance and fails closed on wrong identity or missing normalized usage', async () => {
    const wrongIdentity = await run('generation:google:gemini-3.7-flash:high', false, { model: 'unreviewed-model' });
    expect(wrongIdentity.result.judgments[0]).toMatchObject({
      status: 'unknown_exposure', requestedProvider: 'anthropic', requestedReasoningEffort: 'provider_default',
      returnedProvider: 'anthropic', returnedModel: 'unreviewed-model', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsd: null, pricingPolicy: { expectedProvider: 'anthropic', expectedModel: 'claude-haiku-4-5' },
    });
    const missingUsage = await run('generation:google:gemini-3.7-flash:high', false, { usage: { inputTokens: -1, outputTokens: 1 } as ModelResponse['usage'] });
    expect(missingUsage.result.judgments[0]).toMatchObject({
      status: 'unknown_exposure', returnedProvider: 'anthropic', returnedModel: 'claude-haiku-4-5', usage: null, estimatedCostUsd: null,
    });
    const plan = fixedTraceDirectFullSuitePlan({ cellId: 'generation:google:gemini-3.7-flash:high', sourceFiles: ['fixture.ts'], sourceBundleSha256: HASH, promptConfigVersion: HASH, softMaxUsd: 300 });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.judges).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'anthropic', reasoningEffort: 'provider_default', pricingProfileSha256: expect.stringMatching(/^sha256:/) })]));
  }, 30_000);

  it('admits a dated Claude candidate identity only when it is approved by the recorded pricing policy', async () => {
    const datedModel = 'claude-haiku-4-5-20251001';
    const { budget, result } = await run(
      'generation:anthropic:claude-haiku-4-5:provider_default',
      false,
      {},
      {},
      { model: datedModel },
    );
    const providerObservations = result.observations.filter((observation) => observation.metadata.generation.source === 'provider');
    expect(providerObservations).toHaveLength(30);
    const control = providerObservations[0]!.metadata.generationControl;
    expect(fixedTraceResponseUsesPricingPolicy(fixedTraceDirectFullSuiteResponsePricingPolicy(control.requestedProvider, control.requestedModel, control.pricing), { provider: 'anthropic', model: datedModel })).toBe(true);
    expect(providerObservations.every((observation) => observation.metadata.generation.returnedModel === datedModel)).toBe(true);
    expect(providerObservations.every((observation) => observation.metadata.generation.modelResolution === 'provider_canonicalized')).toBe(true);
    expect(providerObservations.map((observation) => observation.terminalStatus)).not.toContain('unknown_exposure');
    expect(result.grades.filter((grade) => providerObservations.some((observation) => observation.traceId === grade.traceId))
      .every((grade) => !grade.failures.includes('generation_model_resolution_policy_mismatch'))).toBe(true);
    expect(budget.snapshot()).toMatchObject({ exposureUnknown: false });
  }, 30_000);

  it('continues to fail closed for an unreviewed Claude candidate identity', async () => {
    const { result } = await run(
      'generation:anthropic:claude-haiku-4-5:provider_default',
      false,
      {},
      {},
      { model: 'claude-unreviewed-20990101' },
    );
    const providerObservations = result.observations.filter((observation) => observation.metadata.generation.source === 'provider');
    expect(providerObservations).toHaveLength(1);
    expect(providerObservations[0]?.terminalStatus).toBe('unknown_exposure');
    expect(result.observations).toHaveLength(32);
  }, 30_000);

  it('records the exact dispatch-boundary judge invocation rather than an earlier preparation', async () => {
    const divergent = new FakeProvider('anthropic', false, {}, (_request, preliminary) => Object.freeze({
      ...preliminary,
      providerRequest: Object.freeze({ ...preliminary.providerRequest, dispatch_boundary_only: true }),
    }));
    const { result } = await run(
      'generation:google:gemini-3.7-flash:high',
      false,
      {},
      { anthropic: divergent },
    );
    const actual = divergent.boundaryInvocations[0]!;
    const judgment = result.judgments.find((entry) => entry.judgeProvider === 'anthropic')!;
    expect(divergent.prepare).toHaveBeenCalledTimes(32);
    expect(actual.providerRequest).toMatchObject({ dispatch_boundary_only: true });
    expect(judgment.providerRequestSha256).toBe(createHash('sha256').update(JSON.stringify(actual.providerRequest), 'utf8').digest('hex'));
  }, 30_000);

  it('rejects an oversized exact judge boundary invocation before SDK dispatch', async () => {
    const oversized = new FakeProvider('anthropic', false, {}, (_request, preliminary) => Object.freeze({
      ...preliminary,
      providerRequest: Object.freeze({ ...preliminary.providerRequest, dispatch_boundary_padding: 'x'.repeat(65_537) }),
    }));
    const { result } = await run(
      'generation:google:gemini-3.7-flash:high',
      false,
      {},
      { anthropic: oversized },
    );
    const anthropicJudgments = result.judgments.filter((entry) => entry.judgeProvider === 'anthropic');
    expect(oversized.boundaryInvocations).toHaveLength(32);
    expect(oversized.requests).toHaveLength(0);
    expect(anthropicJudgments.every((entry) => entry.status === 'missing' && entry.dispatched === false)).toBe(true);
    expect(anthropicJudgments[0]?.providerRequestSha256).toBe(createHash('sha256').update(JSON.stringify(oversized.boundaryInvocations[0]!.providerRequest), 'utf8').digest('hex'));
  }, 30_000);

  it('keeps post-dispatch unknown exposure and every missing judge slot in denominator', async () => {
    const { budget, result } = await run('generation:anthropic:claude-haiku-4-5:provider_default', true);
    expect(budget.snapshot().exposureUnknown).toBe(true);
    expect(result.observations).toHaveLength(32);
    expect(result.judgments).toHaveLength(64);
    expect(result.judgments.every((judgment) => judgment.status === 'not_dispatched_budget')).toBe(true);
  }, 30_000);

  it('rejects an unbudgeted artifact entry point before any candidate dispatch', async () => {
    const cell = fixedTraceDirectFullSuiteCell('generation:anthropic:claude-haiku-4-5:provider_default');
    const candidate = new FakeProvider('anthropic');
    const judges = { anthropic: new FakeProvider('anthropic'), google: new FakeProvider('google'), openai: new FakeProvider('openai') };
    const config = fixedTraceDirectFullSuiteConfig({ runId: 'unbudgeted', sourceBundleSha256: HASH, gitCommit: 'abcdef0', provider: candidate, cellId: cell.id, promptConfigVersion: HASH });
    await expect(runFixedTraceDirectFullSuiteComparisonArtifact({ candidate: config, judgeProviders: judges, budget: new FixedTraceBudget(300) })).rejects.toThrow('authenticated shared budget wrapper');
    expect(candidate.requests).toHaveLength(0);
  });

  it('atomically rejects an undersized whole-cell cap before candidate dispatch', async () => {
    const cell = fixedTraceDirectFullSuiteCell('generation:google:gemini-3.7-flash:high');
    const candidate = new FakeProvider('google');
    const judges = { anthropic: new FakeProvider('anthropic'), google: new FakeProvider('google'), openai: new FakeProvider('openai') };
    const ceiling = fixedTraceDirectFullSuiteCostCeiling(cell.id);
    expect(ceiling.totalUsd).toBeGreaterThan(0);
    expect(() => assertFixedTraceDirectFullSuiteCostCeiling(cell.id, ceiling.totalUsd / 2)).toThrow('whole-cell ceiling');
    const config = fixedTraceDirectFullSuiteConfig({ runId: 'undersized', sourceBundleSha256: HASH, gitCommit: 'abcdef0', provider: budgeted(candidate, cell.model, new FixedTraceBudget(300)), cellId: cell.id, promptConfigVersion: HASH });
    await expect(runFixedTraceDirectFullSuiteComparisonArtifact({ candidate: config, judgeProviders: judges, budget: new FixedTraceBudget(0.000001) })).rejects.toThrow('whole-cell ceiling');
    expect(candidate.requests).toHaveLength(0);
  });

  it('uses exclusive 0600 selector, artifact, and checksum evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'addie-fixed-trace-'));
    const selector = join(directory, 'used'); const output = join(directory, 'artifact.json');
    consumeFixedTraceDirectFullSuiteSelector(selector, { cellId: FIXED_TRACE_DIRECT_FULL_SUITE_CELLS[0], sourceBundleSha256: HASH, promptConfigVersion: HASH });
    expect(() => consumeFixedTraceDirectFullSuiteSelector(selector, { cellId: FIXED_TRACE_DIRECT_FULL_SUITE_CELLS[0], sourceBundleSha256: HASH, promptConfigVersion: HASH })).toThrow('already consumed');
    const reservation = reserveFixedTraceDirectFullSuiteOutput(output); const digest = reservation.finalize({ safe: true });
    expect(readFileSync(`${output}.sha256`, 'utf8')).toContain(digest);
    expect(statSync(selector).mode & 0o777).toBe(0o600);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(statSync(`${output}.sha256`).mode & 0o777).toBe(0o600);
    expect(() => reserveFixedTraceDirectFullSuiteOutput(output)).toThrow('exclusively reserve');
  });
});
