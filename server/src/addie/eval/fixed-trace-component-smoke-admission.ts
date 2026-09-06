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
import { FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_POLICY } from './fixed-trace-component-smoke-admission-policy.js';

/**
 * Stage 1 is admitted against this pinned instant, never an ambient clock.
 * A later paid-run coordinator must obtain a fresh admission rather than
 * treating this static review as a live authorization.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF = '2026-09-06T00:00:00.000Z' as const;
export const FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION =
  'addie-fixed-trace-component-smoke-admission-v1' as const;

/** One detached, evaluator-owned source for every emitted readiness policy value. */
const FIXED_TRACE_COMPONENT_SMOKE_READINESS = Object.freeze({
  componentSmokePlan: snapshotFixedTraceJson(
    FIXED_TRACE_COMPONENT_SMOKE_PLAN,
    'component smoke readiness plan',
  ) as typeof FIXED_TRACE_COMPONENT_SMOKE_PLAN,
  stageControlVersion: FIXED_TRACE_STAGE_CONTROL_VERSION,
  policy: snapshotFixedTraceJson(
    FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_POLICY,
    'component smoke readiness policy',
  ) as typeof FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_POLICY,
});

export type FixedTraceComponentSmokeAdmissionReason =
  | 'component_probe_contract_invalid'
  | 'component_probe_set_mismatch'
  | 'component_cell_set_mismatch'
  | 'component_plan_mismatch'
  | 'component_pricing_unavailable'
  | 'component_pricing_cell_mismatch'
  | 'component_budget_ceiling_exceeded'
  | 'component_admission_fingerprint_mismatch'
  | 'component_protocol_or_design_invalid';

interface FixedTraceComponentSmokeStageControl {
  readonly armId: string;
  readonly architecture: string;
  readonly admission: string;
  readonly selectedToolSubset: string;
  readonly conditionalCalls: Readonly<{
    readonly localTerminalCases: string;
    readonly fallbackRouterCallsPerNonlocalCase: number;
    readonly worstCaseRouterCalls: number;
  }> | null;
  readonly role: 'router' | 'generation';
  readonly cellId: string;
  readonly maxInvocationsPerCase: number;
  readonly maxInputTokensPerInvocation: number;
  readonly maxOutputTokensPerInvocation: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly cacheMode: string;
  readonly sampling: string;
  readonly invocationLifecycle: string;
}

interface FixedTraceComponentSmokeStagePlan {
  readonly phaseId: 'stage_1_smoke';
  readonly caseSet: string;
  readonly cases: number;
  readonly repetitions: number;
  readonly selectionUse: string;
  readonly controls: readonly FixedTraceComponentSmokeStageControl[];
}

export interface FixedTraceComponentSmokeAdmissionManifest {
  readonly version: typeof FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION;
  readonly asOf: typeof FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF;
  readonly status: 'ready_for_explicit_paid_authorization' | 'not_admitted';
  readonly missingReasons: readonly FixedTraceComponentSmokeAdmissionReason[];
  readonly probes: readonly {
    readonly id: string;
    readonly semanticSha256: string;
    readonly parentId: string;
    readonly parentSemanticSha256: string;
    /** Terminal-path disposition, pinned before any private runtime exists. */
    readonly dispatchDisposition: 'provider_dispatch' | 'local_terminal' | 'pre_dispatch_fault';
  }[];
  readonly cells: readonly { readonly id: string; readonly role: 'router' | 'generation'; readonly provider: string; readonly model: string; readonly effort: string; readonly pricingProfileId: string; readonly adapterCapabilitySource: string }[];
  readonly stageControls: Readonly<{
    phaseId: 'stage_1_smoke';
    caseSet: string;
    cases: number;
    repetitions: number;
    selectionUse: string;
    controls: readonly FixedTraceComponentSmokeStageControl[];
  }>;
  readonly cardinality: Readonly<{
    probes: 8;
    routerCells: 10;
    generationCells: 11;
    totalCells: 21;
    repetitions: 1;
    caseCellAssignments: number;
    providerDispatchCaseCellAssignments: number;
    localTerminalCaseCellAssignments: number;
    preDispatchFaultCaseCellAssignments: number;
    maximumPlannedInvocationSlots: number;
    maximumProviderInvocations: number;
  }>;
  readonly pricing: Readonly<{
    cohortDigest: string | null;
    checkedAt: string | null;
    profiles: readonly { readonly candidateId: string; readonly profileId: string; readonly effectiveFrom: string; readonly effectiveBefore: string | null }[];
    maximumReservationUsd: number | null;
    reservationMicrodollars: number | null;
    providerCeilingUsd: 5;
  }>;
  /**
   * Exact, admission-pinned provider disposition and per-attempt reservation.
   * Prepared-request HMAC, limits, timeout, profile and reservation are here
   * so a later private runtime cannot invent them after authorization.
   */
  readonly privateRuntimePlan: ReadonlyArray<Readonly<{
    readonly probeId: string;
    readonly cellId: string;
    readonly dispatchDisposition: 'provider_dispatch' | 'local_terminal' | 'pre_dispatch_fault';
    readonly maximumProviderInvocations: number;
    readonly pricingProfileId: string;
    readonly preparedRequestHmac: 'required_before_intent';
    readonly maxInputTokensPerInvocation: number;
    readonly maxOutputTokensPerInvocation: number;
    readonly timeoutMs: number;
    readonly sdkAutomaticRetries: 0;
    readonly perAttemptReservationMicrodollars: readonly number[];
  }>>;
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
    aggregateAdmission: string;
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

/** Independently reviewed integrity pin; it is never an authorization artifact. */
const FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_FINGERPRINT_PIN =
  '3594f3e20f363093f4c35e433f2b019de32345fe705312e1d8a771dee12fbed6' as const;

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

function stageOnePlan(): FixedTraceComponentSmokeStagePlan | null {
  const snapshot = snapshotFixedTraceJson(
    FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
    'component smoke stage-one protocol',
  ) as typeof FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL;
  const phase = snapshot.phases.find((candidate) => candidate.id === 'stage_1_smoke');
  if (!phase || phase.uniqueCases === null || phase.id !== 'stage_1_smoke') return null;
  const controls = phase.arms.map((arm) => {
    if (arm.stages.length !== 1) return null;
    const stage = arm.stages[0]!;
    if ((stage.role !== 'router' && stage.role !== 'generation') || stage.cellId === null) return null;
    return Object.freeze({
      armId: arm.id, architecture: arm.architecture, admission: arm.admission,
      selectedToolSubset: arm.selectedToolSubset, role: stage.role, cellId: stage.cellId,
      conditionalCalls: arm.conditionalCalls ?? null,
      maxInvocationsPerCase: stage.maxInvocationsPerCase,
      maxInputTokensPerInvocation: stage.maxInputTokensPerInvocation,
      maxOutputTokensPerInvocation: stage.maxOutputTokensPerInvocation,
      timeoutMs: stage.timeoutMs, retries: stage.retries, cacheMode: stage.cacheMode,
      sampling: stage.sampling, invocationLifecycle: stage.invocationLifecycle,
    });
  });
  if (controls.some((control) => control === null)) return null;
  return Object.freeze({
    phaseId: phase.id, caseSet: phase.caseSet, cases: phase.uniqueCases, repetitions: phase.repetitions,
    selectionUse: phase.selectionUse,
    controls: Object.freeze(controls as FixedTraceComponentSmokeStageControl[]),
  });
}

function validStageOnePlan(plan: FixedTraceComponentSmokeStagePlan | null): plan is FixedTraceComponentSmokeStagePlan {
  if (!plan || plan.caseSet !== 'development' || plan.cases !== 8 || plan.repetitions !== 1 || plan.selectionUse !== 'adaptive_screening'
    || plan.controls.length !== 21) return false;
  const cells = new Map(FIXED_TRACE_ADMITTED_CELLS.map((cell) => [cell.id, cell]));
  return plan.controls.every((control, index) => {
    const cell = cells.get(control.cellId);
    return cell !== undefined && control.cellId === FIXED_TRACE_ADMITTED_CELLS[index]?.id
      && control.role === cell.role && control.armId === `smoke-${cell.id}`
      && control.architecture === 'none' && control.admission === 'not_admitted_dispatch_authority'
      && control.selectedToolSubset === 'architecture_derived_presented_subset'
      && control.conditionalCalls === null
      && Number.isSafeInteger(control.maxInvocationsPerCase) && control.maxInvocationsPerCase > 0
      && Number.isSafeInteger(control.maxInputTokensPerInvocation) && control.maxInputTokensPerInvocation > 0
      && Number.isSafeInteger(control.maxOutputTokensPerInvocation) && control.maxOutputTokensPerInvocation > 0
      && Number.isSafeInteger(control.timeoutMs) && control.timeoutMs > 0
      && control.retries === 0 && control.cacheMode === 'disabled'
      && control.sampling === 'provider_no_sampling_control'
      && typeof control.invocationLifecycle === 'string' && control.invocationLifecycle.length > 0;
  });
}

function dispatchDispositionForProbe(probe: typeof FIXED_TRACE_COMPONENT_SMOKE_PROBES[number]): 'provider_dispatch' | 'local_terminal' | 'pre_dispatch_fault' | null {
  if (probe.terminalInvariant.path === 'model_loop') return 'provider_dispatch';
  if (probe.terminalInvariant.path === 'local_terminal') return 'local_terminal';
  if (probe.terminalInvariant.path === 'pre_dispatch_fault') return 'pre_dispatch_fault';
  return null;
}

function privateRuntimePlan(
  cohort: DatedPricingCohort,
  plan: FixedTraceComponentSmokeStagePlan,
): FixedTraceComponentSmokeAdmissionManifest['privateRuntimePlan'] {
  const cells = new Map(FIXED_TRACE_ADMITTED_CELLS.map((cell) => [cell.id, cell]));
  const unrounded: Array<{ entry: Omit<FixedTraceComponentSmokeAdmissionManifest['privateRuntimePlan'][number], 'perAttemptReservationMicrodollars'>; rawMicrodollars: number }> = [];
  for (const probe of FIXED_TRACE_COMPONENT_SMOKE_PROBES) {
    const dispatchDisposition = dispatchDispositionForProbe(probe);
    if (!dispatchDisposition) throw new Error('unknown probe disposition');
    for (const control of plan.controls) {
      const cell = cells.get(control.cellId);
      if (!cell) throw new Error('unknown component cell');
      const candidateId = candidateIdFor(cell);
      if (!candidateId) throw new Error('unknown component pricing candidate');
      const profile = pricingProfileForCandidate(cohort, candidateId);
      const rawMicrodollars = dispatchDisposition === 'provider_dispatch'
        ? datedPricingReservationCostUsd(profile, control.maxInputTokensPerInvocation, control.maxOutputTokensPerInvocation) * 1_000_000
        : 0;
      unrounded.push({
        entry: Object.freeze({ probeId: probe.id, cellId: cell.id, dispatchDisposition,
          maximumProviderInvocations: dispatchDisposition === 'provider_dispatch' ? control.maxInvocationsPerCase : 0,
          pricingProfileId: profile.profileId, preparedRequestHmac: 'required_before_intent' as const,
          maxInputTokensPerInvocation: control.maxInputTokensPerInvocation,
          maxOutputTokensPerInvocation: control.maxOutputTokensPerInvocation, timeoutMs: control.timeoutMs,
          sdkAutomaticRetries: 0 as const }),
        rawMicrodollars,
      });
    }
  }
  const totalMicrodollars = Math.round(unrounded.reduce((total, item) => total + item.rawMicrodollars * item.entry.maximumProviderInvocations, 0));
  if (!Number.isSafeInteger(totalMicrodollars) || totalMicrodollars < 0) throw new Error('component reservation is not representable in microdollars');
  const allocations = unrounded.flatMap(({ entry, rawMicrodollars }) =>
    Array.from({ length: entry.maximumProviderInvocations }, () => Math.floor(rawMicrodollars)),
  );
  const remainder = totalMicrodollars - allocations.reduce((total, amount) => total + amount, 0);
  if (!Number.isSafeInteger(remainder) || remainder < 0 || remainder > allocations.length) throw new Error('component reservation allocation is invalid');
  for (let index = 0; index < remainder; index += 1) allocations[index] += 1;
  let allocationIndex = 0;
  return Object.freeze(unrounded.map(({ entry }) => Object.freeze({ ...entry,
    perAttemptReservationMicrodollars: Object.freeze(Array.from({ length: entry.maximumProviderInvocations }, () => allocations[allocationIndex++]!)),
  })));
}

function reasonsForPinnedArtifacts(
  plan: FixedTraceComponentSmokeStagePlan | null,
): FixedTraceComponentSmokeAdmissionReason[] {
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
  if (router.length !== 10 || generation.length !== 11 || new Set(FIXED_TRACE_ADMITTED_CELLS.map((cell) => cell.id)).size !== 21
    || !validStageOnePlan(plan)) {
    reasons.push('component_cell_set_mismatch');
  }
  const componentPlan = FIXED_TRACE_COMPONENT_SMOKE_READINESS.componentSmokePlan;
  if (componentPlan.cases !== 8 || componentPlan.repetitions !== 1
    || componentPlan.routerCells !== 10 || componentPlan.generationCells !== 11
    || componentPlan.totalComponentCells !== 21 || componentPlan.providerCeilingUsd !== FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.providerCeilingUsd
    || componentPlan.llmJudging !== 'none' || componentPlan.architectureClaim !== 'none') {
    reasons.push('component_plan_mismatch');
  }
  return reasons;
}

function pricingForPinnedArtifacts(plan: FixedTraceComponentSmokeStagePlan | null): {
  readonly reasons: readonly FixedTraceComponentSmokeAdmissionReason[];
  readonly cohort: DatedPricingCohort | null;
  readonly reservation: number | null;
  readonly privateRuntimePlan: FixedTraceComponentSmokeAdmissionManifest['privateRuntimePlan'];
} {
  if (!validStageOnePlan(plan)) return { reasons: Object.freeze(['component_cell_set_mismatch']), cohort: null, reservation: null, privateRuntimePlan: Object.freeze([]) };
  const resolved = resolveCurrentEvaluationPricingCohort(new Date(FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF));
  if (resolved.status !== 'available') return { reasons: Object.freeze(['component_pricing_unavailable']), cohort: null, reservation: null, privateRuntimePlan: Object.freeze([]) };
  try {
    for (const cell of FIXED_TRACE_ADMITTED_CELLS) {
      const candidateId = candidateIdFor(cell);
      if (!candidateId) throw new Error('unknown candidate');
      const profile = pricingProfileForCandidate(resolved.cohort, candidateId);
      if (profile.provider !== cell.provider || profile.model !== cell.model || profile.profileId !== cell.pricingProfileId) {
        throw new Error('cell/profile mismatch');
      }
    }
    const planForRuntime = privateRuntimePlan(resolved.cohort, plan);
    const reservationMicrodollars = planForRuntime.reduce(
      (total, entry) => total + entry.perAttemptReservationMicrodollars.reduce((sum, amount) => sum + amount, 0), 0,
    );
    const reservation = reservationMicrodollars / 1_000_000;
    if (!Number.isFinite(reservation) || reservation > FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.providerCeilingUsd) {
      return { reasons: Object.freeze(['component_budget_ceiling_exceeded']), cohort: resolved.cohort, reservation, privateRuntimePlan: planForRuntime };
    }
    return { reasons: Object.freeze([]), cohort: resolved.cohort, reservation, privateRuntimePlan: planForRuntime };
  } catch {
    return { reasons: Object.freeze(['component_pricing_cell_mismatch']), cohort: resolved.cohort, reservation: null, privateRuntimePlan: Object.freeze([]) };
  }
}

function cardinalityForPinnedPlan(
  plan: FixedTraceComponentSmokeStagePlan | null,
): FixedTraceComponentSmokeAdmissionManifest['cardinality'] {
  if (!plan || !validStageOnePlan(plan)) return Object.freeze({
    probes: 8 as const, routerCells: 10 as const, generationCells: 11 as const,
    totalCells: 21 as const, repetitions: 1 as const,
    caseCellAssignments: 0, providerDispatchCaseCellAssignments: 0,
    localTerminalCaseCellAssignments: 0, preDispatchFaultCaseCellAssignments: 0,
    maximumPlannedInvocationSlots: 0,
    maximumProviderInvocations: 0,
  });
  return Object.freeze({
    probes: 8 as const, routerCells: 10 as const, generationCells: 11 as const,
    totalCells: 21 as const, repetitions: 1 as const,
    caseCellAssignments: plan.cases * plan.repetitions * plan.controls.length,
    providerDispatchCaseCellAssignments: 6 * plan.controls.length,
    localTerminalCaseCellAssignments: plan.controls.length,
    preDispatchFaultCaseCellAssignments: plan.controls.length,
    maximumPlannedInvocationSlots: plan.controls.reduce(
      (total, control) => total + plan.cases * plan.repetitions * control.maxInvocationsPerCase, 0,
    ),
    maximumProviderInvocations: plan.controls.reduce(
      (total, control) => total + 6 * plan.repetitions * control.maxInvocationsPerCase, 0,
    ),
  });
}

function pricingManifestForPinnedArtifacts(
  pricing: ReturnType<typeof pricingForPinnedArtifacts>,
): FixedTraceComponentSmokeAdmissionManifest['pricing'] {
  const cohort = pricing.cohort;
  return Object.freeze({
    cohortDigest: cohort?.digest ?? null,
    checkedAt: cohort?.checkedAt ?? null,
    profiles: Object.freeze((cohort?.profiles ?? []).map((profile) => Object.freeze({
      candidateId: profile.candidateId,
      profileId: profile.profileId,
      effectiveFrom: profile.effectiveFrom,
      effectiveBefore: profile.effectiveBefore,
    }))),
    maximumReservationUsd: pricing.reservation,
    reservationMicrodollars: pricing.reservation === null ? null : Math.round(pricing.reservation * 1_000_000),
    providerCeilingUsd: FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.providerCeilingUsd,
  });
}

function aggregateAdmissionFingerprint(
  probes: FixedTraceComponentSmokeAdmissionManifest['probes'],
  cells: FixedTraceComponentSmokeAdmissionManifest['cells'],
  plan: FixedTraceComponentSmokeStagePlan | null,
  cohort: DatedPricingCohort | null,
  cardinality: FixedTraceComponentSmokeAdmissionManifest['cardinality'],
  pricing: FixedTraceComponentSmokeAdmissionManifest['pricing'],
  runtimePlan: FixedTraceComponentSmokeAdmissionManifest['privateRuntimePlan'],
): string {
  return sha256({
    domain: 'adcp:addie:fixed-trace-component-smoke-admission:v1\0',
    version: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION,
    asOf: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
    probes,
    cells,
    stageOne: plan,
    request: {
      policyVersion: ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION,
      policySha256: sha256(ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION),
    },
    tools: {
      names: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNamesSha256,
      schema: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolSchemaSha256,
      definitionHandler: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
    },
    corpus: fixedTraceCorpusSha256(FIXED_TRACE_CORPUS),
    partition: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
    protocol: fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL),
    design: fixedTraceExperimentalDesignFingerprint(FIXED_TRACE_EXPERIMENTAL_DESIGN),
    screeningConfiguration: FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT,
    pricingCohort: cohort,
    readiness: FIXED_TRACE_COMPONENT_SMOKE_READINESS,
    derived: { cardinality, pricing, runtimePlan },
  });
}

function pinnedManifest(): FixedTraceComponentSmokeAdmissionManifest {
  const plan = stageOnePlan();
  const pricing = pricingForPinnedArtifacts(plan);
  const reasons = [...reasonsForPinnedArtifacts(plan), ...pricing.reasons];
  const probes = FIXED_TRACE_COMPONENT_SMOKE_PROBES.map((probe) => {
    const dispatchDisposition = dispatchDispositionForProbe(probe);
    if (!dispatchDisposition) throw new Error('unknown component smoke dispatch disposition');
    return Object.freeze({
    id: probe.id, semanticSha256: probe.semanticSha256,
    parentId: probe.parent.id, parentSemanticSha256: probe.parent.semanticSha256,
    dispatchDisposition,
    });
  });
  const cells = FIXED_TRACE_ADMITTED_CELLS.map((cell) => Object.freeze({
    id: cell.id, role: cell.role, provider: cell.provider, model: cell.model,
    effort: cell.effort, pricingProfileId: cell.pricingProfileId ?? '',
    adapterCapabilitySource: cell.adapterCapabilitySource,
  }));
  const cohort = pricing.cohort;
  const cardinality = cardinalityForPinnedPlan(plan);
  const pricingManifest = pricingManifestForPinnedArtifacts(pricing);
  const aggregate = aggregateAdmissionFingerprint(
    probes, cells, plan, cohort, cardinality, pricingManifest, pricing.privateRuntimePlan,
  );
  if (aggregate !== FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_FINGERPRINT_PIN) {
    reasons.push('component_admission_fingerprint_mismatch');
  }
  return Object.freeze({
    version: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION,
    asOf: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
    status: reasons.length === 0 ? 'ready_for_explicit_paid_authorization' : 'not_admitted',
    missingReasons: Object.freeze([...new Set(reasons)].sort()),
    probes: Object.freeze(probes), cells: Object.freeze(cells),
    stageControls: Object.freeze(plan ?? {
      phaseId: 'stage_1_smoke' as const,
      caseSet: 'invalid',
      cases: 0,
      repetitions: 0,
      selectionUse: 'invalid',
      controls: [] as readonly FixedTraceComponentSmokeStageControl[],
    }),
    cardinality,
    pricing: pricingManifest,
    privateRuntimePlan: pricing.privateRuntimePlan,
    fingerprints: Object.freeze({
      protocol: fixedTraceEvaluationProtocolFingerprint(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL),
      corpus: fixedTraceCorpusSha256(FIXED_TRACE_CORPUS), partition: FIXED_TRACE_PARTITION_MANIFEST_SHA256,
      experimentalDesign: fixedTraceExperimentalDesignFingerprint(FIXED_TRACE_EXPERIMENTAL_DESIGN),
      screeningConfiguration: FIXED_TRACE_SCREENING_CONFIG_FINGERPRINT,
      stageControlVersion: FIXED_TRACE_COMPONENT_SMOKE_READINESS.stageControlVersion,
      requestAssemblyPolicyVersion: ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION,
      requestAssemblyPolicySha256: sha256(ADDIE_REQUEST_TOOL_REPLAY_ASSEMBLY_POLICY_VERSION),
      toolNamesSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNamesSha256,
      toolSchemaSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolSchemaSha256,
      toolDefinitionHandlerSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
      probeSetSha256: sha256(probes),
      aggregateAdmission: aggregate,
    }),
    budgetReservation: FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.budgetReservation,
    dispatch: FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.dispatch,
    evidence: FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.evidence,
    denominator: FIXED_TRACE_COMPONENT_SMOKE_READINESS.policy.denominator,
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
