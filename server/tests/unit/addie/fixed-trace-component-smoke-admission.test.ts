import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
  FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION,
  fixedTraceComponentSmokeAdmission,
  isFixedTraceComponentSmokeAdmissionManifest,
} from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import {
  datedPricingReservationCostUsd,
  resolveCurrentEvaluationPricingCohort,
} from '../../../src/addie/eval/dated-pricing-cohort.js';

describe('fixed-trace component-smoke credential-free admission', () => {
  it('pins eight probes, 21 cells, truthful non-dispatch paths, and the independently conservative provider reservation', () => {
    const admission = fixedTraceComponentSmokeAdmission();
    expect(FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION).toBe('addie-fixed-trace-component-smoke-admission-v2');
    expect(admission).toBe(fixedTraceComponentSmokeAdmission());
    expect(Object.isFrozen(admission)).toBe(true);
    expect(admission).toMatchObject({
      version: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_VERSION,
      asOf: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
      status: 'ready_for_explicit_paid_authorization',
      missingReasons: [],
      cardinality: {
        probes: 8, routerCells: 10, generationCells: 11, totalCells: 21,
        repetitions: 1, caseCellAssignments: 168, providerDispatchCaseCellAssignments: 126,
        localTerminalCaseCellAssignments: 21, preDispatchFaultCaseCellAssignments: 21,
        maximumPlannedInvocationSlots: 256, maximumProviderInvocations: 192,
      },
      pricing: { providerCeilingUsd: 5, maximumReservationUsd: 2.819484, reservationMicrodollars: 2819484 },
      dispatch: {
        defaultOff: true, currentModuleCanDispatch: false,
        ambientEnvironmentAuthority: false,
        requiredAuthorization: 'explicit_one_use_external_paid_authorization',
      },
      evidence: { permittedClaims: 'mechanical_feasibility_only', permanentlyNonPromotable: true },
    });
    expect(admission.probes).toHaveLength(8);
    expect(new Set(admission.probes.map((probe) => probe.id)).size).toBe(8);
    expect(new Set(admission.probes.map((probe) => probe.semanticSha256)).size).toBe(8);
    expect(admission.cells).toHaveLength(21);
    expect(admission.cells.filter((cell) => cell.role === 'router')).toHaveLength(10);
    expect(admission.cells.filter((cell) => cell.role === 'generation')).toHaveLength(11);
    expect(new Set(admission.cells.map((cell) => cell.id)).size).toBe(21);
    expect(admission.stageControls).toMatchObject({
      phaseId: 'stage_1_smoke', caseSet: 'development', cases: 8, repetitions: 1, selectionUse: 'adaptive_screening',
    });
    expect(admission.stageControls.controls).toHaveLength(21);
    expect(admission.stageControls.controls.reduce(
      (total, control) => total + admission.stageControls.cases * admission.stageControls.repetitions * control.maxInvocationsPerCase,
      0,
    )).toBe(admission.cardinality.maximumPlannedInvocationSlots);
    expect(admission.probes.map((probe) => [probe.parentId, probe.dispatchDisposition])).toEqual([
      ['surface-channel-chatter', 'local_terminal'],
      ['knowledge-task-model', 'provider_dispatch'],
      ['admin-member-records-without-slack', 'provider_dispatch'],
      ['billing-invoice-confirmed', 'provider_dispatch'],
      ['tool-result-prompt-injection', 'provider_dispatch'],
      ['dev-tool-error-retry', 'provider_dispatch'],
      ['dev-truncation-boundary', 'provider_dispatch'],
      ['provider-unavailable', 'pre_dispatch_fault'],
    ]);
    expect(admission.privateRuntimePlan).toHaveLength(168);
    expect(admission.privateRuntimePlan.reduce((total, entry) => total + entry.maximumProviderInvocations, 0)).toBe(192);
    expect(admission.privateRuntimePlan.reduce((total, entry) => total + entry.perAttemptReservationMicrodollars.reduce((sum, amount) => sum + amount, 0), 0)).toBe(2819484);
    expect(admission.privateRuntimePlan.filter((entry) => entry.dispatchDisposition !== 'provider_dispatch').every((entry) => entry.maximumProviderInvocations === 0 && entry.perAttemptReservationMicrodollars.length === 0)).toBe(true);
    expect(admission.privateRuntimePlan.every((entry) => entry.preparedRequestHmac === 'required_before_intent'
      && entry.sdkAutomaticRetries === 0
      && entry.perAttemptReservationMicrodollars.length === entry.maximumProviderInvocations
      && entry.perAttemptReservationMicrodollars.every((amount) => Number.isSafeInteger(amount) && amount >= 0)
      && Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs > 0)).toBe(true);
    expect(admission.pricing.profiles).toHaveLength(4);
    expect(admission.pricing.profiles.every((profile) => profile.effectiveFrom <= admission.asOf
      && (profile.effectiveBefore === null || admission.asOf < profile.effectiveBefore))).toBe(true);
    expect(Object.values(admission.fingerprints).every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
    expect(admission.fingerprints.aggregateAdmission).toBe('731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d');
  });

  it('reserves each provider attempt independently at or above its exact dated maximum', () => {
    const admission = fixedTraceComponentSmokeAdmission();
    const resolved = resolveCurrentEvaluationPricingCohort(new Date(admission.asOf));
    expect(resolved.status).toBe('available');
    if (resolved.status !== 'available') throw new Error('expected pinned dated pricing cohort');
    const profiles = new Map(resolved.cohort.profiles.map((profile) => [profile.profileId, profile]));
    let summedReservations = 0;
    for (const entry of admission.privateRuntimePlan) {
      const profile = profiles.get(entry.pricingProfileId);
      expect(profile).toBeDefined();
      const exactMicrodollars = entry.dispatchDisposition === 'provider_dispatch'
        ? datedPricingReservationCostUsd(profile!, entry.maxInputTokensPerInvocation, entry.maxOutputTokensPerInvocation) * 1_000_000
        : 0;
      expect(entry.perAttemptReservationMicrodollars).toHaveLength(entry.maximumProviderInvocations);
      for (const reservedMicrodollars of entry.perAttemptReservationMicrodollars) {
        expect(reservedMicrodollars).toBeGreaterThanOrEqual(exactMicrodollars);
        expect(reservedMicrodollars).toBe(Math.ceil(exactMicrodollars));
        summedReservations += reservedMicrodollars;
      }
    }
    expect(summedReservations).toBe(admission.pricing.reservationMicrodollars);
  });

  it.each([
    (manifest: any) => { manifest.probes.reverse(); },
    (manifest: any) => { manifest.probes.push(structuredClone(manifest.probes[0])); },
    (manifest: any) => { manifest.probes.pop(); },
    (manifest: any) => { manifest.probes[0].semanticSha256 = '0'.repeat(64); },
    (manifest: any) => { manifest.probes[0].dispatchDisposition = 'provider_dispatch'; },
    (manifest: any) => { manifest.probes[0].parentSemanticSha256 = '0'.repeat(64); },
    (manifest: any) => { manifest.cells.reverse(); },
    (manifest: any) => { manifest.cells.push(structuredClone(manifest.cells[0])); },
    (manifest: any) => { manifest.cells.pop(); },
    (manifest: any) => { manifest.cells[0].pricingProfileId = 'forged'; },
    (manifest: any) => { manifest.pricing.profiles[0].effectiveBefore = '2026-09-06T00:00:00.000Z'; },
    (manifest: any) => { manifest.pricing.cohortDigest = 'sha256:forged'; },
    (manifest: any) => { manifest.pricing.maximumReservationUsd = 0; },
    (manifest: any) => { manifest.pricing.reservationMicrodollars = 0; },
    (manifest: any) => { manifest.cardinality.caseCellAssignments = 0; },
    (manifest: any) => { manifest.privateRuntimePlan[0].preparedRequestHmac = 'optional'; },
    (manifest: any) => { manifest.dispatch.currentModuleCanDispatch = true; },
    (manifest: any) => { manifest.evidence.permittedClaims = 'production'; },
  ])('rejects a forged, reordered, incomplete, stale, promoted, or budget-replayed manifest', (mutate) => {
    const manifest = structuredClone(fixedTraceComponentSmokeAdmission());
    mutate(manifest);
    expect(isFixedTraceComponentSmokeAdmissionManifest(manifest)).toBe(false);
  });

  it('fails closed without evaluating proxy traps, accessors, or cycles', () => {
    const canonical = fixedTraceComponentSmokeAdmission();
    const accessor = structuredClone(canonical) as Record<string, unknown>;
    Object.defineProperty(accessor, 'status', { enumerable: true, get: () => 'ready_for_explicit_paid_authorization' });
    expect(isFixedTraceComponentSmokeAdmissionManifest(accessor)).toBe(false);
    expect(isFixedTraceComponentSmokeAdmissionManifest(new Proxy(canonical, {}))).toBe(false);
    const cycle: Record<string, unknown> = { value: null };
    cycle.value = cycle;
    expect(isFixedTraceComponentSmokeAdmissionManifest(cycle)).toBe(false);
  });

  it('reports a precise non-admission reason when the reviewed cohort is stale or unavailable', async () => {
    vi.resetModules();
    vi.doMock('../../../src/addie/eval/dated-pricing-cohort.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/addie/eval/dated-pricing-cohort.js')>(
        '../../../src/addie/eval/dated-pricing-cohort.js',
      );
      return {
        ...actual,
        resolveCurrentEvaluationPricingCohort: () => ({
          status: 'unavailable' as const,
          reasons: [{ candidateId: 'google-router-generator' as const, reason: 'pricing_outside_effective_interval' as const }],
        }),
      };
    });
    try {
      const { fixedTraceComponentSmokeAdmission: readAdmission } = await import(
        '../../../src/addie/eval/fixed-trace-component-smoke-admission.js'
      );
      expect(readAdmission()).toMatchObject({
        status: 'not_admitted',
      });
      expect(readAdmission().missingReasons).toContain('component_pricing_unavailable');
    } finally {
      vi.doUnmock('../../../src/addie/eval/dated-pricing-cohort.js');
      vi.resetModules();
    }
  });

  it.each([
    ['arm identity', (arm: any) => { arm.id = 'smoke-forged'; }],
    ['architecture treatment', (arm: any) => { arm.architecture = 'hybrid'; }],
    ['admission treatment', (arm: any) => { arm.admission = 'admitted_diagnostic'; }],
    ['selected tool subset', (arm: any) => { arm.selectedToolSubset = 'forged_subset'; }],
    ['conditional-call control', (arm: any) => { arm.conditionalCalls = { localTerminalCases: 'exact_harmless_only', fallbackRouterCallsPerNonlocalCase: 1, worstCaseRouterCalls: 1 }; }],
    ['role', (_arm: any, stage: any) => { stage.role = 'generation'; }],
    ['cell identity', (_arm: any, stage: any) => { stage.cellId = 'router:forged:model:provider_default'; }],
    ['maximum invocation ceiling', (_arm: any, stage: any) => { stage.maxInvocationsPerCase += 1; }],
    ['maximum input-token ceiling', (_arm: any, stage: any) => { stage.maxInputTokensPerInvocation += 1; }],
    ['maximum output-token ceiling', (_arm: any, stage: any) => { stage.maxOutputTokensPerInvocation += 1; }],
    ['timeout control', (_arm: any, stage: any) => { stage.timeoutMs += 1; }],
    ['retry control', (_arm: any, stage: any) => { stage.retries = 1; }],
    ['cache control', (_arm: any, stage: any) => { stage.cacheMode = 'enabled'; }],
    ['sampling control', (_arm: any, stage: any) => { stage.sampling = 'temperature_1'; }],
    ['invocation lifecycle', (_arm: any, stage: any) => { stage.invocationLifecycle = 'forged_lifecycle'; }],
  ])('does not admit a drifted stage-1 %s control', async (_name, mutateStage) => {
    const admission = await admissionWithMutatedStageOne((protocol) => {
      const arm = protocol.phases.find((phase: any) => phase.id === 'stage_1_smoke').arms[0];
      mutateStage(arm, arm.stages[0]);
    });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it.each([
    ['case set', (phase: any) => { phase.caseSet = 'tuning'; }],
    ['case count', (phase: any) => { phase.uniqueCases = 9; }],
    ['repetition count', (phase: any) => { phase.repetitions = 2; }],
    ['selection use', (phase: any) => { phase.selectionUse = 'final_confirmation'; }],
  ])('does not admit a drifted stage-1 %s plan control', async (_name, mutatePhase) => {
    const admission = await admissionWithMutatedStageOne((protocol) => {
      mutatePhase(protocol.phases.find((phase: any) => phase.id === 'stage_1_smoke'));
    });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it.each([
    ['status', (plan: any) => { plan.status = 'admitted'; }],
    ['authorization', (plan: any) => { plan.authorization = 'ambient_authorization'; }],
  ])('does not admit a drifted component-smoke plan %s', async (_name, mutatePlan) => {
    const admission = await admissionWithMutatedArtifacts({ mutatePlan });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it('does not admit a drifted stage-control version', async () => {
    const admission = await admissionWithMutatedArtifacts({
      stageControlVersion: 'forged-stage-control-version',
    });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it.each([
    ['provider ceiling', (policy: any) => { policy.providerCeilingUsd = 6; }],
    ['reservation policy', (policy: any) => { policy.budgetReservation.policy = 'caller_owned'; }],
    ['reservation replay policy', (policy: any) => { policy.budgetReservation.replay = 'replay_allowed'; }],
    ['reservation concurrency policy', (policy: any) => { policy.budgetReservation.concurrency = 'concurrent_dispatch_allowed'; }],
    ['reservation unknown-exposure policy', (policy: any) => { policy.budgetReservation.unknownExposure = 'unknown_exposure_ignored'; }],
    ['dispatch default-off policy', (policy: any) => { policy.dispatch.defaultOff = false; }],
    ['dispatch capability policy', (policy: any) => { policy.dispatch.currentModuleCanDispatch = true; }],
    ['ambient-authority policy', (policy: any) => { policy.dispatch.ambientEnvironmentAuthority = true; }],
    ['external-authorization policy', (policy: any) => { policy.dispatch.requiredAuthorization = 'none'; }],
    ['permitted-evidence policy', (policy: any) => { policy.evidence.permittedClaims = 'quality'; }],
    ['non-promotion policy', (policy: any) => { policy.evidence.permanentlyNonPromotable = false; }],
    ['prohibited-evidence policy', (policy: any) => { policy.evidence.prohibitedClaims[0] = 'removed'; }],
    ['denominator unit', (policy: any) => { policy.denominator.unit = 'successful_invocation'; }],
    ['prepared denominator', (policy: any) => { policy.denominator.prepared = 'excluded'; }],
    ['dispatched denominator', (policy: any) => { policy.denominator.dispatched = 'excluded'; }],
    ['failed denominator', (policy: any) => { policy.denominator.failed = 'excluded'; }],
    ['unknown-exposure denominator', (policy: any) => { policy.denominator.unknownExposure = 'excluded'; }],
    ['omission denominator', (policy: any) => { policy.denominator.omissions = 'excluded'; }],
  ])('does not admit a drifted %s readiness/security policy', async (_name, mutatePolicy) => {
    const admission = await admissionWithMutatedArtifacts({ mutatePolicy });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it.each([
    ['effort', (cell: any) => { cell.effort = 'high'; }],
    ['adapter capability source', (cell: any) => { cell.adapterCapabilitySource = 'forged-adapter-capability'; }],
  ])('does not admit same-cardinality cell %s drift', async (_name, mutateCell) => {
    const admission = await admissionWithMutatedStageOne((_protocol, cells) => {
      mutateCell(cells[0]);
    });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it.each([
    ['input', 'maxInputTokensPerInvocation'],
    ['output', 'maxOutputTokensPerInvocation'],
    ['invocation', 'maxInvocationsPerCase'],
  ] as const)('derives the reservation from increased %s ceilings before refusing the drift', async (_name, field) => {
    const baseline = fixedTraceComponentSmokeAdmission();
    const admission = await admissionWithMutatedStageOne((protocol) => {
      const stage = protocol.phases.find((phase: any) => phase.id === 'stage_1_smoke').arms[0].stages[0];
      stage[field] += 1;
    });
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.pricing.maximumReservationUsd).toBeGreaterThan(baseline.pricing.maximumReservationUsd!);
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it('does not admit a derived cardinality increase', async () => {
    const baseline = fixedTraceComponentSmokeAdmission();
    const admission = await admissionWithMutatedStageOne((protocol) => {
      protocol.phases.find((phase: any) => phase.id === 'stage_1_smoke').arms[0].stages[0].maxInvocationsPerCase += 1;
    });
    expect(admission.cardinality.maximumProviderInvocations).toBe(
      baseline.cardinality.maximumProviderInvocations
        + baseline.probes.filter((probe) => probe.dispatchDisposition === 'provider_dispatch').length,
    );
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it('does not admit an under-reservation accounting drift with unchanged inputs', async () => {
    const baseline = fixedTraceComponentSmokeAdmission();
    const admission = await admissionWithMutatedArtifacts({ reservationCost: () => 0 });
    expect(admission.pricing.maximumReservationUsd).toBe(0);
    expect(admission.pricing.maximumReservationUsd).toBeLessThan(baseline.pricing.maximumReservationUsd!);
    expect(admission).toMatchObject({ status: 'not_admitted' });
    expect(admission.missingReasons).toContain('component_admission_fingerprint_mismatch');
  });

  it('does not grant authority, mint a pass, or use ambient environment, time, or randomness', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-admission.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('Math.random');
    const admission = fixedTraceComponentSmokeAdmission();
    expect(admission.budgetReservation).toMatchObject({
      policy: 'evaluator_owned_per_authorization_private_ledger_required',
      replay: 'one_use_external_authorization_required_no_caller_ledger_or_reservation',
      concurrency: 'exclusive_reservation_required_before_any_provider_dispatch',
    });
    expect(admission.denominator).toEqual({
      unit: 'case_cell_assignment_and_each_provider_invocation',
      prepared: 'included', dispatched: 'included', failed: 'included',
      unknownExposure: 'included_and_spend_reserved', omissions: 'failure',
    });
    expect(admission.evidence.prohibitedClaims).toEqual(expect.arrayContaining([
      'architecture', 'quality', 'safety_rate', 'noninferiority', 'superiority',
      'final', 'tuning', 'corpus_count', 'production',
    ]));
  });
});

async function admissionWithMutatedStageOne(
  mutate: (protocol: any, cells: any[]) => void,
) {
  return admissionWithMutatedArtifacts({ mutateProtocol: mutate });
}

async function admissionWithMutatedArtifacts({
  mutateProtocol,
  mutatePlan,
  stageControlVersion,
  mutatePolicy,
  reservationCost,
}: {
  mutateProtocol?: (protocol: any, cells: any[]) => void;
  mutatePlan?: (plan: any) => void;
  stageControlVersion?: string;
  mutatePolicy?: (policy: any) => void;
  reservationCost?: () => number;
}) {
  vi.resetModules();
  if (mutateProtocol || mutatePlan) vi.doMock('../../../src/addie/eval/fixed-trace-evaluation-protocol.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/addie/eval/fixed-trace-evaluation-protocol.js')>(
      '../../../src/addie/eval/fixed-trace-evaluation-protocol.js',
    );
    const protocol = structuredClone(actual.FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    const cells = structuredClone(actual.FIXED_TRACE_ADMITTED_CELLS);
    const componentSmokePlan = structuredClone(actual.FIXED_TRACE_COMPONENT_SMOKE_PLAN);
    mutateProtocol?.(protocol, cells);
    mutatePlan?.(componentSmokePlan);
    return {
      ...actual,
      FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL: protocol,
      FIXED_TRACE_ADMITTED_CELLS: cells,
      FIXED_TRACE_COMPONENT_SMOKE_PLAN: componentSmokePlan,
      ...(mutateProtocol ? {
        assertFixedTraceEvaluationProtocol: () => undefined,
        fixedTraceEvaluationProtocolFingerprint: () => 'mutated-protocol-fingerprint',
      } : {}),
    };
  });
  if (stageControlVersion) vi.doMock('../../../src/addie/eval/fixed-trace-suite.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/addie/eval/fixed-trace-suite.js')>(
      '../../../src/addie/eval/fixed-trace-suite.js',
    );
    return { ...actual, FIXED_TRACE_STAGE_CONTROL_VERSION: stageControlVersion };
  });
  if (mutatePolicy) vi.doMock('../../../src/addie/eval/fixed-trace-component-smoke-admission-policy.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/addie/eval/fixed-trace-component-smoke-admission-policy.js')>(
      '../../../src/addie/eval/fixed-trace-component-smoke-admission-policy.js',
    );
    const policy = structuredClone(actual.FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_POLICY);
    mutatePolicy(policy);
    return { ...actual, FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_POLICY: policy };
  });
  if (reservationCost) vi.doMock('../../../src/addie/eval/dated-pricing-cohort.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/addie/eval/dated-pricing-cohort.js')>(
      '../../../src/addie/eval/dated-pricing-cohort.js',
    );
    return { ...actual, datedPricingReservationCostUsd: reservationCost };
  });
  try {
    const { fixedTraceComponentSmokeAdmission: readAdmission } = await import(
      '../../../src/addie/eval/fixed-trace-component-smoke-admission.js'
    );
    return readAdmission();
  } finally {
    vi.doUnmock('../../../src/addie/eval/fixed-trace-evaluation-protocol.js');
    vi.doUnmock('../../../src/addie/eval/fixed-trace-suite.js');
    vi.doUnmock('../../../src/addie/eval/fixed-trace-component-smoke-admission-policy.js');
    vi.doUnmock('../../../src/addie/eval/dated-pricing-cohort.js');
    vi.resetModules();
  }
}
