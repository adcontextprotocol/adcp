import { createHash } from 'node:crypto';
import type { ModelProviderId, ModelReasoningEffort } from '../model-providers/model-provider.js';
import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
  OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS,
  OPENAI_GPT_5_6_PRICING_VERSION,
} from '../model-cost-pricing.js';
import { CLAUDE_PRICING_VERSION } from '../claude-pricing.js';
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  FIXED_TRACE_PARTITION_MANIFEST_VERSION,
  assertFixedTracePartitionManifest,
} from './fixed-trace-partition.js';

/** A versioned, network-free admission contract for fixed-trace experiments. */
export const FIXED_TRACE_EXPERIMENT_PLAN_VERSION = 'addie-fixed-trace-experiment-plan-v1' as const;
export const FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION =
  'addie-fixed-trace-holdout-finalization-v1' as const;
export const FIXED_TRACE_RAW_LEDGER_VERSION = 'addie-fixed-trace-raw-ledger-v1' as const;
export const FIXED_TRACE_HOLDOUT_LIMITATION =
  'execution_locked_repository_visible_not_secret_holdout' as const;

export type FixedTraceExperimentArchitecture =
  | 'two_stage_llm_router'
  | 'direct_generation'
  | 'hybrid_generation'
  | 'oracle_route_diagnostic';
export type FixedTraceScreeningStage =
  | 'router_only_screen'
  | 'oracle_route_generator_diagnostic'
  | 'deployable_finalist';

export interface FixedTraceImmutablePricingProfile {
  provider: ModelProviderId;
  model: string;
  version: string;
  validBefore: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  source: string;
}

/**
 * Profiles are deliberately a closed list. A missing provider/model/version is
 * unavailable, rather than inheriting a sibling model's price.
 */
export const FIXED_TRACE_IMMUTABLE_PRICING = Object.freeze([
  Object.freeze({
    provider: 'anthropic', model: 'claude-haiku-4-5', version: CLAUDE_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5,
    source: 'Repository Anthropic standard pricing table, refreshed August 2026.',
  }),
  Object.freeze({
    provider: 'anthropic', model: 'claude-sonnet-5', version: CLAUDE_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z', inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15,
    source: 'Repository Anthropic standard pricing table, refreshed August 2026.',
  }),
  Object.freeze({
    provider: 'openai', model: 'gpt-5.6-luna', version: OPENAI_GPT_5_6_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z', inputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS['gpt-5.6-luna'].inputUsd,
    outputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS['gpt-5.6-luna'].outputUsd,
    source: 'Repository immutable OpenAI standard pricing pin, reviewed 2026-09-05.',
  }),
  Object.freeze({
    provider: 'openai', model: 'gpt-5.6-terra', version: OPENAI_GPT_5_6_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z', inputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS['gpt-5.6-terra'].inputUsd,
    outputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS['gpt-5.6-terra'].outputUsd,
    source: 'Repository immutable OpenAI standard pricing pin, reviewed 2026-09-05.',
  }),
  Object.freeze({
    provider: 'openai', model: 'gpt-5.6-sol', version: OPENAI_GPT_5_6_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z', inputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS['gpt-5.6-sol'].inputUsd,
    outputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS['gpt-5.6-sol'].outputUsd,
    source: 'Repository immutable OpenAI standard pricing pin, reviewed 2026-09-05.',
  }),
  Object.freeze({
    provider: 'google', model: 'gemini-3.7-flash', version: GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
    validBefore: '2027-01-01T00:00:00.000Z', inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 3.75,
    source: 'Repository Google Gemini 3.7 Flash pricing pin through 2026-12-31.',
  }),
] satisfies readonly FixedTraceImmutablePricingProfile[]);

export interface FixedTraceRequestBounds {
  /** One exact UTF-8 request byte count for every possible request in the loop. */
  inputBytesByTrace: Readonly<Record<string, readonly number[]>>;
}

export interface FixedTracePlannedStage {
  provider: ModelProviderId;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  pricingVersion: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxIterations: number;
  samplingMode: 'temperature_zero' | 'provider_no_sampling_control';
  temperature: 0 | null;
  requestBounds: FixedTraceRequestBounds;
}

export interface FixedTracePlannedJudge extends FixedTracePlannedStage {
  blinded: true;
}

export interface FixedTraceExperimentArm {
  id: string;
  architecture: FixedTraceExperimentArchitecture;
  screeningStage: FixedTraceScreeningStage;
  repetitionIndex: number;
  router?: FixedTracePlannedStage;
  generation?: FixedTracePlannedStage;
  judges?: readonly FixedTracePlannedJudge[];
}

export interface FixedTraceExperimentPlan {
  version: typeof FIXED_TRACE_EXPERIMENT_PLAN_VERSION;
  id: string;
  /** Resolved outside the candidate-controlled plan before it is admissible. */
  trustedManifestId: string;
  sourceId: string;
  sourceRevision: string;
  pricingAsOf: string;
  sourceBundleSha256: string;
  traceSuiteSha256: string;
  promptConfigVersion: string;
  toolSchemaSha256: string;
  partition: {
    manifestVersion: typeof FIXED_TRACE_PARTITION_MANIFEST_VERSION;
    manifestSha256: typeof FIXED_TRACE_PARTITION_MANIFEST_SHA256;
    selected: 'development' | 'holdout';
    /** Holdout is legal only for a separately versioned, explicit finalization. */
    finalizationGate?: { version: typeof FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION; recordId: string };
  };
  ordering: { seed: string };
  budgets: { candidateCeilingUsd: number; judgeCeilingUsd: number };
  arms: readonly FixedTraceExperimentArm[];
}

/**
 * The resolver is deliberately external to the plan file. A plan cannot make
 * itself trusted by repeating its own hashes. The future dispatcher must use
 * an attested/controlled resolver, never deserialize this alongside a plan.
 */
export interface FixedTraceTrustedManifest {
  id: string;
  sourceId: string;
  sourceRevision: string;
  sourceBundleSha256: string;
  traceSuiteSha256: string;
  promptConfigVersion: string;
  toolSchemaSha256: string;
  partitionManifestSha256: string;
  rawLedgerVersion: typeof FIXED_TRACE_RAW_LEDGER_VERSION;
}

export type FixedTraceTrustedManifestResolver = (id: string) => FixedTraceTrustedManifest | null;

/**
 * Finalization state belongs to a controlled store, not the candidate plan.
 * `consume` is intentionally separate from inspection: dry runs never spend
 * the one-time holdout authorization.
 */
export interface FixedTraceHoldoutFinalizationRecord {
  id: string;
  version: typeof FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION;
  trustedManifestId: string;
  frozenCandidatePlanFingerprint: string;
  consumed: boolean;
  tracePackVisibility: 'repository_visible' | 'externally_sealed';
}
export type FixedTraceHoldoutFinalizationResolver = (id: string) => FixedTraceHoldoutFinalizationRecord | null;
export type FixedTraceHoldoutFinalizationConsumer = (id: string, frozenCandidatePlanFingerprint: string) => boolean;

export interface FixedTraceRawLedgerEntry {
  sequence: number;
  armId: string;
  repetitionIndex: number;
  traceId: string;
  stage: 'router' | 'generation' | 'judge';
  dispatched: boolean;
  requestedProvider: ModelProviderId | null;
  requestedModel: string | null;
  returnedProvider: ModelProviderId | null;
  returnedModel: string | null;
  promptSha256: string;
  providerRequestSha256: string | null;
  responseSha256: string | null;
  /** Content-addressed immutable raw artifacts; their bytes stay outside summaries. */
  rawRequestArtifact: { sha256: string; byteLength: number; storageKey: string } | null;
  rawResponseArtifact: { sha256: string; byteLength: number; storageKey: string } | null;
  exactToolNames: readonly string[];
  caseControlSha256: string;
  executionEnvelopeSha256: string;
  directAdmissionSha256: string;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
  maxIterations: number | null;
  reasoningEffort: ModelReasoningEffort;
  samplingMode: 'temperature_zero' | 'provider_no_sampling_control' | null;
}

export interface FixedTraceRawAuditableLedger {
  version: typeof FIXED_TRACE_RAW_LEDGER_VERSION;
  trustedManifestSha256: string;
  planFingerprint: string;
  entries: readonly FixedTraceRawLedgerEntry[];
}
export type FixedTraceRawArtifactResolver = (storageKey: string) => { sha256: string; byteLength: number } | null;

export interface FixedTraceStageReservation {
  armId: string;
  repetitionIndex: number;
  stage: 'router' | 'generation' | 'judge';
  provider: ModelProviderId;
  model: string;
  requests: number;
  inputBytes: number;
  outputTokens: number;
  ceilingUsd: number;
}

export interface FixedTraceDryRunEstimate {
  planFingerprint: string;
  executionOrder: readonly string[];
  candidate: { ceilingUsd: number; expectedSpendUsd: null; reservations: readonly FixedTraceStageReservation[] };
  judges: { ceilingUsd: number; expectedSpendUsd: null; reservations: readonly FixedTraceStageReservation[] };
  totalCeilingUsd: number;
  /** No traffic or provider calls occur; expected spend needs observed usage. */
  expectedSpendUsd: null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot fingerprint a non-finite experiment-plan value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Cannot fingerprint a non-JSON experiment-plan value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function requireHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function selectedTraceIds(plan: FixedTraceExperimentPlan): readonly string[] {
  return FIXED_TRACE_PARTITION_MANIFEST[plan.partition.selected];
}

function pricingFor(stage: FixedTracePlannedStage, pricingAsOf: string): FixedTraceImmutablePricingProfile {
  const asOf = new Date(pricingAsOf);
  if (Number.isNaN(asOf.getTime())) throw new Error('pricingAsOf must be an ISO timestamp');
  const pricing = FIXED_TRACE_IMMUTABLE_PRICING.find((candidate) =>
    candidate.provider === stage.provider && candidate.model === stage.model && candidate.version === stage.pricingVersion,
  );
  if (!pricing) throw new Error(`Unavailable immutable pricing for ${stage.provider}/${stage.model}`);
  if (asOf >= new Date(pricing.validBefore)) {
    throw new Error(`Stale immutable pricing for ${stage.provider}/${stage.model}`);
  }
  return pricing;
}

function validateStage(
  stage: FixedTracePlannedStage,
  label: string,
  traceIds: readonly string[],
  pricingAsOf: string,
): FixedTraceImmutablePricingProfile {
  if (!stage.model.trim()) throw new Error(`${label}.model is required`);
  requirePositiveInteger(stage.maxOutputTokens, `${label}.maxOutputTokens`);
  requirePositiveInteger(stage.timeoutMs, `${label}.timeoutMs`);
  requirePositiveInteger(stage.maxIterations, `${label}.maxIterations`);
  if (
    (stage.samplingMode === 'temperature_zero' && stage.temperature !== 0)
    || (stage.samplingMode === 'provider_no_sampling_control' && stage.temperature !== null)
  ) throw new Error(`${label} sampling controls are inconsistent`);
  const pricing = pricingFor(stage, pricingAsOf);
  const bounds = stage.requestBounds?.inputBytesByTrace;
  if (!bounds || typeof bounds !== 'object') throw new Error(`${label}.requestBounds are required`);
  for (const traceId of traceIds) {
    const values = bounds[traceId];
    if (!Array.isArray(values) || values.length !== stage.maxIterations) {
      throw new Error(`${label}.requestBounds must contain ${stage.maxIterations} exact bounds for ${traceId}`);
    }
    for (const bytes of values) requirePositiveInteger(bytes, `${label}.requestBounds.${traceId}`);
  }
  if (Object.keys(bounds).some((traceId) => !traceIds.includes(traceId))) {
    throw new Error(`${label}.requestBounds contains a trace outside the selected partition`);
  }
  return pricing;
}

function validateArm(plan: FixedTraceExperimentPlan, arm: FixedTraceExperimentArm): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(arm.id)) throw new Error(`Invalid experiment arm ID: ${arm.id}`);
  requirePositiveInteger(arm.repetitionIndex, `${arm.id}.repetitionIndex`);
  const traces = selectedTraceIds(plan);
  const stages = arm.screeningStage;
  if (stages === 'router_only_screen') {
    if (arm.architecture !== 'two_stage_llm_router' || !arm.router || arm.generation || (arm.judges?.length ?? 0) !== 0) {
      throw new Error(`${arm.id} is not a router-only screening contract`);
    }
    validateStage(arm.router, `${arm.id}.router`, traces, plan.pricingAsOf);
    return;
  }
  if (stages === 'oracle_route_generator_diagnostic') {
    if (arm.architecture !== 'oracle_route_diagnostic' || arm.router || !arm.generation || (arm.judges?.length ?? 0) !== 0) {
      throw new Error(`${arm.id} is not an oracle-route diagnostic contract`);
    }
    validateStage(arm.generation, `${arm.id}.generation`, traces, plan.pricingAsOf);
    return;
  }
  if (arm.architecture !== 'two_stage_llm_router' || !arm.router || !arm.generation) {
    throw new Error(`${arm.id} is inadmissible: direct and hybrid execution contracts are not available`);
  }
  validateStage(arm.router, `${arm.id}.router`, traces, plan.pricingAsOf);
  validateStage(arm.generation, `${arm.id}.generation`, traces, plan.pricingAsOf);
  if (!arm.judges || arm.judges.length < 2) throw new Error(`${arm.id} requires at least two blinded independent judges`);
  const candidateProviders = new Set([arm.router.provider, arm.generation.provider]);
  const judgeProviders = new Set<ModelProviderId>();
  for (const [index, judge] of arm.judges.entries()) {
    if (judge.blinded !== true) throw new Error(`${arm.id}.judges.${index} must be blinded`);
    if (candidateProviders.has(judge.provider)) throw new Error(`${arm.id}.judges.${index} is not provider-independent`);
    judgeProviders.add(judge.provider);
    validateStage(judge, `${arm.id}.judges.${index}`, traces, plan.pricingAsOf);
  }
  if (judgeProviders.size < 2) throw new Error(`${arm.id} requires two provider-independent judges`);
}

/** Validates without loading trace fixtures, prompts, credentials, or providers. */
function resolveTrustedManifest(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceTrustedManifestResolver,
): FixedTraceTrustedManifest {
  const manifest = resolver(plan.trustedManifestId);
  if (!manifest) throw new Error(`Trusted fixed-trace manifest is unavailable: ${plan.trustedManifestId}`);
  requireHash(manifest.sourceBundleSha256, 'trusted manifest sourceBundleSha256');
  requireHash(manifest.traceSuiteSha256, 'trusted manifest traceSuiteSha256');
  requireHash(manifest.promptConfigVersion, 'trusted manifest promptConfigVersion');
  requireHash(manifest.toolSchemaSha256, 'trusted manifest toolSchemaSha256');
  if (manifest.rawLedgerVersion !== FIXED_TRACE_RAW_LEDGER_VERSION) throw new Error('Trusted manifest requires an unsupported raw ledger');
  if (
    manifest.id !== plan.trustedManifestId
    || manifest.sourceId !== plan.sourceId
    || manifest.sourceRevision !== plan.sourceRevision
    || manifest.sourceBundleSha256 !== plan.sourceBundleSha256
    || manifest.traceSuiteSha256 !== plan.traceSuiteSha256
    || manifest.promptConfigVersion !== plan.promptConfigVersion
    || manifest.toolSchemaSha256 !== plan.toolSchemaSha256
    || manifest.partitionManifestSha256 !== FIXED_TRACE_PARTITION_MANIFEST_SHA256
  ) throw new Error('Experiment plan does not match its trusted manifest');
  return manifest;
}

/** Omits only execution partition/finalization state so an approved candidate cannot drift at unlock. */
export function fixedTraceCandidatePlanFingerprint(plan: FixedTraceExperimentPlan): string {
  const { partition, ...candidatePlan } = plan;
  return sha256({
    ...candidatePlan,
    partition: {
      manifestVersion: partition.manifestVersion,
      manifestSha256: partition.manifestSha256,
    },
  });
}

function assertHoldoutFinalization(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceHoldoutFinalizationResolver | undefined,
): void {
  if (plan.partition.selected !== 'holdout') return;
  const gate = plan.partition.finalizationGate;
  if (!gate || gate.version !== FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION) {
    throw new Error('Holdout is locked; an explicit versioned finalization gate is required');
  }
  if (!resolver) throw new Error('Holdout is locked; an externally resolved finalization record is required');
  const record = resolver(gate.recordId);
  if (!record) throw new Error(`Holdout finalization record is unavailable: ${gate.recordId}`);
  if (
    record.version !== FIXED_TRACE_HOLDOUT_FINALIZATION_GATE_VERSION
    || record.trustedManifestId !== plan.trustedManifestId
    || record.frozenCandidatePlanFingerprint !== fixedTraceCandidatePlanFingerprint(plan)
  ) throw new Error('Holdout finalization record does not match the frozen candidate plan');
  if (record.consumed) throw new Error('Holdout finalization record has already been consumed');
}

export function assertFixedTraceExperimentPlan(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceTrustedManifestResolver,
  holdoutFinalizationResolver?: FixedTraceHoldoutFinalizationResolver,
): void {
  assertFixedTracePartitionManifest();
  if (plan.version !== FIXED_TRACE_EXPERIMENT_PLAN_VERSION) throw new Error('Unsupported fixed-trace experiment plan version');
  if (!plan.id.trim()) throw new Error('Experiment plan ID is required');
  if (!plan.trustedManifestId.trim() || !plan.sourceId.trim() || !plan.sourceRevision.trim()) throw new Error('Experiment plan requires a trusted source identity');
  requireHash(plan.sourceBundleSha256, 'sourceBundleSha256');
  requireHash(plan.traceSuiteSha256, 'traceSuiteSha256');
  requireHash(plan.promptConfigVersion, 'promptConfigVersion');
  requireHash(plan.toolSchemaSha256, 'toolSchemaSha256');
  if (plan.partition.manifestVersion !== FIXED_TRACE_PARTITION_MANIFEST_VERSION || plan.partition.manifestSha256 !== FIXED_TRACE_PARTITION_MANIFEST_SHA256) {
    throw new Error('Experiment plan uses an uncommitted fixed-trace partition manifest');
  }
  if (plan.partition.selected === 'holdout') {
    assertHoldoutFinalization(plan, holdoutFinalizationResolver);
  } else if (plan.partition.finalizationGate) {
    throw new Error('Development execution must not carry a holdout finalization gate');
  }
  if (!plan.ordering.seed.trim()) throw new Error('Experiment ordering seed is required');
  if (!Number.isFinite(plan.budgets.candidateCeilingUsd) || plan.budgets.candidateCeilingUsd <= 0) throw new Error('candidateCeilingUsd must be positive');
  if (!Number.isFinite(plan.budgets.judgeCeilingUsd) || plan.budgets.judgeCeilingUsd <= 0) throw new Error('judgeCeilingUsd must be positive');
  if (!Array.isArray(plan.arms) || plan.arms.length === 0) throw new Error('Experiment plan requires at least one arm');
  const ids = new Set<string>();
  for (const arm of plan.arms) {
    if (ids.has(arm.id)) throw new Error(`Duplicate experiment arm ID: ${arm.id}`);
    ids.add(arm.id);
    validateArm(plan, arm);
  }
  resolveTrustedManifest(plan, resolver);
}

export function fixedTraceExperimentPlanFingerprint(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver, holdoutFinalizationResolver?: FixedTraceHoldoutFinalizationResolver): string {
  assertFixedTraceExperimentPlan(plan, resolver, holdoutFinalizationResolver);
  return sha256(plan);
}

/** Deterministic permutation based on a recorded seed, never provider input order. */
export function fixedTraceExperimentExecutionOrder(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver, holdoutFinalizationResolver?: FixedTraceHoldoutFinalizationResolver): readonly string[] {
  assertFixedTraceExperimentPlan(plan, resolver, holdoutFinalizationResolver);
  return Object.freeze([...plan.arms]
    .sort((left, right) => sha256({ seed: plan.ordering.seed, arm: left.id, repetition: left.repetitionIndex })
      .localeCompare(sha256({ seed: plan.ordering.seed, arm: right.id, repetition: right.repetitionIndex })) || left.id.localeCompare(right.id))
    .map((arm) => arm.id));
}

function reservation(
  arm: FixedTraceExperimentArm,
  stageName: FixedTraceStageReservation['stage'],
  stage: FixedTracePlannedStage,
  traceIds: readonly string[],
  pricingAsOf: string,
): FixedTraceStageReservation {
  const pricing = pricingFor(stage, pricingAsOf);
  const inputBytes = traceIds.reduce((total, traceId) => total + stage.requestBounds.inputBytesByTrace[traceId].reduce((sum, bytes) => sum + bytes, 0), 0);
  const requests = traceIds.length * stage.maxIterations;
  const outputTokens = requests * stage.maxOutputTokens;
  const ceilingUsd = (
    inputBytes * pricing.inputUsdPerMillionTokens + outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
  return Object.freeze({ armId: arm.id, repetitionIndex: arm.repetitionIndex, stage: stageName, provider: stage.provider, model: stage.model, requests, inputBytes, outputTokens, ceilingUsd });
}

/**
 * Pure pre-dispatch ceiling. It reports no expected spend because neither
 * provider tokenization nor observed tool-loop length may be assumed.
 */
export function estimateFixedTraceExperiment(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver, holdoutFinalizationResolver?: FixedTraceHoldoutFinalizationResolver): FixedTraceDryRunEstimate {
  assertFixedTraceExperimentPlan(plan, resolver, holdoutFinalizationResolver);
  const candidate: FixedTraceStageReservation[] = [];
  const judges: FixedTraceStageReservation[] = [];
  const traceIds = selectedTraceIds(plan);
  for (const arm of plan.arms) {
    if (arm.router) candidate.push(reservation(arm, 'router', arm.router, traceIds, plan.pricingAsOf));
    if (arm.generation) candidate.push(reservation(arm, 'generation', arm.generation, traceIds, plan.pricingAsOf));
    for (const judge of arm.judges ?? []) judges.push(reservation(arm, 'judge', judge, traceIds, plan.pricingAsOf));
  }
  const candidateCeilingUsd = candidate.reduce((total, item) => total + item.ceilingUsd, 0);
  const judgeCeilingUsd = judges.reduce((total, item) => total + item.ceilingUsd, 0);
  if (candidateCeilingUsd > plan.budgets.candidateCeilingUsd) throw new Error('Candidate worst-case reservation exceeds its separate budget');
  if (judgeCeilingUsd > plan.budgets.judgeCeilingUsd) throw new Error('Judge worst-case reservation exceeds its separate budget');
  return Object.freeze({
    planFingerprint: fixedTraceExperimentPlanFingerprint(plan, resolver, holdoutFinalizationResolver),
    executionOrder: fixedTraceExperimentExecutionOrder(plan, resolver, holdoutFinalizationResolver),
    candidate: Object.freeze({ ceilingUsd: candidateCeilingUsd, expectedSpendUsd: null, reservations: Object.freeze(candidate) }),
    judges: Object.freeze({ ceilingUsd: judgeCeilingUsd, expectedSpendUsd: null, reservations: Object.freeze(judges) }),
    totalCeilingUsd: candidateCeilingUsd + judgeCeilingUsd,
    expectedSpendUsd: null,
  });
}

/** ID-only audit output; callers must not load holdout expectations into prompts. */
export function fixedTraceExperimentPartitionAudit(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver, holdoutFinalizationResolver?: FixedTraceHoldoutFinalizationResolver): { selected: 'development' | 'holdout'; traceIds: readonly string[]; manifestSha256: string; blindingLimitation: typeof FIXED_TRACE_HOLDOUT_LIMITATION } {
  assertFixedTraceExperimentPlan(plan, resolver, holdoutFinalizationResolver);
  return Object.freeze({ selected: plan.partition.selected, traceIds: Object.freeze([...selectedTraceIds(plan)]), manifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256, blindingLimitation: FIXED_TRACE_HOLDOUT_LIMITATION });
}

/** Development selection artifacts cannot contain holdout metrics or IDs. */
export function fixedTraceDevelopmentSelectionArtifact(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver): { planFingerprint: string; developmentTraceIds: readonly string[]; holdoutMetricsIncluded: false; blindingLimitation: typeof FIXED_TRACE_HOLDOUT_LIMITATION } {
  assertFixedTraceExperimentPlan(plan, resolver);
  if (plan.partition.selected !== 'development') throw new Error('Holdout results cannot be emitted as a development selection artifact');
  return Object.freeze({ planFingerprint: fixedTraceExperimentPlanFingerprint(plan, resolver), developmentTraceIds: Object.freeze([...FIXED_TRACE_PARTITION_MANIFEST.development]), holdoutMetricsIncluded: false, blindingLimitation: FIXED_TRACE_HOLDOUT_LIMITATION });
}

/** Must be called by a future dispatcher immediately before the first holdout dispatch. */
export function consumeFixedTraceHoldoutFinalization(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceTrustedManifestResolver,
  finalizationResolver: FixedTraceHoldoutFinalizationResolver,
  consumer: FixedTraceHoldoutFinalizationConsumer,
): void {
  assertFixedTraceExperimentPlan(plan, resolver, finalizationResolver);
  if (plan.partition.selected !== 'holdout') throw new Error('Only a holdout plan can consume finalization');
  const recordId = plan.partition.finalizationGate!.recordId;
  if (!consumer(recordId, fixedTraceCandidatePlanFingerprint(plan))) throw new Error('Holdout finalization record could not be consumed');
}

/**
 * Validates raw-auditable execution provenance before anything can be used in
 * comparison or rollout. This does not score or promote a candidate: the
 * repaired foundation owns evidence verification and must consume this ledger.
 */
export function assertFixedTraceRawAuditableLedger(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceTrustedManifestResolver,
  ledger: FixedTraceRawAuditableLedger,
  artifactResolver: FixedTraceRawArtifactResolver,
  holdoutFinalizationResolver?: FixedTraceHoldoutFinalizationResolver,
): void {
  const manifest = resolveTrustedManifest(plan, resolver);
  assertFixedTraceExperimentPlan(plan, resolver, holdoutFinalizationResolver);
  if (ledger.version !== FIXED_TRACE_RAW_LEDGER_VERSION) throw new Error('Unsupported raw fixed-trace ledger version');
  if (ledger.trustedManifestSha256 !== sha256(manifest)) throw new Error('Raw ledger trusted manifest mismatch');
  if (ledger.planFingerprint !== fixedTraceExperimentPlanFingerprint(plan, resolver, holdoutFinalizationResolver)) throw new Error('Raw ledger plan fingerprint mismatch');
  const knownArms = new Map(plan.arms.map((arm) => [arm.id, arm]));
  const knownTraces = new Set(selectedTraceIds(plan));
  const expectedEntries = new Set<string>();
  for (const arm of plan.arms) for (const traceId of selectedTraceIds(plan)) {
    if (arm.router) expectedEntries.add(`${arm.id}\0${arm.repetitionIndex}\0${traceId}\0router`);
    if (arm.generation) expectedEntries.add(`${arm.id}\0${arm.repetitionIndex}\0${traceId}\0generation`);
    for (const judge of arm.judges ?? []) expectedEntries.add(`${arm.id}\0${arm.repetitionIndex}\0${traceId}\0judge\0${judge.provider}\0${judge.model}`);
  }
  const entries = new Set<string>();
  for (const entry of ledger.entries) {
    requirePositiveInteger(entry.sequence, 'raw ledger sequence');
    const arm = knownArms.get(entry.armId);
    if (!arm || arm.repetitionIndex !== entry.repetitionIndex || !knownTraces.has(entry.traceId)) throw new Error('Raw ledger entry is outside its trusted plan');
    const configuredStage = entry.stage === 'router' ? arm.router
      : entry.stage === 'generation' ? arm.generation
        : (arm.judges ?? []).find((judge) => judge.provider === entry.requestedProvider && judge.model === entry.requestedModel);
    if (!configuredStage) throw new Error('Raw ledger entry has an unplanned stage identity');
    const key = `${entry.armId}\0${entry.repetitionIndex}\0${entry.traceId}\0${entry.stage}${entry.stage === 'judge' ? `\0${configuredStage.provider}\0${configuredStage.model}` : ''}`;
    if (!expectedEntries.has(key)) throw new Error('Raw ledger entry is outside its trusted plan');
    if (entries.has(key)) throw new Error('Duplicate raw ledger entry');
    entries.add(key);
    requireHash(entry.promptSha256, 'raw ledger promptSha256');
    requireHash(entry.caseControlSha256, 'raw ledger caseControlSha256');
    requireHash(entry.executionEnvelopeSha256, 'raw ledger executionEnvelopeSha256');
    requireHash(entry.directAdmissionSha256, 'raw ledger directAdmissionSha256');
    if (entry.dispatched && (!entry.requestedProvider || !entry.requestedModel || !entry.providerRequestSha256)) {
      throw new Error('Dispatched raw ledger entry lacks requested identity or request digest');
    }
    if ((entry.returnedProvider === null) !== (entry.returnedModel === null)) throw new Error('Raw ledger returned identity is incomplete');
    if (entry.providerRequestSha256 !== null) requireHash(entry.providerRequestSha256, 'raw ledger providerRequestSha256');
    if (entry.responseSha256 !== null) requireHash(entry.responseSha256, 'raw ledger responseSha256');
    const validateRawArtifact = (artifact: { sha256: string; byteLength: number; storageKey: string } | null, label: string) => {
      if (!artifact || !artifact.storageKey.trim()) throw new Error(`Raw ledger ${label} artifact is required`);
      requireHash(artifact.sha256, `raw ledger ${label} artifact`);
      requirePositiveInteger(artifact.byteLength, `raw ledger ${label} artifact byteLength`);
      const trustedArtifact = artifactResolver(artifact.storageKey);
      if (!trustedArtifact) throw new Error(`Raw ledger ${label} artifact is unavailable`);
      if (trustedArtifact.sha256 !== artifact.sha256 || trustedArtifact.byteLength !== artifact.byteLength) {
        throw new Error(`Raw ledger ${label} artifact does not match its trusted bytes`);
      }
    };
    if (entry.dispatched) {
      validateRawArtifact(entry.rawRequestArtifact, 'request');
      if (entry.rawRequestArtifact!.sha256 !== entry.providerRequestSha256) throw new Error('Raw request artifact digest mismatch');
    } else if (entry.rawRequestArtifact !== null) validateRawArtifact(entry.rawRequestArtifact, 'request');
    if (entry.responseSha256 !== null) {
      validateRawArtifact(entry.rawResponseArtifact, 'response');
      if (entry.rawResponseArtifact!.sha256 !== entry.responseSha256) throw new Error('Raw response artifact digest mismatch');
    } else if (entry.rawResponseArtifact !== null) validateRawArtifact(entry.rawResponseArtifact, 'response');
    if (
      entry.requestedProvider !== configuredStage.provider
      || entry.requestedModel !== configuredStage.model
      || entry.maxOutputTokens !== configuredStage.maxOutputTokens
      || entry.timeoutMs !== configuredStage.timeoutMs
      || entry.maxIterations !== configuredStage.maxIterations
      || entry.reasoningEffort !== configuredStage.reasoningEffort
      || entry.samplingMode !== configuredStage.samplingMode
    ) throw new Error('Raw ledger entry does not match its planned stage controls');
  }
  if (entries.size !== expectedEntries.size) throw new Error('Raw ledger lacks complete planned-stage coverage');
}
