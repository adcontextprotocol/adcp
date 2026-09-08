import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ModelProvider, ModelProviderId, ModelReasoningEffort } from '../model-providers/model-provider.js';
import {
  FixedTraceBudget,
  type FixedTraceBudgetDiagnosticLease,
  claimFixedTraceBudgetDiagnosticLease,
  fixedTraceDirectFullSuiteResponsePricingPolicy,
  isTrustedBudgetedFixedTraceProvider,
} from './fixed-trace-budget.js';
import { FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_PREPARED_REQUEST_BYTES, fixedTraceDirectFullSuiteJudgePlan, judgeFixedTraceDirectFullSuiteObservation, summarizeFixedTraceDirectFullSuiteJudgments, type FixedTraceDirectFullSuiteJudgment } from './fixed-trace-direct-full-suite-judge.js';
import { datedPricingProfileIdentity, datedPricingProfilesForFixedTrace, datedPricingReservationCostUsd, type DatedPricingProfile } from './dated-pricing-cohort.js';
import {
  FIXED_TRACE_DIRECT_FULL_SUITE_COMPARISON_MODE,
  FIXED_TRACE_DIRECT_FULL_SUITE_GENERATION_CELL_IDS,
  FIXED_TRACE_DIRECT_FULL_SUITE_MAX_PREPARED_REQUEST_BYTES,
  runFixedTraceDirectFullSuiteComparison,
  type FixedTraceDirectFullSuiteGenerationCellId,
  type FixedTraceProviderStageConfig,
  type FixedTraceRunnerConfig,
} from './fixed-trace-runner.js';
import { MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS } from './fixed-trace-tool-loop.js';
import { FIXED_TRACE_SUITE, FIXED_TRACE_SUITE_VERSION, fixedTraceSuiteSha256, summarizeFixedTraceRun } from './fixed-trace-suite.js';
import { canonicalFixedTraceToolDefinitions } from './fixed-trace-tools.js';

export const FIXED_TRACE_DIRECT_FULL_SUITE_CELLS = FIXED_TRACE_DIRECT_FULL_SUITE_GENERATION_CELL_IDS;
export type FixedTraceDirectFullSuiteCellId = FixedTraceDirectFullSuiteGenerationCellId;

export const FIXED_TRACE_DIRECT_FULL_SUITE_JUDGES = Object.freeze({
  anthropic: Object.freeze(['google', 'openai'] as const),
  google: Object.freeze(['anthropic', 'openai'] as const),
  openai: Object.freeze(['anthropic', 'google'] as const),
});

export const FIXED_TRACE_DIRECT_FULL_SUITE_MAX_GENERATION_DISPATCHES = FIXED_TRACE_SUITE.length * MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS;
export const FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_DISPATCHES = FIXED_TRACE_SUITE.length * 2;

const CELL = /^generation:(anthropic|google|openai):([^:]+):(provider_default|low|medium|high)$/;

/** Session-scoped Addie credentials take precedence without exposing them. */
export function fixedTraceDirectFullSuiteAnthropicApiKey(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  return environment.ADDIE_ANTHROPIC_API_KEY || environment.ANTHROPIC_API_KEY;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function fixedTraceDirectFullSuiteCell(cellId: string): {
  readonly id: FixedTraceDirectFullSuiteCellId;
  readonly provider: 'anthropic' | 'google' | 'openai';
  readonly model: 'claude-sonnet-5' | 'claude-haiku-4-5' | 'claude-opus-5' | 'gemini-3.7-flash' | 'gemini-3.8-flash' | 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';
  readonly effort: ModelReasoningEffort;
  readonly judgeProviders: readonly ModelProviderId[];
} {
  if (!(FIXED_TRACE_DIRECT_FULL_SUITE_CELLS as readonly string[]).includes(cellId)) {
    throw new Error('Fixed trace direct full-suite comparison cell is unsupported');
  }
  const match = CELL.exec(cellId);
  if (!match || !['anthropic', 'google', 'openai'].includes(match[1])) throw new Error('Fixed trace direct full-suite comparison cell is malformed');
  const provider = match[1] as 'anthropic' | 'google' | 'openai';
  const model = match[2];
  const effort = match[3] as ModelReasoningEffort;
  return Object.freeze({
    id: cellId as FixedTraceDirectFullSuiteCellId,
    provider,
    model: model as 'claude-sonnet-5' | 'claude-haiku-4-5' | 'claude-opus-5' | 'gemini-3.7-flash' | 'gemini-3.8-flash' | 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol',
    effort,
    judgeProviders: FIXED_TRACE_DIRECT_FULL_SUITE_JUDGES[provider],
  });
}

export function fixedTraceDirectFullSuiteStage(
  cellId: FixedTraceDirectFullSuiteCellId,
  provider: ModelProvider,
): FixedTraceProviderStageConfig {
  const cell = fixedTraceDirectFullSuiteCell(cellId);
  const pricing = datedPricingProfilesForFixedTrace().find((candidate) => (
    candidate.provider === cell.provider && candidate.model === cell.model
  ));
  if (!pricing || provider.id !== cell.provider) throw new Error('Fixed trace direct full-suite provider or pricing identity drift');
  fixedTraceDirectFullSuiteResponsePricingPolicy(cell.provider, cell.model, pricing);
  return Object.freeze({
    provider, model: cell.model, reasoningEffort: cell.effort, maxOutputTokens: 900,
    timeoutMs: 120_000, maxIterations: 12, transportRetries: 0,
    samplingMode: 'provider_no_sampling_control', temperature: null, pricing,
  });
}

/**
 * A whole-cell upper bound using the exact current pricing cohort. Every
 * candidate request is hard-bounded before provider dispatch, and every judge
 * packet has an independent bound, so all possible calls are admitted before
 * the one-shot selector or artifact names are consumed.
 */
export interface FixedTraceDirectFullSuiteCostComponent {
  readonly role: 'candidate' | 'judge';
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly reasoningEffort: ModelReasoningEffort;
  readonly dispatches: number;
  /** Admission deliberately treats every request byte as one input token. */
  readonly inputByteUpperBound: number;
  readonly inputTokenUpperBound: number;
  readonly maxOutputTokens: number;
  readonly pricingProfileId: string;
  readonly pricingProfileSha256: string;
  readonly pricingPolicy: Readonly<{
    expectedProvider: ModelProviderId;
    expectedModel: string;
    modelResolutionPolicy: string;
  }>;
  readonly reservationPerDispatchUsd: number;
  readonly reservationUsd: number;
  /** Exact additive/subset buckets used by the shared reservation function. */
  readonly pricingBuckets: readonly Readonly<{
    category: 'input' | 'output' | 'cache_read' | 'cache_write';
    accounting: 'additive' | 'subset' | 'not_applicable';
    tokens: number;
    usdPerMillionTokens: number;
    usd: number;
  }>[];
}

export interface FixedTraceDirectFullSuiteCostCeiling {
  readonly candidateMaxDispatches: number;
  readonly judgeMaxDispatches: number;
  readonly candidatePreparedRequestBytes: number;
  readonly judgePreparedRequestBytes: number;
  readonly candidatePricingProfileId: string;
  readonly judgePricingProfileIds: readonly string[];
  readonly candidateReservationUsd: number;
  readonly judgeReservationUsd: number;
  readonly totalUsd: number;
  /** Exact minimum soft cap accepted for the complete one-shot cell. */
  readonly requiredSoftMaxUsd: number;
  readonly components: readonly FixedTraceDirectFullSuiteCostComponent[];
}

function reservationComponent(input: Readonly<{
  role: 'candidate' | 'judge';
  provider: ModelProviderId;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  dispatches: number;
  inputByteUpperBound: number;
  maxOutputTokens: number;
  profile: DatedPricingProfile;
}>): FixedTraceDirectFullSuiteCostComponent {
  const policy = fixedTraceDirectFullSuiteResponsePricingPolicy(input.provider, input.model, input.profile);
  const tokens = input.inputByteUpperBound;
  const selectedSubset = [
    { category: 'input' as const, rate: input.profile.inputUsdPerMillionTokens },
    ...(input.profile.cacheReadAccounting === 'subset' && input.profile.cacheReadUsdPerMillionTokens !== null
      ? [{ category: 'cache_read' as const, rate: input.profile.cacheReadUsdPerMillionTokens }] : []),
    ...(input.profile.cacheWriteAccounting === 'subset' && input.profile.cacheWriteUsdPerMillionTokens !== null
      ? [{ category: 'cache_write' as const, rate: input.profile.cacheWriteUsdPerMillionTokens }] : []),
  ].reduce((highest, bucket) => bucket.rate > highest.rate ? bucket : highest);
  const pricingBuckets = [
    { category: selectedSubset.category, accounting: selectedSubset.category === 'input' ? 'not_applicable' as const : 'subset' as const, tokens, usdPerMillionTokens: selectedSubset.rate, usd: tokens * selectedSubset.rate / 1_000_000 },
    { category: 'output' as const, accounting: 'not_applicable' as const, tokens: input.maxOutputTokens, usdPerMillionTokens: input.profile.outputUsdPerMillionTokens, usd: input.maxOutputTokens * input.profile.outputUsdPerMillionTokens / 1_000_000 },
    ...(input.profile.cacheReadAccounting === 'additive' && input.profile.cacheReadUsdPerMillionTokens !== null
      ? [{ category: 'cache_read' as const, accounting: 'additive' as const, tokens, usdPerMillionTokens: input.profile.cacheReadUsdPerMillionTokens, usd: tokens * input.profile.cacheReadUsdPerMillionTokens / 1_000_000 }] : []),
    ...(input.profile.cacheWriteAccounting === 'additive' && input.profile.cacheWriteUsdPerMillionTokens !== null
      ? [{ category: 'cache_write' as const, accounting: 'additive' as const, tokens, usdPerMillionTokens: input.profile.cacheWriteUsdPerMillionTokens, usd: tokens * input.profile.cacheWriteUsdPerMillionTokens / 1_000_000 }] : []),
  ];
  const reservationPerDispatchUsd = datedPricingReservationCostUsd(input.profile, tokens, input.maxOutputTokens);
  const bucketTotal = pricingBuckets.reduce((total, bucket) => total + bucket.usd, 0);
  // Both values are derived from the same immutable decimal rates. Allow only
  // IEEE-754 summation noise; the exposed reservation remains the exact shared
  // pricing function result.
  if (Math.abs(bucketTotal - reservationPerDispatchUsd) > Number.EPSILON * Math.max(1, Math.abs(reservationPerDispatchUsd))) {
    throw new Error('Fixed trace direct full-suite reservation buckets do not reconcile');
  }
  return Object.freeze({
    role: input.role, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort,
    dispatches: input.dispatches, inputByteUpperBound: tokens, inputTokenUpperBound: tokens,
    maxOutputTokens: input.maxOutputTokens, pricingProfileId: input.profile.profileId,
    pricingProfileSha256: datedPricingProfileIdentity(input.profile).digest,
    pricingPolicy: Object.freeze({ expectedProvider: policy.expectedProvider, expectedModel: policy.expectedModel, modelResolutionPolicy: policy.modelResolutionPolicy }),
    reservationPerDispatchUsd, reservationUsd: input.dispatches * reservationPerDispatchUsd,
    pricingBuckets: Object.freeze(pricingBuckets.map((bucket) => Object.freeze(bucket))),
  });
}

export function fixedTraceDirectFullSuiteCostCeiling(cellId: FixedTraceDirectFullSuiteCellId): FixedTraceDirectFullSuiteCostCeiling {
  const cell = fixedTraceDirectFullSuiteCell(cellId);
  const profile = (provider: ModelProviderId, model: string) => {
    const result = datedPricingProfilesForFixedTrace().find((entry) => entry.provider === provider && entry.model === model);
    if (!result) throw new Error('Fixed trace direct full-suite ceiling pricing is unavailable');
    fixedTraceDirectFullSuiteResponsePricingPolicy(provider, model, result);
    return result;
  };
  const candidate = profile(cell.provider, cell.model);
  const judgeProfiles = cell.judgeProviders.map((provider) => profile(provider, provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'google' ? 'gemini-3.7-flash' : 'gpt-5.6-luna'));
  const components = Object.freeze([
    reservationComponent({ role: 'candidate', provider: cell.provider, model: cell.model, reasoningEffort: cell.effort, dispatches: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_GENERATION_DISPATCHES, inputByteUpperBound: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_PREPARED_REQUEST_BYTES, maxOutputTokens: 900, profile: candidate }),
    ...judgeProfiles.map((judge) => reservationComponent({ role: 'judge', provider: judge.provider, model: judge.model, reasoningEffort: 'provider_default', dispatches: FIXED_TRACE_SUITE.length, inputByteUpperBound: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_PREPARED_REQUEST_BYTES, maxOutputTokens: 300, profile: judge })),
  ]);
  const candidateReservationUsd = components[0]!.reservationUsd;
  const judgeReservationUsd = components.slice(1).reduce((total, component) => total + component.reservationUsd, 0);
  const totalUsd = candidateReservationUsd + judgeReservationUsd;
  return Object.freeze({
    candidateMaxDispatches: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_GENERATION_DISPATCHES,
    judgeMaxDispatches: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_DISPATCHES,
    candidatePreparedRequestBytes: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_PREPARED_REQUEST_BYTES,
    judgePreparedRequestBytes: FIXED_TRACE_DIRECT_FULL_SUITE_MAX_JUDGE_PREPARED_REQUEST_BYTES,
    candidatePricingProfileId: candidate.profileId,
    judgePricingProfileIds: Object.freeze(judgeProfiles.map((judge) => judge.profileId)),
    candidateReservationUsd,
    judgeReservationUsd,
    totalUsd,
    requiredSoftMaxUsd: totalUsd,
    components,
  });
}

/** Atomically admit every bounded dispatch before any durable side effect. */
export function assertFixedTraceDirectFullSuiteCostCeiling(
  cellId: FixedTraceDirectFullSuiteCellId,
  softMaxUsd: number,
) {
  const ceiling = fixedTraceDirectFullSuiteCostCeiling(cellId);
  if (!Number.isFinite(softMaxUsd) || softMaxUsd < ceiling.totalUsd) {
    throw new RangeError(`Fixed trace direct full-suite soft budget is below the required whole-cell ceiling (${ceiling.totalUsd})`);
  }
  return ceiling;
}

function freezePlan<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freezePlan(nested);
  return Object.freeze(value);
}

/**
 * The durable plan is constructed from evaluator-owned controls only. Its
 * judge slots make provider_default explicit and bind prompt, configuration,
 * pricing policy, and the exact whole-cell reservation before execution.
 */
export function fixedTraceDirectFullSuitePlan(input: Readonly<{
  cellId: FixedTraceDirectFullSuiteCellId;
  sourceFiles: readonly string[];
  sourceBundleSha256: string;
  promptConfigVersion: string;
  softMaxUsd: number;
}>) {
  const cell = fixedTraceDirectFullSuiteCell(input.cellId);
  const ceiling = fixedTraceDirectFullSuiteCostCeiling(cell.id);
  const candidate = ceiling.components[0]!;
  return freezePlan({
    mode: FIXED_TRACE_DIRECT_FULL_SUITE_COMPARISON_MODE,
    cell: cell.id,
    candidate: {
      provider: cell.provider, model: cell.model, reasoningEffort: cell.effort,
      pricingProfileId: candidate.pricingProfileId, pricingProfileSha256: candidate.pricingProfileSha256,
      pricingPolicy: candidate.pricingPolicy,
    },
    requiredJudgeProviders: [...cell.judgeProviders],
    judges: cell.judgeProviders.map((provider) => fixedTraceDirectFullSuiteJudgePlan(provider)),
    traceSuiteVersion: FIXED_TRACE_SUITE_VERSION,
    traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_SUITE),
    traceCount: FIXED_TRACE_SUITE.length,
    generation: { maxOutputTokens: 900, timeoutMs: 120_000, maxIterations: MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS, transportRetries: 0 },
    sourceFiles: [...input.sourceFiles], sourceBundleSha256: input.sourceBundleSha256,
    promptConfigVersion: input.promptConfigVersion, softMaxUsd: input.softMaxUsd,
    wholeCellCostCeiling: ceiling,
  });
}

/** Build exactly one direct-only full-suite candidate; no admission is consulted. */
export function fixedTraceDirectFullSuiteConfig(input: Readonly<{
  runId: string;
  sourceBundleSha256: string;
  gitCommit: string;
  provider: ModelProvider;
  cellId: FixedTraceDirectFullSuiteCellId;
  promptConfigVersion: string;
}>): FixedTraceRunnerConfig {
  return Object.freeze({
    runId: input.runId,
    sourceBundleSha256: input.sourceBundleSha256,
    gitCommit: input.gitCommit,
    gitDirty: false,
    promptConfigVersion: input.promptConfigVersion,
    traceSuite: FIXED_TRACE_SUITE,
    traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_SUITE),
    toolDefinitions: canonicalFixedTraceToolDefinitions(FIXED_TRACE_SUITE),
    toolDefinitionProvenance: 'fixture_local',
    architectureArm: 'direct_generation',
    router: null,
    generation: fixedTraceDirectFullSuiteStage(input.cellId, input.provider),
    directFullSuiteComparison: {
      mode: FIXED_TRACE_DIRECT_FULL_SUITE_COMPARISON_MODE,
      generationCellId: input.cellId,
    },
  });
}

export function fixedTraceDirectFullSuiteSourceBundle(files: readonly string[]): {
  readonly files: readonly string[];
  readonly sha256: string;
} {
  const ordered = [...new Set(files)].sort();
  if (ordered.length === 0 || ordered.some((file) => !file || file.startsWith('/') || file.includes('..'))) {
    throw new Error('Fixed trace direct full-suite source bundle is invalid');
  }
  const hash = createHash('sha256');
  for (const file of ordered) hash.update(file, 'utf8').update('\0').update(readFileSync(file)).update('\0');
  return Object.freeze({ files: Object.freeze(ordered), sha256: hash.digest('hex') });
}

/** Durable one-use selector. It is created before a provider object is accepted. */
export function consumeFixedTraceDirectFullSuiteSelector(path: string, input: Readonly<{
  cellId: FixedTraceDirectFullSuiteCellId;
  sourceBundleSha256: string;
  promptConfigVersion: string;
}>): void {
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) { throw new Error(`Fixed trace direct full-suite selector was already consumed: ${error instanceof Error ? error.message : String(error)}`); }
  try { writeFileSync(descriptor, `${JSON.stringify({ mode: FIXED_TRACE_DIRECT_FULL_SUITE_COMPARISON_MODE, cellId: input.cellId, traceSuiteSha256: fixedTraceSuiteSha256(FIXED_TRACE_SUITE), sourceBundleSha256: input.sourceBundleSha256, promptConfigVersion: input.promptConfigVersion })}\n`, 'utf8'); }
  finally { closeSync(descriptor); }
}

export interface FixedTraceDirectFullSuiteOutputReservation {
  finalize(artifact: unknown): string;
}

/** Reserve both output identities before dispatch; no existing evidence can be overwritten. */
export function reserveFixedTraceDirectFullSuiteOutput(path: string): FixedTraceDirectFullSuiteOutputReservation {
  const output = resolve(path);
  const checksum = `${output}.sha256`;
  let artifactDescriptor: number;
  let checksumDescriptor: number;
  try {
    artifactDescriptor = openSync(output, 'wx', 0o600);
    try { checksumDescriptor = openSync(checksum, 'wx', 0o600); }
    catch (error) { closeSync(artifactDescriptor); throw error; }
  } catch (error) {
    throw new Error(`Cannot exclusively reserve fixed-trace direct full-suite output: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finalized = false;
  return Object.freeze({
    finalize(artifact: unknown): string {
      if (finalized) throw new Error('Fixed trace direct full-suite output is already finalized');
      const content = `${JSON.stringify(artifact, null, 2)}\n`;
      const digest = sha256(content);
      try {
        writeFileSync(artifactDescriptor!, content, 'utf8');
        writeFileSync(checksumDescriptor!, `${digest}  ${output}\n`, 'utf8');
        finalized = true;
        return digest;
      } finally { closeSync(artifactDescriptor!); closeSync(checksumDescriptor!); }
    },
  });
}

export async function runFixedTraceDirectFullSuiteCandidate(config: FixedTraceRunnerConfig) {
  const observations = await runFixedTraceDirectFullSuiteComparison(config);
  return Object.freeze({ observations: Object.freeze(observations), ...summarizeFixedTraceRun(observations, FIXED_TRACE_SUITE) });
}

export interface FixedTraceDirectFullSuiteAdmission {
  readonly candidate: FixedTraceRunnerConfig;
  readonly judges: Readonly<Record<ModelProviderId, ModelProvider>>;
  release(): void;
}

const directFullSuiteAdmissions = new WeakMap<FixedTraceDirectFullSuiteAdmission, Readonly<{
  budget: FixedTraceBudget;
  cellId: FixedTraceDirectFullSuiteCellId;
}>>();

/**
 * Authenticates all wrappers and escrows the exact whole-cell ceiling before
 * the CLI consumes either of its one-shot filesystem identities.
 */
export function admitFixedTraceDirectFullSuiteComparison(input: Readonly<{
  candidate: FixedTraceRunnerConfig;
  judgeProviders: Readonly<Record<ModelProviderId, ModelProvider>>;
  budget: FixedTraceBudget;
}>): FixedTraceDirectFullSuiteAdmission {
  const cellId = input.candidate.directFullSuiteComparison?.generationCellId;
  if (!cellId) throw new Error('Fixed trace direct full-suite comparison candidate mode is required');
  const cell = fixedTraceDirectFullSuiteCell(cellId);
  const ceiling = assertFixedTraceDirectFullSuiteCostCeiling(cellId, input.budget.softMaxUsd);
  if (cell.judgeProviders.includes(cell.provider)) throw new Error('Fixed trace direct full-suite comparison cannot self-judge');
  if (
    input.candidate.generation.provider.id !== cell.provider
    || input.candidate.generation.model !== cell.model
    || input.candidate.generation.reasoningEffort !== cell.effort
    || input.candidate.generation.maxOutputTokens !== 900
    || input.candidate.generation.maxIterations !== MAX_FIXED_TRACE_TOOL_LOOP_ITERATIONS
  ) throw new Error('Fixed trace direct full-suite candidate controls drift from the admitted cell');
  const candidatePricingPolicy = fixedTraceDirectFullSuiteResponsePricingPolicy(
    input.candidate.generation.provider.id,
    input.candidate.generation.model,
    input.candidate.generation.pricing,
  );
  if (!isTrustedBudgetedFixedTraceProvider(
    input.candidate.generation.provider,
    input.budget,
    input.candidate.generation.pricing,
    candidatePricingPolicy,
  )) throw new Error('Fixed trace direct full-suite candidate requires an authenticated shared budget wrapper');
  const stages = new Map<ModelProviderId, FixedTraceProviderStageConfig>();
  for (const judgeProvider of cell.judgeProviders) {
    const provider = input.judgeProviders[judgeProvider];
    const judgePlan = fixedTraceDirectFullSuiteJudgePlan(judgeProvider);
    if (!provider || provider.id !== judgeProvider) throw new Error('Fixed trace direct full-suite judge provider identity drift');
    const pricing = datedPricingProfilesForFixedTrace().find((entry) => entry.provider === judgeProvider && entry.model === judgePlan.model);
    if (!pricing) throw new Error('Fixed trace direct full-suite judge pricing is unavailable');
    const policy = fixedTraceDirectFullSuiteResponsePricingPolicy(judgeProvider, judgePlan.model, pricing);
    if (!isTrustedBudgetedFixedTraceProvider(provider, input.budget, pricing, policy)) {
      throw new Error('Fixed trace direct full-suite judge requires an authenticated shared budget wrapper');
    }
    stages.set(judgeProvider, Object.freeze({
      provider, model: judgePlan.model, reasoningEffort: judgePlan.reasoningEffort,
      maxOutputTokens: judgePlan.maxOutputTokens, timeoutMs: judgePlan.timeoutMs,
      maxIterations: judgePlan.maxIterations, transportRetries: judgePlan.transportRetries,
      samplingMode: judgePlan.samplingMode, temperature: judgePlan.temperature, pricing,
    }));
  }
  const lease: FixedTraceBudgetDiagnosticLease = claimFixedTraceBudgetDiagnosticLease(
    input.budget,
    [input.candidate.generation.provider, ...cell.judgeProviders.map((id) => input.judgeProviders[id]!)],
    undefined,
    ceiling.requiredSoftMaxUsd,
  );
  const candidate = Object.freeze({
    ...input.candidate,
    generation: Object.freeze({ ...input.candidate.generation, provider: lease.providerFor(input.candidate.generation.provider) }),
  });
  const judges: Readonly<Record<ModelProviderId, ModelProvider>> = Object.freeze({
    anthropic: cell.judgeProviders.includes('anthropic') ? lease.providerFor(stages.get('anthropic')!.provider) : input.judgeProviders.anthropic,
    google: cell.judgeProviders.includes('google') ? lease.providerFor(stages.get('google')!.provider) : input.judgeProviders.google,
    openai: cell.judgeProviders.includes('openai') ? lease.providerFor(stages.get('openai')!.provider) : input.judgeProviders.openai,
  });
  const admission: FixedTraceDirectFullSuiteAdmission = Object.freeze({
    candidate, judges, release: () => lease.releaseWholeRunReservation(),
  });
  directFullSuiteAdmissions.set(admission, Object.freeze({ budget: input.budget, cellId }));
  return admission;
}

/** Candidate and judges share a budgeted provider boundary but retain distinct, blinded calls. */
export async function runFixedTraceDirectFullSuiteComparisonArtifact(input: Readonly<{
  candidate: FixedTraceRunnerConfig;
  judgeProviders: Readonly<Record<ModelProviderId, ModelProvider>>;
  budget: FixedTraceBudget;
  admission?: FixedTraceDirectFullSuiteAdmission;
}>): Promise<Readonly<{
  observations: readonly Awaited<ReturnType<typeof runFixedTraceDirectFullSuiteComparison>>[number][];
  grades: ReturnType<typeof summarizeFixedTraceRun>['grades'];
  summary: ReturnType<typeof summarizeFixedTraceRun>['summary'];
  judgments: readonly FixedTraceDirectFullSuiteJudgment[];
  judgeSummary: ReturnType<typeof summarizeFixedTraceDirectFullSuiteJudgments>;
}>> {
  const admission = input.admission ?? admitFixedTraceDirectFullSuiteComparison(input);
  const binding = directFullSuiteAdmissions.get(admission);
  if (!binding || binding.budget !== input.budget) throw new Error('Fixed trace direct full-suite admission is unauthenticated');
  const cell = fixedTraceDirectFullSuiteCell(binding.cellId);
  try {
    const observations = await runFixedTraceDirectFullSuiteComparison(admission.candidate);
    if (observations.length !== FIXED_TRACE_SUITE.length) throw new Error('Fixed trace direct full-suite comparison omitted a candidate denominator');
    const byTraceId = new Map(observations.map((observation) => [observation.traceId, observation]));
    const judgments: FixedTraceDirectFullSuiteJudgment[] = [];
    for (const trace of FIXED_TRACE_SUITE) {
      const observation = byTraceId.get(trace.id);
      if (!observation) throw new Error('Fixed trace direct full-suite comparison omitted a trace observation');
      judgments.push(...await judgeFixedTraceDirectFullSuiteObservation({
        trace, observation, judges: admission.judges, requiredJudgeProviders: cell.judgeProviders,
      }));
    }
    const summarized = summarizeFixedTraceRun(observations, FIXED_TRACE_SUITE);
    if (judgments.length !== FIXED_TRACE_SUITE.length * 2) throw new Error('Fixed trace direct full-suite comparison omitted a judge denominator');
    return Object.freeze({ observations: Object.freeze(observations), ...summarized, judgments: Object.freeze(judgments), judgeSummary: summarizeFixedTraceDirectFullSuiteJudgments(judgments, FIXED_TRACE_SUITE.length) });
  } finally {
    admission.release();
  }
}

export function fixedTraceDirectFullSuiteGitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
