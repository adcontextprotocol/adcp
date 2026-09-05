import { createHash } from 'node:crypto';
import type { ModelProviderId, ModelReasoningEffort } from '../model-providers/model-provider.js';
import {
  GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION,
  OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS,
  OPENAI_GPT_5_6_PRICING_VERSION,
} from '../model-cost-pricing.js';
import { CLAUDE_PRICING_VERSION } from '../claude-pricing.js';
import {
  fixedTraceEstimatedCostUsd,
  validateFixedTracePricing,
} from './fixed-trace-budget.js';
import type { FixedTracePricing } from './fixed-trace-suite.js';

/**
 * A planning-only contract. It has no dispatcher and is deliberately unable
 * to make a corpus, an execution envelope, or a sealed holdout trusted.
 */
export const FIXED_TRACE_EVALUATION_PROTOCOL_VERSION =
  'addie-fixed-trace-evaluation-protocol-v1' as const;

export type FixedTraceProtocolPhaseId =
  | 'bounded_smoke'
  | 'router_screen'
  | 'oracle_generator_ceiling'
  | 'deployable_architecture'
  | 'controlled_tuning'
  | 'sealed_final';

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
  ...(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const).map((model) => Object.freeze({
    provider: 'openai' as const,
    model,
    profileId: `${OPENAI_GPT_5_6_PRICING_VERSION}:${model}`,
    version: OPENAI_GPT_5_6_PRICING_VERSION,
    validBefore: '2026-09-06T00:00:00.000Z',
    inputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS[model].inputUsd,
    outputUsdPerMillionTokens: OPENAI_GPT_5_6_PRICING_PER_MILLION_TOKENS[model].outputUsd,
    // The repository price pin contains no reviewed OpenAI cache profile.
    // A cache hit is therefore outside this contract and fails execution
    // admission rather than receiving a guessed discount or surcharge.
    cacheReadUsdPerMillionTokens: null,
    cacheWriteUsdPerMillionTokens: null,
    cacheReadAccounting: 'unsupported',
    cacheWriteAccounting: 'unsupported',
    source: 'Repository immutable OpenAI standard pricing pin, reviewed 2026-09-05.',
  })),
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
  /** Whether this phase may choose a later candidate, never promote one. */
  resultUse: 'smoke_only' | 'component_screening' | 'diagnostic' | 'selective' | 'promotional';
  arms: readonly FixedTraceProtocolArm[];
}

export interface FixedTraceEvaluationProtocol {
  version: typeof FIXED_TRACE_EVALUATION_PROTOCOL_VERSION;
  id: string;
  /** This identifier must be resolved by a future evaluator-owned coordinator. */
  trustedManifestId: string;
  pricingAsOf: string;
  contingencyBasisPoints: number;
  phases: readonly FixedTraceProtocolPhase[];
}

export interface FixedTraceProtocolTrustedManifest {
  id: string;
  protocolFingerprint: string;
  sourceId: string;
  sourceRevision: string;
  /**
   * Evaluator-owned digest of the actual subset passed to the runner. It is
   * not a canonical-suite constant and must be supplied as the repaired
   * runner's `traceSuiteSha256` config before dispatch; post-hoc observation
   * restamping is forbidden.
   */
  traceSuiteSha256: string;
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
  finalConfirmation: { candidateCeilingUsd: number; judgeCeilingUsd: number; totalCeilingUsd: number };
  candidateCeilingUsd: number;
  judgeCeilingUsd: number;
  contingencyUsd: number;
  totalCeilingUsd: number;
  /** Round only upward to cents for an approvable provider-spend cap. */
  approvalCeilingUsd: number;
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

function roundUpToCents(value: number): number {
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
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

function candidateProviders(arm: FixedTraceProtocolArm): Set<ModelProviderId> {
  return new Set(arm.stages.filter((stage) => stage.role !== 'judge').map((stage) => stage.provider));
}

function assertArm(phase: FixedTraceProtocolPhase, arm: FixedTraceProtocolArm, pricingAsOf: string): void {
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
  if (arm.architecture === 'two_stage_llm_router' || arm.architecture === 'hybrid_safe_signal_then_llm') {
    if (routers.length !== 1) throw new Error(`${arm.id} requires a router stage`);
  } else if (routers.length !== 0) {
    throw new Error(`${arm.id} must not contain a router stage`);
  }
  if (arm.architecture === 'oracle_route_diagnostic' && phase.id !== 'oracle_generator_ceiling') {
    throw new Error(`${arm.id} oracle routing is diagnostic-only`);
  }
  for (const stage of arm.stages) assertStage(stage, `${arm.id}.${stage.role}`, pricingAsOf);
  if (phase.id !== 'bounded_smoke') {
    if (judges.length !== 2) throw new Error(`${arm.id} requires exactly two blinded judges`);
    const candidates = candidateProviders(arm);
    const judgeProviders = new Set(judges.map((judge) => judge.provider));
    if (judgeProviders.size !== 2 || [...judgeProviders].some((provider) => candidates.has(provider))) {
      throw new Error(`${arm.id} judges are not provider-independent`);
    }
  } else if (judges.length !== 0) {
    throw new Error(`${arm.id} smoke arm must not dispatch judges`);
  }
}

/** Fingerprints every material execution and budget control; no resolver is trusted here. */
export function fixedTraceEvaluationProtocolFingerprint(protocol: FixedTraceEvaluationProtocol): string {
  return sha256(protocol);
}

/** Validate the planning projection without loading traces, credentials, or providers. */
export function assertFixedTraceEvaluationProtocol(protocol: FixedTraceEvaluationProtocol): void {
  if (protocol.version !== FIXED_TRACE_EVALUATION_PROTOCOL_VERSION || !protocol.id.trim() || !protocol.trustedManifestId.trim()) {
    throw new Error('Unsupported or incomplete fixed-trace evaluation protocol');
  }
  if (!Number.isSafeInteger(protocol.contingencyBasisPoints) || protocol.contingencyBasisPoints < 0 || protocol.contingencyBasisPoints > 10_000) {
    throw new Error('Protocol contingency basis points are invalid');
  }
  const phaseIds = new Set<string>();
  const armIds = new Set<string>();
  for (const phase of protocol.phases) {
    if (phaseIds.has(phase.id)) throw new Error(`Duplicate protocol phase: ${phase.id}`);
    phaseIds.add(phase.id);
    positiveInteger(phase.uniqueCaseCount, `${phase.id}.uniqueCaseCount`);
    positiveInteger(phase.repetitions, `${phase.id}.repetitions`);
    if (!phase.arms.length) throw new Error(`${phase.id} requires at least one arm`);
    for (const arm of phase.arms) {
      if (armIds.has(arm.id)) throw new Error(`Duplicate protocol arm ID: ${arm.id}`);
      armIds.add(arm.id);
      assertArm(phase, arm, protocol.pricingAsOf);
    }
  }
  for (const required of ['bounded_smoke', 'router_screen', 'oracle_generator_ceiling', 'deployable_architecture', 'controlled_tuning', 'sealed_final'] as const) {
    if (!phaseIds.has(required)) throw new Error(`Protocol is missing required phase: ${required}`);
  }
}

/**
 * Future execution must supply evaluator-owned data. This check intentionally
 * does not make a JSON protocol file trusted by comparing it to itself.
 */
export function assertFixedTraceEvaluationProtocolTrusted(
  protocol: FixedTraceEvaluationProtocol,
  resolver: FixedTraceProtocolTrustedManifestResolver,
): FixedTraceProtocolTrustedManifest {
  assertFixedTraceEvaluationProtocol(protocol);
  const trusted = resolver(protocol.trustedManifestId);
  if (!trusted) throw new Error(`Trusted evaluation manifest is unavailable: ${protocol.trustedManifestId}`);
  if (
    trusted.id !== protocol.trustedManifestId
    || trusted.protocolFingerprint !== fixedTraceEvaluationProtocolFingerprint(protocol)
    || !trusted.sourceId.trim()
    || !trusted.sourceRevision.trim()
    || !/^[a-f0-9]{64}$/.test(trusted.traceSuiteSha256)
    || !/^[a-f0-9]{64}$/.test(trusted.tracePackSha256)
    || !trusted.rawLedgerVersion.trim()
  ) throw new Error('Trusted evaluation manifest does not bind this protocol');
  for (const phase of protocol.phases) {
    if (trusted.partitions[phase.id] !== phase.uniqueCaseCount) {
      throw new Error(`Trusted evaluation manifest count mismatch for ${phase.id}`);
    }
    if (phase.arms.some((arm) => arm.admission !== 'planning_only' && !trusted.verifiedAdmissions.includes(arm.admission))) {
      throw new Error(`Trusted evaluation manifest lacks an execution admission for ${phase.id}`);
    }
  }
  return trusted;
}

export function fixedTraceEvaluationProtocolRunnerBinding(
  protocol: FixedTraceEvaluationProtocol,
  resolver: FixedTraceProtocolTrustedManifestResolver,
): FixedTraceProtocolRunnerBinding {
  const trusted = assertFixedTraceEvaluationProtocolTrusted(protocol, resolver);
  return Object.freeze({
    trustedManifestId: trusted.id,
    protocolFingerprint: trusted.protocolFingerprint,
    traceSuiteSha256: trusted.traceSuiteSha256,
  });
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
 * Pure deterministic approval projection. It makes no provider calls, reads
 * no trace body, and writes no output. `expectedSpendUsd` stays null because
 * observed tokenization and tool-loop length are deliberately not guessed.
 */
export function estimateFixedTraceEvaluationProtocol(protocol: FixedTraceEvaluationProtocol): FixedTraceProtocolEstimate {
  assertFixedTraceEvaluationProtocol(protocol);
  const stages = protocol.phases.flatMap((phase) => phase.arms.flatMap((arm) =>
    arm.stages.map((stage) => stageEstimate(phase, arm, stage, protocol.pricingAsOf))));
  const phases = protocol.phases.map((phase) => {
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
  const screeningPhases = phases.filter((phase) => phase.phaseId !== 'sealed_final');
  const finalPhase = phases.find((phase) => phase.phaseId === 'sealed_final')!;
  const candidateCeilingUsd = phases.reduce((total, phase) => total + phase.candidateCeilingUsd, 0);
  const judgeCeilingUsd = phases.reduce((total, phase) => total + phase.judgeCeilingUsd, 0);
  const contingencyUsd = (candidateCeilingUsd + judgeCeilingUsd) * protocol.contingencyBasisPoints / 10_000;
  const summarize = (source: readonly FixedTraceProtocolPhaseEstimate[]) => Object.freeze({
    candidateCeilingUsd: source.reduce((total, phase) => total + phase.candidateCeilingUsd, 0),
    judgeCeilingUsd: source.reduce((total, phase) => total + phase.judgeCeilingUsd, 0),
    totalCeilingUsd: source.reduce((total, phase) => total + phase.totalCeilingUsd, 0),
  });
  return Object.freeze({
    protocolFingerprint: fixedTraceEvaluationProtocolFingerprint(protocol),
    dispatchable: false,
    expectedSpendUsd: null,
    stages: Object.freeze(stages),
    phases: Object.freeze(phases),
    screening: summarize(screeningPhases),
    finalConfirmation: summarize([finalPhase]),
    candidateCeilingUsd,
    judgeCeilingUsd,
    contingencyUsd,
    totalCeilingUsd: candidateCeilingUsd + judgeCeilingUsd + contingencyUsd,
    approvalCeilingUsd: roundUpToCents(candidateCeilingUsd + judgeCeilingUsd + contingencyUsd),
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

const judge = (
  provider: ModelProviderId,
  model: string,
  reasoningEffort: ModelReasoningEffort,
  pricingProfileId: string,
): FixedTraceProtocolStage => ({
  role: 'judge', provider, model, reasoningEffort, pricingProfileId,
  maxInputTokensPerInvocation: 8_192, maxOutputTokensPerInvocation: 600,
  timeoutMs: 60_000, maxInvocationsPerCase: 1, transportRetries: 0,
  samplingMode: 'provider_no_sampling_control', temperature: null, cacheMode: 'disabled',
});

const PRICE = Object.freeze({
  haiku: `${CLAUDE_PRICING_VERSION}:claude-haiku-4-5`,
  sonnet: `${CLAUDE_PRICING_VERSION}:claude-sonnet-5`,
  luna: `${OPENAI_GPT_5_6_PRICING_VERSION}:gpt-5.6-luna`,
  terra: `${OPENAI_GPT_5_6_PRICING_VERSION}:gpt-5.6-terra`,
  sol: `${OPENAI_GPT_5_6_PRICING_VERSION}:gpt-5.6-sol`,
  gemini: `${GOOGLE_GEMINI_3_7_FLASH_PRICING_VERSION}:gemini-3.7-flash`,
});

const sonnetAndGeminiJudges = Object.freeze([
  judge('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet),
  judge('google', 'gemini-3.7-flash', 'low', PRICE.gemini),
]);
const terraAndGeminiJudges = Object.freeze([
  judge('openai', 'gpt-5.6-terra', 'low', PRICE.terra),
  judge('google', 'gemini-3.7-flash', 'low', PRICE.gemini),
]);
const terraAndSonnetJudges = Object.freeze([
  judge('openai', 'gpt-5.6-terra', 'low', PRICE.terra),
  judge('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet),
]);

interface RouterScreenConfiguration {
  id: string;
  provider: ModelProviderId;
  model: string;
  effort: ModelReasoningEffort;
  pricingProfileId: string;
}

interface OracleGeneratorConfiguration extends RouterScreenConfiguration {
  judges: readonly FixedTraceProtocolStage[];
}

const ROUTER_SCREEN_CONFIGURATIONS: readonly RouterScreenConfiguration[] = Object.freeze([
  { id: 'router-haiku-default', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'provider_default', pricingProfileId: PRICE.haiku },
  { id: 'router-luna-none', provider: 'openai', model: 'gpt-5.6-luna', effort: 'none', pricingProfileId: PRICE.luna },
  { id: 'router-luna-low', provider: 'openai', model: 'gpt-5.6-luna', effort: 'low', pricingProfileId: PRICE.luna },
  { id: 'router-terra-none', provider: 'openai', model: 'gpt-5.6-terra', effort: 'none', pricingProfileId: PRICE.terra },
  { id: 'router-terra-low', provider: 'openai', model: 'gpt-5.6-terra', effort: 'low', pricingProfileId: PRICE.terra },
  { id: 'router-gemini-low', provider: 'google', model: 'gemini-3.7-flash', effort: 'low', pricingProfileId: PRICE.gemini },
]);

const ORACLE_GENERATOR_CONFIGURATIONS: readonly OracleGeneratorConfiguration[] = Object.freeze([
  { id: 'oracle-sonnet-default', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'provider_default', pricingProfileId: PRICE.sonnet, judges: terraAndGeminiJudges },
  { id: 'oracle-sonnet-medium', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', pricingProfileId: PRICE.sonnet, judges: terraAndGeminiJudges },
  { id: 'oracle-terra-low', provider: 'openai', model: 'gpt-5.6-terra', effort: 'low', pricingProfileId: PRICE.terra, judges: sonnetAndGeminiJudges },
  { id: 'oracle-terra-medium', provider: 'openai', model: 'gpt-5.6-terra', effort: 'medium', pricingProfileId: PRICE.terra, judges: sonnetAndGeminiJudges },
  { id: 'oracle-sol-low', provider: 'openai', model: 'gpt-5.6-sol', effort: 'low', pricingProfileId: PRICE.sol, judges: sonnetAndGeminiJudges },
  { id: 'oracle-sol-medium', provider: 'openai', model: 'gpt-5.6-sol', effort: 'medium', pricingProfileId: PRICE.sol, judges: sonnetAndGeminiJudges },
  { id: 'oracle-gemini-medium', provider: 'google', model: 'gemini-3.7-flash', effort: 'medium', pricingProfileId: PRICE.gemini, judges: terraAndSonnetJudges },
]);

/**
 * The exact conservative approval projection. It is intentionally
 * non-dispatchable until a future evaluator-owned trusted manifest binds the
 * real 46/36/38 corpus, raw ledger, and direct/hybrid execution contracts.
 */
export const FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL: FixedTraceEvaluationProtocol = Object.freeze({
  version: FIXED_TRACE_EVALUATION_PROTOCOL_VERSION,
  id: 'addie-6842-6846-staged-v1',
  trustedManifestId: 'externally-owned-addie-fixed-trace-v120',
  pricingAsOf: '2026-09-05T12:00:00.000Z',
  contingencyBasisPoints: 1_500,
  phases: Object.freeze([
    Object.freeze({
      id: 'bounded_smoke', uniqueCaseCount: 8, repetitions: 1, resultUse: 'smoke_only',
      arms: Object.freeze([Object.freeze({
        id: 'smoke-incumbent-two-stage', architecture: 'two_stage_llm_router', admission: 'planning_only',
        stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku),
          generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet),
        ]),
      })]),
    }),
    Object.freeze({
      id: 'router_screen', uniqueCaseCount: 46, repetitions: 3, resultUse: 'component_screening',
      arms: Object.freeze(ROUTER_SCREEN_CONFIGURATIONS.map((configuration) => Object.freeze({
        id: configuration.id, architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const,
        stages: Object.freeze([router(configuration.provider, configuration.model, configuration.effort, configuration.pricingProfileId)]),
      }))),
    }),
    Object.freeze({
      id: 'oracle_generator_ceiling', uniqueCaseCount: 46, repetitions: 2, resultUse: 'diagnostic',
      arms: Object.freeze(ORACLE_GENERATOR_CONFIGURATIONS.map((configuration) => Object.freeze({
        id: configuration.id, architecture: 'oracle_route_diagnostic' as const, admission: 'planning_only' as const,
        stages: Object.freeze([
          generation(configuration.provider, configuration.model, configuration.effort, configuration.pricingProfileId),
          ...configuration.judges,
        ]),
      }))),
    }),
    Object.freeze({
      id: 'deployable_architecture', uniqueCaseCount: 46, repetitions: 3, resultUse: 'selective',
      arms: Object.freeze([
        Object.freeze({ id: 'incumbent-haiku-sonnet', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku),
          generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet), ...terraAndGeminiJudges,
        ]) }),
        Object.freeze({ id: 'openai-luna-low-terra-medium', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('openai', 'gpt-5.6-luna', 'low', PRICE.luna),
          generation('openai', 'gpt-5.6-terra', 'medium', PRICE.terra), ...sonnetAndGeminiJudges,
        ]) }),
        Object.freeze({ id: 'hybrid-safe-signal-luna-terra', architecture: 'hybrid_safe_signal_then_llm' as const, admission: 'requires_verified_hybrid_contract' as const, stages: Object.freeze([
          router('openai', 'gpt-5.6-luna', 'low', PRICE.luna),
          generation('openai', 'gpt-5.6-terra', 'medium', PRICE.terra), ...sonnetAndGeminiJudges,
        ]) }),
        Object.freeze({ id: 'openai-luna-low-sol-medium', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('openai', 'gpt-5.6-luna', 'low', PRICE.luna),
          generation('openai', 'gpt-5.6-sol', 'medium', PRICE.sol), ...sonnetAndGeminiJudges,
        ]) }),
        Object.freeze({ id: 'gemini-low-medium-pipeline', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('google', 'gemini-3.7-flash', 'low', PRICE.gemini),
          generation('google', 'gemini-3.7-flash', 'medium', PRICE.gemini), ...terraAndSonnetJudges,
        ]) }),
        Object.freeze({ id: 'direct-bounded-terra-medium', architecture: 'direct_bounded_production_shaped' as const, admission: 'requires_verified_direct_contract' as const, stages: Object.freeze([
          generation('openai', 'gpt-5.6-terra', 'medium', PRICE.terra), ...sonnetAndGeminiJudges,
        ]) }),
      ]),
    }),
    Object.freeze({
      id: 'controlled_tuning', uniqueCaseCount: 36, repetitions: 3, resultUse: 'selective',
      arms: Object.freeze([
        Object.freeze({ id: 'tuning-incumbent-haiku-sonnet', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku), generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet), ...terraAndGeminiJudges,
        ]) }),
        Object.freeze({ id: 'tuning-openai-luna-terra', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('openai', 'gpt-5.6-luna', 'low', PRICE.luna), generation('openai', 'gpt-5.6-terra', 'medium', PRICE.terra), ...sonnetAndGeminiJudges,
        ]) }),
      ]),
    }),
    Object.freeze({
      id: 'sealed_final', uniqueCaseCount: 38, repetitions: 3, resultUse: 'promotional',
      arms: Object.freeze([
        Object.freeze({ id: 'final-incumbent-haiku-sonnet', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('anthropic', 'claude-haiku-4-5', 'provider_default', PRICE.haiku), generation('anthropic', 'claude-sonnet-5', 'provider_default', PRICE.sonnet), ...terraAndGeminiJudges,
        ]) }),
        Object.freeze({ id: 'final-openai-luna-terra', architecture: 'two_stage_llm_router' as const, admission: 'planning_only' as const, stages: Object.freeze([
          router('openai', 'gpt-5.6-luna', 'low', PRICE.luna), generation('openai', 'gpt-5.6-terra', 'medium', PRICE.terra), ...sonnetAndGeminiJudges,
        ]) }),
      ]),
    }),
  ]),
});
