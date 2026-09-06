import { createHash } from 'node:crypto';
import { FIXED_TRACE_DIRECT_TOOL_UNIVERSE } from '../direct-tool-universe.js';
import { ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION } from '../request-tool-replay-binding.js';
import {
  datedPricingReservationCostUsd,
  pricingProfileForCandidate,
  resolveCurrentEvaluationPricingCohort,
  type DatedPricingCohort,
  type DatedPricingProfile,
  type EvaluationPricingCandidateId,
} from './dated-pricing-cohort.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PARENT_IDS,
  FIXED_TRACE_COMPONENT_SMOKE_PROBES,
  assertFixedTraceComponentSmokeContracts,
} from './fixed-trace-smoke-overlays.js';
import {
  FIXED_TRACE_EXPERIMENTAL_DESIGN,
  assertFixedTraceExperimentalDesign,
  fixedTraceExperimentalDesignFingerprint,
} from './fixed-trace-experimental-design.js';
import {
  FIXED_TRACE_ADMITTED_CELLS,
  FIXED_TRACE_COMPONENT_SMOKE_PLAN,
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT,
  assertFixedTraceEvaluationProtocol,
  fixedTraceEvaluationProtocolFingerprint,
} from './fixed-trace-evaluation-protocol.js';
import {
  FIXED_TRACE_PARTITION_MANIFEST_SHA256,
  assertFixedTracePartitionManifest,
} from './fixed-trace-partition.js';
import { snapshotFixedTraceJson } from './fixed-trace-safe-snapshot.js';
import {
  FIXED_TRACE_CORPUS,
  FIXED_TRACE_STAGE_CONTROL_VERSION,
  fixedTraceCorpusSha256,
} from './fixed-trace-suite.js';

/**
 * Stage 1 is admitted against this pinned instant, never an ambient clock.
 * A later paid-run coordinator must obtain a fresh admission rather than
 * treating this static review as a live authorization.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF = '2026-09-06T00:00:00.000Z' as const;
export const FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION =
  'addie-fixed-trace-component-smoke-admission-v1' as const;

export type FixedTraceComponentSmokeAdmissionReason =
  | 'component_probe_contract_invalid'
  | 'component_probe_set_mismatch'
  | 'component_cell_set_mismatch'
  | 'component_plan_mismatch'
  | 'component_pricing_unavailable'
  | 'component_pricing_cell_mismatch'
  | 'component_budget_ceiling_exceeded'
  | 'component_protocol_or_design_invalid';

export interface FixedTraceComponentSmokeAdmissionManifest {
  readonly version: typeof FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION;
  readonly asOf: typeof FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF;
  readonly status: 'ready_for_explicit_paid_authorization' | 'not_admitted';
  readonly missingReasons: readonly FixedTraceComponentSmokeAdmissionReason[];
  readonly probes: readonly { readonly id: string; readonly semanticSha256: string; readonly parentId: string; readonly parentSemanticSha256: string }[];
  readonly cells: readonly { readonly id: string; readonly role: 'router' | 'generation'; readonly provider: string; readonly model: string; readonly effort: string; readonly pricingProfileId: string }[];
  readonly cardinality: Readonly<{
    probes: 8;
    routerCells: 10;
    generationCells: 11;
    totalCells: 21;
    repetitions: 1;
    caseCellAssignments: 168;
    maximumProviderInvocations: 256;
  }>;
  readonly pricing: Readonly<{
    cohortDigest: string | null;
    checkedAt: string | null;
    profiles: readonly { readonly candidateId: string; readonly profileId: string; readonly effectiveFrom: string; readonly effectiveBefore: string | null }[];
    maximumReservationUsd: number | null;
    providerCeilingUsd: 5;
  }>;
  readonly fingerprints: Readonly<{
    protocol: string;
    corpus: string;
    partition: string;
    experimentalDesign: string;
    screeningConfiguration: string;
    stageControlVersion: string;
    requestAssemblyPolicyVersion: string;
    requestAssemblyPolicySha256: string;
    toolNamesSha256: string;
    toolSchemaSha256: string;
    toolDefinitionHandlerSha256: string;
    probeSetSha256: string;
  }>;
  readonly budgetReservation: Readonly<{
    policy: 'evaluator_owned_per_authorization_private_ledger_required';
    replay: 'one_use_external_authorization_required_no_caller_ledger_or_reservation';
    concurrency: 'exclusive_reservation_required_before_any_provider_dispatch';
    unknownExposure: 'preserved_in_spend_and_denominator_then_admission_closed';
  }>;
  readonly dispatch: Readonly<{
    defaultOff: true;
    currentModuleCanDispatch: false;
    ambientEnvironmentAuthority: false;
    requiredAuthorization: 'explicit_one_use_external_paid_authorization';
  }>;
  readonly evidence: Readonly<{
    permittedClaims: 'mechanical_feasibility_only';
    permanentlyNonPromotable: true;
    prohibitedClaims: readonly string[];
  }>;
  readonly denominator: Readonly<{
    unit: 'case_cell_assignment_and_each_provider_invocation';
    prepared: 'included';
    dispatched: 'included';
    failed: 'included';
    unknownExposure: 'included_and_spend_reserved';
    omissions: 'failure';
  }>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite canonical value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('non-JSON canonical value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function candidateIdFor(profile: Pick<DatedPricingProfile, 'provider' | 'model'>): EvaluationPricingCandidateId | null {
  if (profile.provider === 'anthropic' && profile.model === 'claude-haiku-4-5') return 'anthropic-router';
  if (profile.provider === 'anthropic' && profile.model === 'claude-sonnet-5') return 'anthropic-generation';
  if (profile.provider === 'openai' && profile.model === 'gpt-5.6-luna') return 'openai-router-generator';
  if (profile.provider === 'google' && profile.model === 'gemini-3.7-flash') return 'google-router-generator';
  return null;
}

function maximumReservationUsd(cohort: DatedPricingCohort): number {
  return FIXED_TRACE_ADMITTED_CELLS.reduce((total, cell) => {
    const candidateId = candidateIdFor(cell);
    if (!candidateId) throw new Error('unknown component pricing candidate');
    const profile = pricingProfileForCandidate(cohort, candidateId);
    const invocations = cell.role === 'router' ? 8 : 16;
    const input = cell.role === 'router' ? 4_096 : 16_384;
    const output = cell.role === 'router' ? 300 : 900;
    return total + invocations * datedPricingReservationCostUsd(profile, input, output);
  }, 0);
}

function reasonsForPinnedArtifacts(): FixedTraceComponentSmokeAdmissionReason[] {
  const reasons: FixedTraceComponentSmokeAdmissionReason[] = [];
  try {
    assertFixedTraceComponentSmokeContracts();
    const ids = FIXED_TRACE_COMPONENT_SMOKE_PROBES.map((probe) => probe.id);
    if (ids.length !== 8 || new Set(ids).size !== 8
      || FIXED_TRACE_COMPONENT_SMOKE_PARENT_IDS.some((id, index) => ids[index] !== `component-smoke-${id}-v1`)) {
      reasons.push('component_probe_set_mismatch');
    }
  } catch {
    reasons.push('component_probe_contract_invalid');
  }
  try {
    assertFixedTracePartitionManifest();
    assertFixedTraceExperimentalDesign();
    assertFixedTraceEvaluationProtocol(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
  } catch {
    reasons.push('component_protocol_or_design_invalid');
  }
  const router = FIXED_TRACE_ADMITTED_CELLS.filter((cell) => cell.role === 'router');
  const generation = FIXED_TRACE_ADMITTED_CELLS.filter((cell) => cell.role === 'generation');
  const stageOne = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.find((phase) => phase.id === 'stage_1_smoke');
  if (router.length !== 10 || generation.length !== 11 || new Set(FIXED_TRACE_ADMITTED_CELLS.map((cell) => cell.id)).size !== 21
    || !stageOne || stageOne.repetitions !== 1 || stageOne.uniqueCases !== 8 || stageOne.arms.length !== 21
    || stageOne.arms.some((arm, index) => arm.stages.length !== 1 || arm.stages[0]?.cellId !== FIXED_TRACE_ADMITTED_CELLS[index]?.id)) {
    reasons.push('component_cell_set_mismatch');
  }
  if (FIXED_TRACE_COMPONENT_SMOKE_PLAN.cases !== 8 || FIXED_TRACE_COMPONENT_SMOKE_PLAN.repetitions !== 1
    || FIXED_TRACE_COMPONENT_SMOKE_PLAN.routerCells !== 10 || FIXED_TRACE_COMPONENT_SMOKE_PLAN.generationCells !== 11
    || FIXED_TRACE_COMPONENT_SMOKE_PLAN.totalComponentCells !== 21 || FIXED_TRACE_COMPONENT_SMOKE_PLAN.providerCeilingUsd !== 5
    || FIXED_TRACE_COMPONENT_SMOKE_PLAN.llmJudging !== 'none' || FIXED_TRACE_COMPONENT_SMOKE_PLAN.architectureClaim !== 'none') {
    reasons.push('component_plan_mismatch');
  }
  return reasons;
}

function pricingForPinnedArtifacts(): {
  readonly reasons: readonly FixedTraceComponentSmokeAdmissionReason[];
  readonly cohort: DatedPricingCohort | null;
  readonly reservation: number | null;
} {
  const resolved = resolveCurrentEvaluationPricingCohort(new Date(FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF));
  if (resolved.status !== 'available') return { reasons: Object.freeze(['component_pricing_unavailable']), cohort: null, reservation: null };
  try {
    for (const cell of FIXED_TRACE_ADMITTED_CELLS) {
      const candidateId = candidateIdFor(cell);
      if (!candidateId) throw new Error('unknown candidate');
      const profile = pricingProfileForCandidate(resolved.cohort, candidateId);
      if (profile.provider !== cell.provider || profile.model !== cell.model || profile.profileId !== cell.pricingProfileId) {
        throw new Error('cell/profile mismatch');
      }
    }
    const reservation = maximumReservationUsd(resolved.cohort);
    if (!Number.isFinite(reservation) || reservation > 5) {
      return { reasons: Object.freeze(['component_budget_ceiling_exceeded']), cohort: resolved.cohort, reservation };
    }
    return { reasons: Object.freeze([]), cohort: resolved.cohort, reservation };
  } catch {
    return { reasons: Object.freeze(['component_pricing_cell_mismatch']), cohort: resolved.cohort, reservation: null };
  }
}

function pinnedManifest(): FixedTraceComponentSmokeAdmissionManifest {
  const pricing = pricingForPinnedArtifacts();
  const reasons = [...reasonsForPinnedArtifacts(), ...pricing.reasons];
  const probes = FIXED_TRACE_COMPONENT_SMOKE_PROBES.map((probe) => Object.freeze({
    id: probe.id, semanticSha256: probe.semanticSha256,
    parentId: probe.parent.id, parentSemanticSha256: probe.parent.semanticSha256,
  }));
  const cells = FIXED_TRACE_ADMITTED_CELLS.map((cell) => Object.freeze({
    id: cell.id, role: cell.role, provider: cell.provider, model: cell.model,
    effort: cell.effort, pricingProfileId: cell.pricingProfileId ?? '',
  }));
  const cohort = pricing.cohort;
  return Object.freeze({
    version: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION,
    asOf: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
    status: reasons.length === 0 ? 'ready_for_explicit_paid_authorization' : 'not_admitted',
    missingReasons: Object.freeze([...new Set(reasons)].sort()),
    probes: Object.freeze(probes), cells: Object.freeze(cells),
    cardinality: Object.freeze({ probes: 8, routerCells: 10, generationCells: 11, totalCells: 21, repetitions: 1, caseCellAssignments: 168, maximumProviderInvocations: 256 }),
    pricing: Object.freeze({
      cohortDigest: cohort?.digest ?? null, checkedAt: cohort?.checkedAt ?? null,
      profiles: Object.freeze((cohort?.profiles ?? []).map((profile) => Object.freeze({ candidateId: profile.candidateId, profileId: profile.profileId, effectiveFrom: profile.effectiveFrom, effectiveBefore: profile.effectiveBefore }))),
      maximumReservationUsd: pricing.reservation, providerCeilingUsd: 5,
    }),
    fingerprints: Object.freeze({
      protocol: fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL),
      corpus: fixedTraceCorpusSha256(FIXED_TRACE_CORPUS), partition: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
      experimentalDesign: fixedTraceExperimentalDesignFingerprint(FIXED_TRACE_EXPERIMENTAL_DESIGN),
      screeningConfiguration: FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT, stageControlVersion: FIXED_TRACE_STAGE_CONTROL_VERSION,
      requestAssemblyPolicyVersion: ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION,
      requestAssemblyPolicySha256: sha256(ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION),
      toolNamesSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNamesSha256,
      toolSchemaSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolSchemaSha256,
      toolDefinitionHandlerSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
      probeSetSha256: sha256(probes),
    }),
    budgetReservation: Object.freeze({ policy: 'evaluator_owned_per_authorization_private_ledger_required', replay: 'one_use_external_authorization_required_no_caller_ledger_or_reservation', concurrency: 'exclusive_reservation_required_before_any_provider_dispatch', unknownExposure: 'preserved_in_spend_and_denominator_then_admission_closed' }),
    dispatch: Object.freeze({ defaultOff: true, currentModuleCanDispatch: false, ambientEnvironmentAuthority: false, requiredAuthorization: 'explicit_one_use_external_paid_authorization' }),
    evidence: Object.freeze({ permittedClaims: 'mechanical_feasibility_only', permanentlyNonPromotable: true, prohibitedClaims: Object.freeze(['architecture', 'quality', 'safety_rate', 'noninferiority', 'superiority', 'final', 'tuning', 'corpus_count', 'production']) }),
    denominator: Object.freeze({ unit: 'case_cell_assignment_and_each_provider_invocation', prepared: 'included', dispatched: 'included', failed: 'included', unknownExposure: 'included_and_spend_reserved', omissions: 'failure' }),
  });
}

const PINNED_MANIFEST = pinnedManifest();

/** Returns evaluator-owned readiness only. It neither creates authorization nor dispatches. */
export function fixedTraceComponentSmokeAdmission(): FixedTraceComponentSmokeAdmissionManifest {
  return PINNED_MANIFEST;
}

/**
 * A deserialized manifest is audit data, never an authorization. This is a
 * hostile-input membrane used by callers that need to compare persisted data.
 */
export function isFixedTraceComponentSmokeAdmissionManifest(value: unknown): boolean {
  try {
    return canonicalJson(snapshotFixedTraceJson(value, 'component smoke admission manifest')) === canonicalJson(PINNED_MANIFEST);
  } catch {
    return false;
  }
}
