import { createHash } from 'node:crypto';
import type { ModelProviderId, ModelReasoningEffort } from '../model-providers/model-provider.js';
import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
  OPENAI_GPT_5_6_LUNA_PRICING_VERSION,
} from '../model-cost-pricing.js';
import { CLAUDE_PRICING_VERSION } from '../claude-pricing.js';
import { OPENAI_ROUTER_MODEL } from '../model-providers/openai-responses-provider.js';
import {
  FIXED_TRACE_PARTITION_MANIFEST,
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  FIXED_TRACE_PARTITION_MANIFEST_VERSION,
  assertFixedTracePartitionManifest,
} from './fixed-trace-partition.js';
import type { AddieTool } from '../types.js';
import { CODE_VERSION } from '../config-version.js';
import {
  FIXED_TRACE_STAGE_CONTROL_VERSION,
  type FixedTraceCase,
} from './fixed-trace-suite.js';
import type { FixedTraceToolDefinitionProvenance } from './fixed-trace-architecture.js';
import { deepFreezeFixedTrace, snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/** A versioned, network-free admission contract for fixed-trace experiments. */
export const FIXED_TRACE_EXPERIMENT_PLAN_VERSION = 'addie-fixed-trace-experiment-plan-v1' as const;
export const FIXED_TRACE_RAW_LEDGER_VERSION = 'addie-fixed-trace-raw-ledger-v1' as const;
export const FIXED_TRACE_REPOSITORY_VISIBLE_VALIDATION_LIMITATION =
  'repository_visible_development_validation_not_confirmatory_holdout' as const;

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
    provider: 'openai', model: OPENAI_ROUTER_MODEL, version: OPENAI_GPT_5_6_LUNA_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z', inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2,
    source: 'Repository OpenAI Luna router price pin, checked 2026-08-26.',
  }),
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
  transportRetries: 0;
  samplingMode: 'temperature_zero' | 'provider_no_sampling_control';
  temperature: 0 | null;
  /** Cache accounting is unavailable for execution unless disabled. */
  cacheMode: 'disabled';
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
  /** Exact values stamped by the runner and included in its provenance hash. */
  gitCommit: string;
  gitDirty: boolean;
  addieCodeVersion: string;
  stageControlVersion: string;
  traceSuiteSha256: string;
  promptConfigVersion: string;
  toolSchemaSha256: string;
  toolDefinitionProvenance: FixedTraceToolDefinitionProvenance;
  providerDegradationInjectionEnabled: boolean;
  partition: {
    manifestVersion: typeof FIXED_TRACE_PARTITION_MANIFEST_VERSION;
    manifestSha256: typeof FIXED_TRACE_PARTITION_MANIFEST_SHA256;
    selected: 'development' | 'repository_visible_development_validation';
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
  promptConfigVersion: string;
  /**
   * Resolver-owned, phase-selected execution inputs. They are never inferred
   * from a plan or copied onto an observation after execution.
   */
  suites: Readonly<Record<'development' | 'repository_visible_development_validation', FixedTraceTrustedSuite>>;
  partitionManifestSha256: string;
  rawLedgerVersion: typeof FIXED_TRACE_RAW_LEDGER_VERSION;
  gitCommit: string;
  gitDirty: boolean;
  addieCodeVersion: string;
  stageControlVersion: string;
  providerDegradationInjectionEnabled: boolean;
}

export interface FixedTraceTrustedSuite {
  traceSuite: ReadonlyArray<FixedTraceCase>;
  traceSuiteSha256: string;
  toolDefinitions: ReadonlyArray<AddieTool>;
  toolSchemaSha256: string;
  toolDefinitionProvenance: FixedTraceToolDefinitionProvenance;
}

export type FixedTraceTrustedManifestResolver = (id: string) => FixedTraceTrustedManifest | null;

/** Stable identity for a resolver-owned manifest, used by the raw ledger. */
export function fixedTraceTrustedManifestFingerprint(manifest: FixedTraceTrustedManifest): string {
  return sha256(snapshotFixedTraceJson(manifest, 'trusted manifest'));
}

/**
 * The evaluator-owned portion of a future runner config. A dispatcher must
 * supply actual providers separately, but may not replace any value here or
 * synthesize a suite/hash from a completed observation.
 */
export interface FixedTraceExperimentRunnerBinding {
  runId: string;
  repetition: number;
  sourceBundleSha256: string;
  gitCommit: string;
  gitDirty: boolean;
  addieCodeVersion: string;
  stageControlVersion: string;
  promptConfigVersion: string;
  traceSuite: ReadonlyArray<FixedTraceCase>;
  traceSuiteSha256: string;
  toolDefinitions: ReadonlyArray<AddieTool>;
  toolDefinitionProvenance: FixedTraceToolDefinitionProvenance;
  providerDegradationInjectionEnabled: boolean;
}

/**
 * A confirmatory finalization authority is intentionally absent. The only
 * in-repository secondary split is development validation, not a secret pack;
 * an externally authored/custodied final pack needs its own reviewed system.
 */

/**
 * An untrusted proposed observation shape. It cannot be validated or used as
 * evidence in this PR. A future evaluator must bind every field below to a
 * `FixedTraceTrustedExecutionExpectation` before the matching invocation.
 */
export interface FixedTraceRawLedgerEntry {
  sequence: number;
  /** The plan-controlled stage grouping; it cannot be supplied out of order. */
  phaseId: FixedTraceScreeningStage;
  armId: string;
  repetitionIndex: number;
  traceId: string;
  stage: 'router' | 'generation' | 'judge';
  /** Monotonic configured invocation within a stage; never collapsed to one row. */
  callIndex: number;
  /** Every network attempt is represented, including failed attempts. */
  attemptIndex: number;
  dispatched: boolean;
  requestedProvider: ModelProviderId | null;
  requestedModel: string | null;
  returnedProvider: ModelProviderId | null;
  returnedModel: string | null;
  promptSha256: string;
  systemSha256: string;
  docsSha256: string;
  toolSchemaSha256: string;
  providerRequestSha256: string | null;
  responseSha256: string | null;
  /** Content-addressed immutable raw artifacts; their bytes stay outside summaries. */
  rawRequestArtifact: { sha256: string; byteLength: number; storageKey: string } | null;
  rawResponseArtifact: { sha256: string; byteLength: number; storageKey: string } | null;
  exactToolNames: readonly string[];
  caseControlSha256: string;
  executionEnvelopeSha256: string;
  directAdmissionSha256: string;
  simulatorReceiptSha256: string;
  simulatorResultProvenanceSha256: string;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
  maxIterations: number | null;
  transportRetries: 0 | null;
  reasoningEffort: ModelReasoningEffort;
  samplingMode: 'temperature_zero' | 'provider_no_sampling_control' | null;
  cacheMode: 'disabled' | null;
  pricingProfileId: string | null;
  failureDenominatorId: string;
  /** Offline validation admits only the explicit non-dispatch terminal state. */
  status: 'not_dispatched';
  finishReason: null;
  usage: null;
  estimatedCostUsd: null;
}

/**
 * Evaluator-owned pre-dispatch expected values. A coordinator must create and
 * authenticate this complete sequence from the immutable manifest before any
 * provider call; there is deliberately no implementation in this PR.
 */
export interface FixedTraceTrustedExecutionExpectation {
  trustedManifestSha256: string;
  planFingerprint: string;
  budgetIdentitySha256: string;
  entries: readonly FixedTraceRawLedgerEntry[];
}

export interface FixedTraceRawAuditableLedger {
  version: typeof FIXED_TRACE_RAW_LEDGER_VERSION;
  trustedManifestSha256: string;
  planFingerprint: string;
  /** Exact dry-run reservation identity; summaries cannot substitute it. */
  budgetIdentitySha256: string;
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
  /** Binds a raw spend ledger to the exact conservative reservations below. */
  budgetIdentitySha256: string;
  diagnosticOnly: true;
  comparisonEligible: false;
  executionOrder: readonly string[];
  candidate: { ceilingUsd: number; expectedSpendUsd: null; reservations: readonly FixedTraceStageReservation[] };
  judges: { ceilingUsd: number; expectedSpendUsd: null; reservations: readonly FixedTraceStageReservation[] };
  totalCeilingUsd: number;
  /** No traffic or provider calls occur; expected spend needs observed usage. */
  expectedSpendUsd: null;
}

export interface FixedTraceOfflinePlanValidation {
  diagnosticOnly: true;
  comparisonEligible: false;
  dispatchable: false;
  trustedLock: false;
  planFingerprint: string;
}

function assertExactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.some((key) => key === '__proto__' || key === 'prototype' || key === 'constructor')) {
    throw new Error(`${label} contains a dangerous prototype key`);
  }
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown, missing, or inherited fields`);
  }
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
  return plan.partition.selected === 'development'
    ? FIXED_TRACE_PARTITION_MANIFEST.development
    : FIXED_TRACE_PARTITION_MANIFEST.repositoryVisibleDevelopmentValidation;
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
  assertExactKeys(stage, [
    'provider', 'model', 'reasoningEffort', 'pricingVersion', 'maxOutputTokens',
    'timeoutMs', 'maxIterations', 'transportRetries', 'samplingMode', 'temperature',
    'cacheMode', 'requestBounds',
  ], label);
  if (!['anthropic', 'openai', 'google'].includes(stage.provider)) throw new Error(`${label}.provider is unknown`);
  if (!['provider_default', 'none', 'low', 'medium', 'high'].includes(stage.reasoningEffort)) throw new Error(`${label}.reasoningEffort is unknown`);
  if (!stage.model.trim()) throw new Error(`${label}.model is required`);
  requirePositiveInteger(stage.maxOutputTokens, `${label}.maxOutputTokens`);
  requirePositiveInteger(stage.timeoutMs, `${label}.timeoutMs`);
  requirePositiveInteger(stage.maxIterations, `${label}.maxIterations`);
  if (
    (stage.samplingMode === 'temperature_zero' && stage.temperature !== 0)
    || (stage.samplingMode === 'provider_no_sampling_control' && stage.temperature !== null)
  ) throw new Error(`${label} sampling controls are inconsistent`);
  if (stage.transportRetries !== 0 || stage.cacheMode !== 'disabled') {
    throw new Error(`${label} has an unsupported retry or cache control`);
  }
  const pricing = pricingFor(stage, pricingAsOf);
  const bounds = stage.requestBounds?.inputBytesByTrace;
  if (!bounds || typeof bounds !== 'object') throw new Error(`${label}.requestBounds are required`);
  assertExactKeys(stage.requestBounds, ['inputBytesByTrace'], `${label}.requestBounds`);
  assertExactKeys(bounds, traceIds, `${label}.requestBounds.inputBytesByTrace`);
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
  assertExactKeys(arm, ['id', 'architecture', 'screeningStage', 'repetitionIndex', ...(
    arm.router ? ['router'] : []), ...(arm.generation ? ['generation'] : []), ...(arm.judges ? ['judges'] : [])], `arm ${arm.id}`);
  if (!['two_stage_llm_router', 'direct_generation', 'hybrid_generation', 'oracle_route_diagnostic'].includes(arm.architecture)) {
    throw new Error(`${arm.id}.architecture is unknown`);
  }
  if (!['router_only_screen', 'oracle_route_generator_diagnostic', 'deployable_finalist'].includes(arm.screeningStage)) {
    throw new Error(`${arm.id}.screeningStage is unknown`);
  }
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
    assertExactKeys(judge, [
      'provider', 'model', 'reasoningEffort', 'pricingVersion', 'maxOutputTokens',
      'timeoutMs', 'maxIterations', 'transportRetries', 'samplingMode', 'temperature',
      'cacheMode', 'requestBounds', 'blinded',
    ], `${arm.id}.judges.${index}`);
    if (judge.blinded !== true) throw new Error(`${arm.id}.judges.${index} must be blinded`);
    if (candidateProviders.has(judge.provider)) throw new Error(`${arm.id}.judges.${index} is not provider-independent`);
    judgeProviders.add(judge.provider);
    validateStage(judge, `${arm.id}.judges.${index}`, traces, plan.pricingAsOf);
  }
  if (judgeProviders.size < 2) throw new Error(`${arm.id} requires two provider-independent judges`);
}

function assertPlanShape(plan: FixedTraceExperimentPlan): void {
  assertExactKeys(plan, [
    'version', 'id', 'trustedManifestId', 'sourceId', 'sourceRevision', 'pricingAsOf',
    'sourceBundleSha256', 'gitCommit', 'gitDirty', 'addieCodeVersion', 'stageControlVersion',
    'traceSuiteSha256', 'promptConfigVersion', 'toolSchemaSha256', 'toolDefinitionProvenance',
    'providerDegradationInjectionEnabled', 'partition', 'ordering', 'budgets', 'arms',
  ], 'experiment plan');
  assertExactKeys(plan.partition, ['manifestVersion', 'manifestSha256', 'selected'], 'experiment plan.partition');
  assertExactKeys(plan.ordering, ['seed'], 'experiment plan.ordering');
  assertExactKeys(plan.budgets, ['candidateCeilingUsd', 'judgeCeilingUsd'], 'experiment plan.budgets');
}

function assertFixedTraceExperimentPlanStructure(
  plan: FixedTraceExperimentPlan,
): void {
  assertPlanShape(plan);
  assertFixedTracePartitionManifest();
  if (plan.version !== FIXED_TRACE_EXPERIMENT_PLAN_VERSION) throw new Error('Unsupported fixed-trace experiment plan version');
  if (!plan.id.trim()) throw new Error('Experiment plan ID is required');
  if (!plan.trustedManifestId.trim() || !plan.sourceId.trim() || !plan.sourceRevision.trim()) throw new Error('Experiment plan requires a trusted source identity');
  requireHash(plan.sourceBundleSha256, 'sourceBundleSha256');
  if (!/^[a-f0-9]{7,64}$/.test(plan.gitCommit) || typeof plan.gitDirty !== 'boolean' || !plan.addieCodeVersion.trim() || plan.stageControlVersion !== FIXED_TRACE_STAGE_CONTROL_VERSION || typeof plan.providerDegradationInjectionEnabled !== 'boolean') {
    throw new Error('Experiment plan run provenance is incomplete');
  }
  if (plan.addieCodeVersion !== CODE_VERSION) throw new Error('Experiment plan Addie code version does not match this runner');
  requireHash(plan.traceSuiteSha256, 'traceSuiteSha256');
  requireHash(plan.promptConfigVersion, 'promptConfigVersion');
  requireHash(plan.toolSchemaSha256, 'toolSchemaSha256');
  if (plan.partition.manifestVersion !== FIXED_TRACE_PARTITION_MANIFEST_VERSION || plan.partition.manifestSha256 !== FIXED_TRACE_PARTITION_MANIFEST_SHA256) {
    throw new Error('Experiment plan uses an uncommitted fixed-trace partition manifest');
  }
  if (!['development', 'repository_visible_development_validation'].includes(plan.partition.selected)) {
    throw new Error('Only repository-visible development partitions are available');
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
}

/** The sole boundary at which caller data becomes immutable plan data. */
function validatedPlanSnapshot(plan: FixedTraceExperimentPlan): FixedTraceExperimentPlan {
  const snapshot = snapshotFixedTraceJson(plan, 'experiment plan') as FixedTraceExperimentPlan;
  assertFixedTraceExperimentPlanStructure(snapshot);
  return snapshot;
}

/** Validate an untrusted plan without credentials, providers, outputs, or a resolver. */
export function validateFixedTraceExperimentPlanOffline(plan: FixedTraceExperimentPlan): FixedTraceOfflinePlanValidation {
  const snapshot = validatedPlanSnapshot(plan);
  // A submitted plan can describe only priced, already reviewed stages. Terra
  // and Sol have no reviewed repository price, so their descriptors cannot
  // enter an estimate or a budget reservation.
  return Object.freeze({
    diagnosticOnly: true,
    comparisonEligible: false,
    dispatchable: false,
    trustedLock: false,
    planFingerprint: sha256(snapshot),
  });
}

/**
 * Validates an offline ledger in its exact planned order. Nothing in this
 * lane can have been dispatched, returned, priced, or promoted; accepting a
 * partial or provider-shaped record would let caller data masquerade as
 * evidence.
 */
export function validateFixedTraceRawAuditableLedgerOffline(
  plan: FixedTraceExperimentPlan,
  ledger: FixedTraceRawAuditableLedger,
  expectedTrustedManifestSha256: string,
): void {
  // Do not bless syntax-shaped caller evidence. Exact expected prompts,
  // tool surface/order, request/envelope/admission hashes, simulator
  // provenance, per-invocation attempts, returned identity, usage, pricing,
  // cost, and failure denominator must be bound by a trusted coordinator
  // before dispatch. That coordinator is deliberately not authorized here.
  void plan;
  void ledger;
  void expectedTrustedManifestSha256;
  throw new Error('Raw-ledger validation is unavailable pending a trusted evaluator-owned coordinator');
}

/**
 * There is deliberately no resolver in this change that can turn caller JSON
 * into evaluator authority. A future reviewed evaluator must authenticate a
 * manifest outside this process before exposing an execution binding.
 */
function resolveTrustedManifest(
  _plan: FixedTraceExperimentPlan,
  _resolver: FixedTraceTrustedManifestResolver,
): FixedTraceTrustedManifest {
  throw new Error('Trusted fixed-trace manifest is locked pending evaluator-owned authentication');
}

/** Builds an immutable input binding for exactly one planned arm, never a dispatcher. */
export function fixedTraceExperimentRunnerBinding(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceTrustedManifestResolver,
  armId: string,
): FixedTraceExperimentRunnerBinding {
  assertFixedTraceExperimentPlan(plan, resolver);
  const arm = plan.arms.find((candidate) => candidate.id === armId);
  if (!arm) throw new Error(`Experiment plan has no arm: ${armId}`);
  const manifest = resolveTrustedManifest(plan, resolver);
  const suite = manifest.suites[plan.partition.selected];
  return Object.freeze({
    runId: `${plan.id}:${arm.id}:r${arm.repetitionIndex}`,
    repetition: arm.repetitionIndex,
    sourceBundleSha256: plan.sourceBundleSha256,
    gitCommit: plan.gitCommit,
    gitDirty: plan.gitDirty,
    addieCodeVersion: plan.addieCodeVersion,
    stageControlVersion: plan.stageControlVersion,
    promptConfigVersion: plan.promptConfigVersion,
    traceSuite: deepFreezeFixedTrace(snapshotFixedTraceJson(suite.traceSuite, 'trusted manifest trace suite')) as ReadonlyArray<FixedTraceCase>,
    traceSuiteSha256: suite.traceSuiteSha256,
    toolDefinitions: deepFreezeFixedTrace(snapshotFixedTraceJson(suite.toolDefinitions, 'trusted manifest tool definitions')) as ReadonlyArray<AddieTool>,
    toolDefinitionProvenance: suite.toolDefinitionProvenance,
    providerDegradationInjectionEnabled: plan.providerDegradationInjectionEnabled,
  });
}

/** Omits partition selection so a candidate description cannot be restamped as a different development split. */
export function fixedTraceCandidatePlanFingerprint(plan: FixedTraceExperimentPlan): string {
  const snapshot = validatedPlanSnapshot(plan);
  const { partition, ...candidatePlan } = snapshot;
  return sha256({
    ...candidatePlan,
    partition: {
      manifestVersion: partition.manifestVersion,
      manifestSha256: partition.manifestSha256,
    },
  });
}

export function assertFixedTraceExperimentPlan(
  plan: FixedTraceExperimentPlan,
  resolver: FixedTraceTrustedManifestResolver,
): void {
  const snapshot = validatedPlanSnapshot(plan);
  resolveTrustedManifest(snapshot, resolver);
}

export function fixedTraceExperimentPlanFingerprint(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver): string {
  void resolver;
  return validateFixedTraceExperimentPlanOffline(plan).planFingerprint;
}

/** Deterministic permutation based on a recorded seed, never provider input order. */
export function fixedTraceExperimentExecutionOrder(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver): readonly string[] {
  void resolver;
  const snapshot = validatedPlanSnapshot(plan);
  return Object.freeze([...snapshot.arms]
    .sort((left, right) => sha256({ seed: snapshot.ordering.seed, arm: left.id, repetition: left.repetitionIndex })
      .localeCompare(sha256({ seed: snapshot.ordering.seed, arm: right.id, repetition: right.repetitionIndex })) || left.id.localeCompare(right.id))
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
export function estimateFixedTraceExperiment(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver): FixedTraceDryRunEstimate {
  void resolver;
  const snapshot = validatedPlanSnapshot(plan);
  const candidate: FixedTraceStageReservation[] = [];
  const judges: FixedTraceStageReservation[] = [];
  const traceIds = selectedTraceIds(snapshot);
  for (const arm of snapshot.arms) {
    if (arm.router) candidate.push(reservation(arm, 'router', arm.router, traceIds, snapshot.pricingAsOf));
    if (arm.generation) candidate.push(reservation(arm, 'generation', arm.generation, traceIds, snapshot.pricingAsOf));
    for (const judge of arm.judges ?? []) judges.push(reservation(arm, 'judge', judge, traceIds, snapshot.pricingAsOf));
  }
  const candidateCeilingUsd = candidate.reduce((total, item) => total + item.ceilingUsd, 0);
  const judgeCeilingUsd = judges.reduce((total, item) => total + item.ceilingUsd, 0);
  if (candidateCeilingUsd > snapshot.budgets.candidateCeilingUsd) throw new Error('Candidate worst-case reservation exceeds its separate budget');
  if (judgeCeilingUsd > snapshot.budgets.judgeCeilingUsd) throw new Error('Judge worst-case reservation exceeds its separate budget');
  const planFingerprint = sha256(snapshot);
  const budgetIdentitySha256 = sha256({
    planFingerprint,
    candidate: candidate.map((item) => ({ ...item })),
    judges: judges.map((item) => ({ ...item })),
  });
  return Object.freeze({
    planFingerprint,
    budgetIdentitySha256,
    diagnosticOnly: true,
    comparisonEligible: false,
    executionOrder: Object.freeze([...snapshot.arms]
      .sort((left, right) => sha256({ seed: snapshot.ordering.seed, arm: left.id, repetition: left.repetitionIndex })
        .localeCompare(sha256({ seed: snapshot.ordering.seed, arm: right.id, repetition: right.repetitionIndex })) || left.id.localeCompare(right.id))
      .map((arm) => arm.id)),
    candidate: Object.freeze({ ceilingUsd: candidateCeilingUsd, expectedSpendUsd: null, reservations: Object.freeze(candidate) }),
    judges: Object.freeze({ ceilingUsd: judgeCeilingUsd, expectedSpendUsd: null, reservations: Object.freeze(judges) }),
    totalCeilingUsd: candidateCeilingUsd + judgeCeilingUsd,
    expectedSpendUsd: null,
  });
}

/** This is an ID-only development-validation audit, never a secret holdout. */
export function fixedTraceExperimentPartitionAudit(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver): { selected: 'development' | 'repository_visible_development_validation'; traceIds: readonly string[]; manifestSha256: string; limitation: typeof FIXED_TRACE_REPOSITORY_VISIBLE_VALIDATION_LIMITATION } {
  assertFixedTraceExperimentPlan(plan, resolver);
  return Object.freeze({ selected: plan.partition.selected, traceIds: Object.freeze([...selectedTraceIds(plan)]), manifestSha256: FIXED_TRACE_PARTITION_MANIFEST_SHA256, limitation: FIXED_TRACE_REPOSITORY_VISIBLE_VALIDATION_LIMITATION });
}

/** Development selection artifacts cannot claim any confirmatory final metrics. */
export function fixedTraceDevelopmentSelectionArtifact(plan: FixedTraceExperimentPlan, resolver: FixedTraceTrustedManifestResolver): { planFingerprint: string; developmentTraceIds: readonly string[]; confirmatoryMetricsIncluded: false; limitation: typeof FIXED_TRACE_REPOSITORY_VISIBLE_VALIDATION_LIMITATION } {
  assertFixedTraceExperimentPlan(plan, resolver);
  if (plan.partition.selected !== 'development') throw new Error('Repository-visible validation cannot be emitted as a development selection artifact');
  return Object.freeze({ planFingerprint: fixedTraceExperimentPlanFingerprint(plan, resolver), developmentTraceIds: Object.freeze([...FIXED_TRACE_PARTITION_MANIFEST.development]), confirmatoryMetricsIncluded: false, limitation: FIXED_TRACE_REPOSITORY_VISIBLE_VALIDATION_LIMITATION });
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
): void {
  // No caller-provided ledger can be evidence until the missing coordinator
  // constructs and authenticates exact expected invocation records.
  void plan;
  void resolver;
  void ledger;
  void artifactResolver;
  throw new Error('Raw-ledger validation is unavailable pending a trusted evaluator-owned coordinator');
}
