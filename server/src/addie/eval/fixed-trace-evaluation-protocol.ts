import { createHash } from 'node:crypto';
import type { ModelProviderId, ModelReasoningEffort } from '../model-providers/model-provider.js';
import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
} from '../model-cost-pricing.js';
import { CLAUDE_PRICING_VERSION } from '../claude-pricing.js';
import {
  fixedTraceEstimatedCostUsd,
  validateFixedTracePricing,
} from './fixed-trace-budget.js';
import {
  type FixedTraceCase,
  type FixedTracePricing,
} from './fixed-trace-suite.js';
import { deepFreezeFixedTrace, snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';

/**
 * A planning-only contract. It has no dispatcher and is deliberately unable
 * to make a corpus, an execution envelope, or a sealed holdout trusted.
 */
export const FIXED_TRACE_EVALUATION_PROTOCOL_VERSION =
  'addie-fixed-trace-evaluation-protocol-v1' as const;

/**
 * Evaluator-owned confirmatory precision rule. The conservative normal
 * approximation assumes the maximum possible variance (1) of a paired
 * case-level difference in [-1, 1], with one-sided alpha .025 and 80% power.
 * The non-inferiority margin is limiting: ceil((1.9599639845 + .8416212336)^2
 * / .03^2) = 8,721 independent paired cases. This is deliberately a sample
 * requirement, not a price quote or an authorization to spend.
 */
export const FIXED_TRACE_CONFIRMATORY_POWER_GATE = Object.freeze({
  version: 'addie-fixed-trace-confirmatory-power-v1',
  unit: 'unique_paired_case',
  repetitionsCountAsIndependentCases: false,
  oneSidedAlpha: 0.025,
  targetPower: 0.8,
  conservativePairedDifferenceVarianceUpperBound: 1,
  superiorityMarginPercentagePoints: 5,
  nonInferiorityMarginPercentagePoints: -3,
  superiorityRequiredIndependentEvaluableCases: 3_140,
  nonInferiorityRequiredIndependentEvaluableCases: 8_721,
  requiredIndependentEvaluableCases: 8_721,
  requiredAnalysis: Object.freeze({
    resampling: 'grouped_stratified_case_level_bootstrap',
    multiplicityCorrection: 'holm',
    pairedDiscordanceTest: 'predeclared_exact_paired_test_required',
  }),
  currentScreeningTuningUniqueCaseCount: 120,
} as const);

export type FixedTraceProtocolPhaseId =
  | 'bounded_smoke'
  | 'router_screen'
  | 'oracle_generator_ceiling'
  | 'deployable_architecture'
  | 'controlled_tuning';

export type FixedTraceProtocolArchitecture =
  | 'two_stage_llm_router'
  | 'oracle_route_diagnostic'
  | 'hybrid_safe_signal_then_llm'
  | 'direct_bounded_production_shaped';

export type FixedTraceProtocolStageRole = 'router' | 'generation' | 'judge';

export type FixedTraceProtocolAdmission =
  | 'planning_only'
  | 'requires_verified_hybrid_contract'
  | 'requires_verified_direct_contract';

export interface FixedTraceProtocolPricingProfile extends FixedTracePricing {
  provider: ModelProviderId;
  model: string;
  /** Immutable price-list revision, distinct from the model identifier. */
  version: string;
  /** A plan becomes stale rather than inheriting a later provider price. */
  validBefore: string;
}

/**
 * Closed pricing profiles. Cache is disabled in the protocol, but the
 * provider-specific semantics remain explicit so a future cache-enabled plan
 * must add a reviewed ceiling instead of silently reusing these values.
 */
export const FIXED_TRACE_PROTOCOL_PRICING = Object.freeze([
  Object.freeze({
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    profileId: `${CLAUDE_PRICING_VERSION}:claude-haiku-4-5`,
    version: CLAUDE_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z',
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
    cacheReadUsdPerMillionTokens: 0.1,
    cacheWriteUsdPerMillionTokens: 1.25,
    cacheReadAccounting: 'additive',
    cacheWriteAccounting: 'additive',
    source: 'Repository Anthropic standard pricing table, refreshed August 2026.',
  }),
  Object.freeze({
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    profileId: `${CLAUDE_PRICING_VERSION}:claude-sonnet-5`,
    version: CLAUDE_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z',
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    cacheReadUsdPerMillionTokens: 0.3,
    cacheWriteUsdPerMillionTokens: 3.75,
    cacheReadAccounting: 'additive',
    cacheWriteAccounting: 'additive',
    source: 'Repository Anthropic standard pricing table, refreshed August 2026.',
  }),
  Object.freeze({
    provider: 'google',
    model: 'gemini-3.7-flash',
    profileId: `${GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION}:gemini-3.7-flash`,
    version: GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
    validBefore: '2027-01-01T00:00:00.000Z',
    inputUsdPerMillionTokens: 0.75,
    outputUsdPerMillionTokens: 3.75,
    cacheReadUsdPerMillionTokens: 0.075,
    cacheWriteUsdPerMillionTokens: 0.75,
    cacheReadAccounting: 'subset',
    cacheWriteAccounting: 'additive',
    source: 'Repository Google Gemini 3.7 Flash pricing pin through 2026-12-31.',
  }),
] satisfies readonly FixedTraceProtocolPricingProfile[]);

export interface FixedTraceProtocolStage {
  role: FixedTraceProtocolStageRole;
  provider: ModelProviderId;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  pricingProfileId: string;
  /** Hard pre-dispatch cap for one request, not an observed average. */
  maxInputTokensPerInvocation: number;
  maxOutputTokensPerInvocation: number;
  timeoutMs: number;
  maxInvocationsPerCase: number;
  transportRetries: 0;
  samplingMode: 'provider_no_sampling_control';
  temperature: null;
  /** No cache read or write is permitted; profile semantics remain recorded. */
  cacheMode: 'disabled';
}

export interface FixedTraceProtocolArm {
  id: string;
  architecture: FixedTraceProtocolArchitecture;
  admission: FixedTraceProtocolAdmission;
  /** Each judge appears once; exactly two are required for compared outputs. */
  stages: readonly FixedTraceProtocolStage[];
}

export interface FixedTraceProtocolPhase {
  id: FixedTraceProtocolPhaseId;
  uniqueCaseCount: number;
  repetitions: number;
  /** All output is diagnostic-only and cannot select or promote a candidate. */
  resultUse: 'diagnostic_only';
  arms: readonly FixedTraceProtocolArm[];
}

export interface FixedTraceEvaluationProtocol {
  version: typeof FIXED_TRACE_EVALUATION_PROTOCOL_VERSION;
  id: string;
  /** This identifier must be resolved by a future evaluator-owned coordinator. */
  trustedManifestId: string;
  pricingAsOf: string;
  contingencyBasisPoints: number;
  /** A planning deficit only; it is not an executable or authenticated phase. */
  unavailableFinalTarget: {
    availability: 'unavailable';
    uniqueCaseCount: number;
    repetitions: number;
    missingCaseCount: number;
  };
  phases: readonly FixedTraceProtocolPhase[];
}

export interface FixedTraceProtocolTrustedManifest {
  id: string;
  protocolFingerprint: string;
  sourceId: string;
  sourceRevision: string;
  /**
   * Evaluator-owned digests of the actual subsets passed to the runner. They
   * are not canonical-suite constants and must be supplied as the repaired
   * runner's `traceSuite` and `traceSuiteSha256` config before dispatch;
   * post-hoc observation restamping is forbidden.
   */
  traceSuiteSha256ByPhase: Readonly<Record<FixedTraceProtocolPhaseId, string>>;
  tracePackSha256: string;
  rawLedgerVersion: string;
  partitions: Readonly<Record<FixedTraceProtocolPhaseId, number>>;
  verifiedAdmissions: readonly FixedTraceProtocolAdmission[];
}

export type FixedTraceProtocolTrustedManifestResolver =
  (id: string) => FixedTraceProtocolTrustedManifest | null;

/**
 * The only suite-identity input a future dispatcher may pass to the repaired
 * runner. It is derived from evaluator-owned state before dispatch, never
 * inferred from or applied to a completed observation.
 */
export interface FixedTraceProtocolRunnerBinding {
  trustedManifestId: string;
  protocolFingerprint: string;
  phaseId: FixedTraceProtocolPhaseId;
  /** Evaluator-owned subset, passed unchanged to the repaired runner. */
  traceSuite: ReadonlyArray<FixedTraceCase>;
  /** Matches the repaired runner's required `traceSuiteSha256` config field. */
  traceSuiteSha256: string;
}

export interface FixedTraceProtocolStageEstimate {
  phaseId: FixedTraceProtocolPhaseId;
  armId: string;
  role: FixedTraceProtocolStageRole;
  provider: ModelProviderId;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  pricingProfileId: string;
  cacheMode: 'disabled';
  cacheSemantics: Pick<FixedTraceProtocolPricingProfile, 'cacheReadAccounting' | 'cacheWriteAccounting'>;
  requests: number;
  inputTokenCeiling: number;
  outputTokenCeiling: number;
  ceilingUsd: number;
}

export interface FixedTraceProtocolPhaseEstimate {
  phaseId: FixedTraceProtocolPhaseId;
  uniqueCaseCount: number;
  repetitions: number;
  candidateCalls: number;
  judgeCalls: number;
  candidateCeilingUsd: number;
  judgeCeilingUsd: number;
  totalCeilingUsd: number;
}

export interface FixedTraceProtocolEstimate {
  protocolFingerprint: string;
  dispatchable: false;
  expectedSpendUsd: null;
  stages: readonly FixedTraceProtocolStageEstimate[];
  phases: readonly FixedTraceProtocolPhaseEstimate[];
  screening: { candidateCeilingUsd: number; judgeCeilingUsd: number; totalCeilingUsd: number };
  unavailableFinalTarget: FixedTraceEvaluationProtocol['unavailableFinalTarget'];
  /** The confirmatory sample remains unpriced and cannot authorize spend. */
  budgetProjection: {
    screeningTuning: {
      uniqueEvaluableCaseCount: number;
      repetitionsCountAsIndependentCases: false;
      expectedSpendUsd: null;
      approvalCeilingUsd: null;
    };
    confirmatory: {
      requiredIndependentEvaluableCaseCount: number;
      unavailableTargetCaseCount: number;
      expectedSpendUsd: null;
      approvalCeilingUsd: null;
      spendAuthorization: 'refused_pending_evaluator_owned_paired_test';
    };
  };
  candidateCeilingUsd: number;
  judgeCeilingUsd: number;
  contingencyUsd: number;
  totalCeilingUsd: number;
}

export interface FixedTraceConfirmatoryClaimInput {
  /** One entry per observed paired evaluation; repeated IDs remain one case. */
  pairedCaseIds: readonly string[];
  observedSuperiorityPercentagePoints: number;
  observedNonInferiorityPercentagePoints: number;
}

export interface FixedTraceConfirmatoryClaimGate {
  independentEvaluableCaseCount: number;
  repeatedObservationCount: number;
  requiredIndependentEvaluableCaseCount: number;
  nominalMarginsReached: boolean;
  confirmatoryClaim: 'refused_underpowered' | 'refused_pending_evaluator_owned_paired_test';
}

/**
 * Counts only distinct paired case IDs. Crossing a nominal quality margin is
 * descriptive until the evaluator has both the predeclared sample and its
 * grouped/stratified case-level bootstrap, Holm correction, and exact paired
 * discordance test. This offline planner can never promote a candidate.
 */
export function evaluateFixedTraceConfirmatoryClaim(
  input: FixedTraceConfirmatoryClaimInput,
): FixedTraceConfirmatoryClaimGate {
  const snapshot = snapshotFixedTraceJson(input, 'confirmatory claim') as FixedTraceConfirmatoryClaimInput;
  assertExactKeys(snapshot, [
    'pairedCaseIds', 'observedSuperiorityPercentagePoints', 'observedNonInferiorityPercentagePoints',
  ], 'confirmatory claim');
  const pairedCaseIds = snapshot.pairedCaseIds;
  if (pairedCaseIds.some((caseId) => typeof caseId !== 'string' || !caseId.trim())) {
    throw new Error('Confirmatory paired case IDs must be nonblank strings');
  }
  if (!Number.isFinite(snapshot.observedSuperiorityPercentagePoints)
    || !Number.isFinite(snapshot.observedNonInferiorityPercentagePoints)) {
    throw new Error('Confirmatory observed margins must be finite');
  }
  const independentEvaluableCaseCount = new Set(pairedCaseIds).size;
  const repeatedObservationCount = pairedCaseIds.length - independentEvaluableCaseCount;
  const nominalMarginsReached = snapshot.observedSuperiorityPercentagePoints
    >= FIXED_TRACE_CONFIRMATORY_POWER_GATE.superiorityMarginPercentagePoints
    && snapshot.observedNonInferiorityPercentagePoints
      >= FIXED_TRACE_CONFIRMATORY_POWER_GATE.nonInferiorityMarginPercentagePoints;
  return Object.freeze({
    independentEvaluableCaseCount,
    repeatedObservationCount,
    requiredIndependentEvaluableCaseCount: FIXED_TRACE_CONFIRMATORY_POWER_GATE.requiredIndependentEvaluableCases,
    nominalMarginsReached,
    confirmatoryClaim: independentEvaluableCaseCount
      < FIXED_TRACE_CONFIRMATORY_POWER_GATE.requiredIndependentEvaluableCases
      ? 'refused_underpowered'
      : 'refused_pending_evaluator_owned_paired_test',
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Protocol contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Protocol contains a non-JSON value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
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

function pricing(profileId: string, pricingAsOf: string): FixedTraceProtocolPricingProfile {
  const profile = FIXED_TRACE_PROTOCOL_PRICING.find((candidate) => candidate.profileId === profileId);
  if (!profile) throw new Error(`Unavailable immutable pricing profile: ${profileId}`);
  const asOf = new Date(pricingAsOf);
  if (Number.isNaN(asOf.getTime()) || asOf >= new Date(profile.validBefore)) {
    throw new Error(`Stale immutable pricing profile: ${profileId}`);
  }
  validateFixedTracePricing(profile);
  return profile;
}

function assertStage(stage: FixedTraceProtocolStage, label: string, pricingAsOf: string): FixedTraceProtocolPricingProfile {
  assertExactKeys(stage, [
    'role', 'provider', 'model', 'reasoningEffort', 'pricingProfileId',
    'maxInputTokensPerInvocation', 'maxOutputTokensPerInvocation', 'timeoutMs',
    'maxInvocationsPerCase', 'transportRetries', 'samplingMode', 'temperature', 'cacheMode',
  ], label);
  positiveInteger(stage.maxInputTokensPerInvocation, `${label}.maxInputTokensPerInvocation`);
  positiveInteger(stage.maxOutputTokensPerInvocation, `${label}.maxOutputTokensPerInvocation`);
  positiveInteger(stage.timeoutMs, `${label}.timeoutMs`);
  positiveInteger(stage.maxInvocationsPerCase, `${label}.maxInvocationsPerCase`);
  if (stage.transportRetries !== 0 || stage.samplingMode !== 'provider_no_sampling_control' || stage.temperature !== null || stage.cacheMode !== 'disabled') {
    throw new Error(`${label} has an unsupported execution control`);
  }
  const resolved = pricing(stage.pricingProfileId, pricingAsOf);
  if (
    resolved.profileId !== stage.pricingProfileId
    || resolved.provider !== stage.provider
    || resolved.model !== stage.model
  ) throw new Error(`${label} pricing profile does not match its requested provider/model`);
  return resolved;
}

/**
 * Execution limits are evaluator-owned planning inputs, not caller-selected
 * estimates. Keep this matrix independent of the proposed protocol object so
 * a detached protocol supplied to an offline estimator cannot rewrite its
 * phase, admission, result-use, or stop conditions.
 */
const EVALUATOR_OWNED_PHASE_MATRIX = Object.freeze([
  Object.freeze({
    id: 'bounded_smoke', uniqueCaseCount: 8, repetitions: 1,
    arms: Object.freeze([Object.freeze({
      id: 'smoke-incumbent-two-stage', admission: 'planning_only',
      stopConditions: Object.freeze([['router', 1], ['generation', 12]] as const),
    })]),
  }),
  Object.freeze({
    id: 'router_screen', uniqueCaseCount: 46, repetitions: 3,
    arms: Object.freeze([Object.freeze({
      id: 'router-haiku-default', admission: 'planning_only',
      stopConditions: Object.freeze([['router', 1]] as const),
    })]),
  }),
  Object.freeze({
    id: 'oracle_generator_ceiling', uniqueCaseCount: 46, repetitions: 2,
    arms: Object.freeze([Object.freeze({
      id: 'oracle-sonnet-default', admission: 'planning_only',
      stopConditions: Object.freeze([['generation', 12]] as const),
    })]),
  }),
  Object.freeze({
    id: 'deployable_architecture', uniqueCaseCount: 46, repetitions: 3,
    arms: Object.freeze([
      Object.freeze({
        id: 'incumbent-haiku-sonnet', admission: 'planning_only',
        stopConditions: Object.freeze([['router', 1], ['generation', 12]] as const),
      }),
      Object.freeze({
        id: 'gemini-low-medium-pipeline', admission: 'planning_only',
        stopConditions: Object.freeze([['router', 1], ['generation', 12]] as const),
      }),
    ]),
  }),
  Object.freeze({
    id: 'controlled_tuning', uniqueCaseCount: 36, repetitions: 3,
    arms: Object.freeze([Object.freeze({
      id: 'tuning-incumbent-haiku-sonnet', admission: 'planning_only',
      stopConditions: Object.freeze([['router', 1], ['generation', 12]] as const),
    })]),
  }),
] as const);

function assertEvaluatorOwnedPhaseMatrix(phase: FixedTraceProtocolPhase, index: number): void {
  const expected = EVALUATOR_OWNED_PHASE_MATRIX[index];
  if (!expected
    || phase.id !== expected.id
    || phase.uniqueCaseCount !== expected.uniqueCaseCount
    || phase.repetitions !== expected.repetitions
    || phase.resultUse !== 'diagnostic_only') {
    throw new Error('Protocol phase does not match the evaluator-owned phase matrix');
  }
  if (phase.arms.length !== expected.arms.length) {
    throw new Error(`${phase.id} arms do not match the evaluator-owned phase matrix`);
  }
  for (let armIndex = 0; armIndex < phase.arms.length; armIndex += 1) {
    const arm = phase.arms[armIndex];
    const expectedArm = expected.arms[armIndex];
    if (!expectedArm || arm.id !== expectedArm.id || arm.admission !== expectedArm.admission) {
      throw new Error(`${phase.id} arm does not match the evaluator-owned admission matrix`);
    }
    if (arm.stages.length !== expectedArm.stopConditions.length || arm.stages.some((stage, stageIndex) => {
      const expectedStop = expectedArm.stopConditions[stageIndex];
      return !expectedStop
        || stage.role !== expectedStop[0]
        || stage.maxInvocationsPerCase !== expectedStop[1];
    })) {
      throw new Error(`${phase.id}.${arm.id} does not match the evaluator-owned stop-condition matrix`);
    }
  }
}

function assertArm(phase: FixedTraceProtocolPhase, arm: FixedTraceProtocolArm, pricingAsOf: string): void {
  assertExactKeys(arm, ['id', 'architecture', 'admission', 'stages'], `protocol arm`);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(arm.id)) throw new Error(`Invalid protocol arm ID: ${arm.id}`);
  const routers = arm.stages.filter((stage) => stage.role === 'router');
  const generations = arm.stages.filter((stage) => stage.role === 'generation');
  const judges = arm.stages.filter((stage) => stage.role === 'judge');
  if (phase.id === 'router_screen') {
    if (arm.architecture !== 'two_stage_llm_router' || routers.length !== 1 || generations.length !== 0 || judges.length !== 0) {
      throw new Error(`${arm.id} is not a router-only screening arm`);
    }
    assertStage(routers[0], `${arm.id}.router`, pricingAsOf);
    return;
  }
  if (generations.length !== 1 || routers.length > 1) throw new Error(`${arm.id} requires exactly one generation stage and at most one router`);
  if (arm.architecture === 'two_stage_llm_router') {
    if (routers.length !== 1) throw new Error(`${arm.id} requires a router stage`);
  } else if (arm.architecture !== 'oracle_route_diagnostic' || routers.length !== 0) {
    throw new Error(`${arm.id} direct and hybrid substitutions are not admitted`);
  }
  if (arm.architecture === 'oracle_route_diagnostic' && phase.id !== 'oracle_generator_ceiling') {
    throw new Error(`${arm.id} oracle routing is diagnostic-only`);
  }
  for (const stage of arm.stages) assertStage(stage, `${arm.id}.${stage.role}`, pricingAsOf);
  if (judges.length !== 0) throw new Error(`${arm.id} judges are blocked in the diagnostic-only protocol`);
}

function validatedProtocolSnapshot(protocol: FixedTraceEvaluationProtocol): FixedTraceEvaluationProtocol {
  const snapshot = snapshotFixedTraceJson(protocol, 'evaluation protocol') as FixedTraceEvaluationProtocol;
  assertFixedTraceEvaluationProtocolStructure(snapshot);
  return snapshot;
}

/** Fingerprints the exact detached projection which passed all protocol checks. */
export function fixedTraceEvaluationProtocolFingerprint(protocol: FixedTraceEvaluationProtocol): string {
  return sha256(validatedProtocolSnapshot(protocol));
}

/** Validate the planning projection without loading traces, credentials, or providers. */
function assertFixedTraceEvaluationProtocolStructure(protocol: FixedTraceEvaluationProtocol): void {
  assertExactKeys(protocol, [
    'version', 'id', 'trustedManifestId', 'pricingAsOf', 'contingencyBasisPoints',
    'unavailableFinalTarget', 'phases',
  ], 'evaluation protocol');
  if (protocol.version !== FIXED_TRACE_EVALUATION_PROTOCOL_VERSION || !protocol.id.trim() || !protocol.trustedManifestId.trim()) {
    throw new Error('Unsupported or incomplete fixed-trace evaluation protocol');
  }
  if (!Number.isSafeInteger(protocol.contingencyBasisPoints) || protocol.contingencyBasisPoints < 0 || protocol.contingencyBasisPoints > 10_000) {
    throw new Error('Protocol contingency basis points are invalid');
  }
  const phaseIds = new Set<string>();
  const armIds = new Set<string>();
  assertExactKeys(protocol.unavailableFinalTarget, ['availability', 'uniqueCaseCount', 'repetitions', 'missingCaseCount'], 'evaluation protocol.unavailableFinalTarget');
  if (protocol.unavailableFinalTarget.availability !== 'unavailable'
    || protocol.unavailableFinalTarget.uniqueCaseCount !== 38
    || protocol.unavailableFinalTarget.repetitions !== 3
    || protocol.unavailableFinalTarget.missingCaseCount !== 38) {
    throw new Error('Protocol unavailable final target is invalid');
  }
  if (protocol.phases.length !== EVALUATOR_OWNED_PHASE_MATRIX.length
    || protocol.phases.some((phase, index) => phase.id !== EVALUATOR_OWNED_PHASE_MATRIX[index]?.id)) {
    throw new Error('Protocol phases must use the exact required order');
  }
  for (const [index, phase] of protocol.phases.entries()) {
    assertExactKeys(phase, ['id', 'uniqueCaseCount', 'repetitions', 'resultUse', 'arms'], 'protocol phase');
    if (phaseIds.has(phase.id)) throw new Error(`Duplicate protocol phase: ${phase.id}`);
    phaseIds.add(phase.id);
    assertEvaluatorOwnedPhaseMatrix(phase, index);
    for (const arm of phase.arms) {
      if (armIds.has(arm.id)) throw new Error(`Duplicate protocol arm ID: ${arm.id}`);
      armIds.add(arm.id);
      assertArm(phase, arm, protocol.pricingAsOf);
    }
  }
  for (const required of EVALUATOR_OWNED_PHASE_MATRIX) {
    if (!phaseIds.has(required.id)) throw new Error(`Protocol is missing required phase: ${required.id}`);
  }
}

export function assertFixedTraceEvaluationProtocol(protocol: FixedTraceEvaluationProtocol): void {
  void validatedProtocolSnapshot(protocol);
}

/**
 * Future execution must supply evaluator-owned data. This check intentionally
 * does not make a JSON protocol file trusted by comparing it to itself.
 */
export function assertFixedTraceEvaluationProtocolTrusted(
  protocol: FixedTraceEvaluationProtocol,
  resolver: FixedTraceProtocolTrustedManifestResolver,
): FixedTraceProtocolTrustedManifest {
  void protocol;
  void resolver;
  throw new Error('Trusted evaluation manifest is locked pending evaluator-owned authentication');
}

export function fixedTraceEvaluationProtocolRunnerBinding(
  protocol: FixedTraceEvaluationProtocol,
  resolver: FixedTraceProtocolTrustedManifestResolver,
  phaseId: FixedTraceProtocolPhaseId,
  traceSuite: readonly FixedTraceCase[],
): FixedTraceProtocolRunnerBinding {
  void protocol;
  void resolver;
  void phaseId;
  void traceSuite;
  throw new Error('Fixed-trace execution is locked pending evaluator-owned authentication');
}

function stageEstimate(
  phase: FixedTraceProtocolPhase,
  arm: FixedTraceProtocolArm,
  stage: FixedTraceProtocolStage,
  pricingAsOf: string,
): FixedTraceProtocolStageEstimate {
  const profile = assertStage(stage, `${phase.id}.${arm.id}.${stage.role}`, pricingAsOf);
  const requests = phase.uniqueCaseCount * phase.repetitions * stage.maxInvocationsPerCase;
  const inputTokenCeiling = requests * stage.maxInputTokensPerInvocation;
  const outputTokenCeiling = requests * stage.maxOutputTokensPerInvocation;
  const ceilingUsd = fixedTraceEstimatedCostUsd({
    inputTokens: inputTokenCeiling,
    outputTokens: outputTokenCeiling,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }, profile);
  return Object.freeze({
    phaseId: phase.id,
    armId: arm.id,
    role: stage.role,
    provider: stage.provider,
    model: stage.model,
    reasoningEffort: stage.reasoningEffort,
    pricingProfileId: profile.profileId,
    cacheMode: stage.cacheMode,
    cacheSemantics: Object.freeze({
      cacheReadAccounting: profile.cacheReadAccounting,
      cacheWriteAccounting: profile.cacheWriteAccounting,
    }),
    requests,
    inputTokenCeiling,
    outputTokenCeiling,
    ceilingUsd,
  });
}

/**
 * Pure deterministic diagnostic projection. It makes no provider calls, reads
 * no trace body, and writes no output. `expectedSpendUsd` stays null because
 * observed tokenization and tool-loop length are deliberately not guessed.
 */
export function estimateFixedTraceEvaluationProtocol(protocol: FixedTraceEvaluationProtocol): FixedTraceProtocolEstimate {
  const snapshot = validatedProtocolSnapshot(protocol);
  const stages = snapshot.phases.flatMap((phase) => phase.arms.flatMap((arm) =>
    arm.stages.map((stage) => stageEstimate(phase, arm, stage, snapshot.pricingAsOf))));
  const phases = snapshot.phases.map((phase) => {
    const entries = stages.filter((entry) => entry.phaseId === phase.id);
    const candidate = entries.filter((entry) => entry.role !== 'judge');
    const judges = entries.filter((entry) => entry.role === 'judge');
    const candidateCeilingUsd = candidate.reduce((total, entry) => total + entry.ceilingUsd, 0);
    const judgeCeilingUsd = judges.reduce((total, entry) => total + entry.ceilingUsd, 0);
    return Object.freeze({
      phaseId: phase.id,
      uniqueCaseCount: phase.uniqueCaseCount,
      repetitions: phase.repetitions,
      candidateCalls: candidate.reduce((total, entry) => total + entry.requests, 0),
      judgeCalls: judges.reduce((total, entry) => total + entry.requests, 0),
      candidateCeilingUsd,
      judgeCeilingUsd,
      totalCeilingUsd: candidateCeilingUsd + judgeCeilingUsd,
    });
  });
  const candidateCeilingUsd = phases.reduce((total, phase) => total + phase.candidateCeilingUsd, 0);
  const judgeCeilingUsd = phases.reduce((total, phase) => total + phase.judgeCeilingUsd, 0);
  const contingencyUsd = (candidateCeilingUsd + judgeCeilingUsd) * snapshot.contingencyBasisPoints / 10_000;
  const summarize = (source: readonly FixedTraceProtocolPhaseEstimate[]) => Object.freeze({
    candidateCeilingUsd: source.reduce((total, phase) => total + phase.candidateCeilingUsd, 0),
    judgeCeilingUsd: source.reduce((total, phase) => total + phase.judgeCeilingUsd, 0),
    totalCeilingUsd: source.reduce((total, phase) => total + phase.totalCeilingUsd, 0),
  });
  return Object.freeze({
    protocolFingerprint: sha256(snapshot),
    dispatchable: false,
    expectedSpendUsd: null,
    stages: Object.freeze(stages),
    phases: Object.freeze(phases),
    screening: summarize(phases),
    unavailableFinalTarget: snapshot.unavailableFinalTarget,
    budgetProjection: Object.freeze({
      screeningTuning: Object.freeze({
        uniqueEvaluableCaseCount: FIXED_TRACE_CONFIRMATORY_POWER_GATE.currentScreeningTuningUniqueCaseCount,
        repetitionsCountAsIndependentCases: false,
        expectedSpendUsd: null,
        approvalCeilingUsd: null,
      }),
      confirmatory: Object.freeze({
        requiredIndependentEvaluableCaseCount: FIXED_TRACE_CONFIRMATORY_POWER_GATE.requiredIndependentEvaluableCases,
        unavailableTargetCaseCount: snapshot.unavailableFinalTarget.uniqueCaseCount,
        expectedSpendUsd: null,
        approvalCeilingUsd: null,
        spendAuthorization: 'refused_pending_evaluator_owned_paired_test',
      }),
    }),
    candidateCeilingUsd,
    judgeCeilingUsd,
    contingencyUsd,
    totalCeilingUsd: candidateCeilingUsd + judgeCeilingUsd + contingencyUsd,
  });
}

const router = (
  provider: ModelProviderId,
  model: string,
  reasoningEffort: ModelReasoningEffort,
  pricingProfileId: string,
): FixedTraceProtocolStage => ({
  role: 'router', provider, model, reasoningEffort, pricingProfileId,
  maxInputTokensPerInvocation: 4_096, maxOutputTokensPerInvocation: 300,
  timeoutMs: 120_000, maxInvocationsPerCase: 1, transportRetries: 0,
  samplingMode: 'provider_no_sampling_control', temperature: null, cacheMode: 'disabled',
});

const generation = (
  provider: ModelProviderId,
  model: string,
  reasoningEffort: ModelReasoningEffort,
  pricingProfileId: string,
): FixedTraceProtocolStage => ({
  role: 'generation', provider, model, reasoningEffort, pricingProfileId,
  maxInputTokensPerInvocation: 16_384, maxOutputTokensPerInvocation: 900,
  timeoutMs: 120_000, maxInvocationsPerCase: 12, transportRetries: 0,
  samplingMode: 'provider_no_sampling_control', temperature: null, cacheMode: 'disabled',
});

const PRICE = Object.freeze({
  haiku: `${CLAUDE_PRICING_VERSION}:claude-haiku-4-5`,
  sonnet: `${CLAUDE_PRICING_VERSION}:claude-sonnet-5`,
  gemini: `${GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION}:gemini-3.7-flash`,
});

/** Unsupported model names are inert metadata, never a stage or a price. */
export const FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES = Object.freeze([
  Object.freeze({ provider: 'openai' as const, model: 'gpt-5.6-terra', dispatchable: false as const, trustedPrice: null }),
  Object.freeze({ provider: 'openai' as const, model: 'gpt-5.6-sol', dispatchable: false as const, trustedPrice: null }),
]);

/** A closed, diagnostic-only projection with no promotion or execution path. */
export const FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL: FixedTraceEvaluationProtocol = deepFreezeFixedTrace({
  version: FIXED_TRACE_EVALUATION_PROTOCOL_VERSION,
  id: 'addie-6842-6846-staged-v1',
  trustedManifestId: 'externally-owned-addie-fixed-trace-v120',
  pricingAsOf: '2026-09-05T12:00:00.000Z',
  contingencyBasisPoints: 0,
  unavailableFinalTarget: {
    availability: 'unavailable', uniqueCaseCount: 38, repetitions: 3, missingCaseCount: 38,
  },
  phases: Object.freeze([
    Object.freeze({
      id: 'bounded_smoke', uniqueCaseCount: 8, repetitions: 1, resultUse: 'diagnostic_only',
      arms: Object.freeze([Object.freeze({
        id: 'smoke-incumbent-two-stage', architecture: 'two_stage_llm_router', admission: 'planning_only',
        stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku),
          generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet),
        ]),
      })]),
    }),
    Object.freeze({
      id: 'router_screen', uniqueCaseCount: 46, repetitions: 3, resultUse: 'diagnostic_only',
      arms: Object.freeze([Object.freeze({ id: 'router-haiku-default', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku)]) })]),
    }),
    Object.freeze({
      id: 'oracle_generator_ceiling', uniqueCaseCount: 46, repetitions: 2, resultUse: 'diagnostic_only',
      arms: Object.freeze([Object.freeze({ id: 'oracle-sonnet-default', architecture: 'oracle_route_diagnostic' as const, admission: 'planning_only' as const, stages: Object.freeze([generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet)]) })]),
    }),
    Object.freeze({
      id: 'deployable_architecture', uniqueCaseCount: 46, repetitions: 3, resultUse: 'diagnostic_only',
      arms: Object.freeze([
        Object.freeze({ id: 'incumbent-haiku-sonnet', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku),
          generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet),
        ]) }),
        Object.freeze({ id: 'gemini-low-medium-pipeline', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('google', 'gemini-3.7-flash', 'low', PRICE.gemini),
          generation('google', 'gemini-3.7-flash', 'medium', PRICE.gemini),
        ]) }),
      ]),
    }),
    Object.freeze({
      id: 'controlled_tuning', uniqueCaseCount: 36, repetitions: 3, resultUse: 'diagnostic_only',
      arms: Object.freeze([
        Object.freeze({ id: 'tuning-incumbent-haiku-sonnet', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku), generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet),
        ]) }),
      ]),
    }),
  ]),
});
