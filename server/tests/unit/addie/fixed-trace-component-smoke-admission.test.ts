import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
  fixedTraceComponentSmokeAdmission,
  isFixedTraceComponentSmokeAdmissionManifest,
} from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';

describe('fixed-trace component-smoke credential-free admission', () => {
  it('pins all and only the eight probes, 21 cells, one repetition, pricing, and $5 reservation', () => {
    const admission = fixedTraceComponentSmokeAdmission();
    expect(admission).toBe(fixedTraceComponentSmokeAdmission());
    expect(Object.isFrozen(admission)).toBe(true);
    expect(admission).toMatchObject({
      asOf: FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_AS_OF,
      status: 'ready_for_explicit_paid_authorization',
      missingReasons: [],
      cardinality: {
        probes: 8, routerCells: 10, generationCells: 11, totalCells: 21,
        repetitions: 1, caseCellAssignments: 168, maximumProviderInvocations: 256,
      },
      pricing: { providerCeilingUsd: 5, maximumReservationUsd: 3.7592960000000017 },
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
    expect(admission.pricing.profiles).toHaveLength(4);
    expect(admission.pricing.profiles.every((profile) => profile.effectiveFrom <= admission.asOf
      && (profile.effectiveBefore === null || admission.asOf < profile.effectiveBefore))).toBe(true);
    expect(Object.values(admission.fingerprints).every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
  });

  it.each([
    (manifest: any) => { manifest.probes.reverse(); },
    (manifest: any) => { manifest.probes.push(structuredClone(manifest.probes[0])); },
    (manifest: any) => { manifest.probes.pop(); },
    (manifest: any) => { manifest.probes[0].semanticSha256 = '0'.repeat(64); },
    (manifest: any) => { manifest.probes[0].parentSemanticSha256 = '0'.repeat(64); },
    (manifest: any) => { manifest.cells.reverse(); },
    (manifest: any) => { manifest.cells.push(structuredClone(manifest.cells[0])); },
    (manifest: any) => { manifest.cells.pop(); },
    (manifest: any) => { manifest.cells[0].pricingProfileId = 'forged'; },
    (manifest: any) => { manifest.pricing.profiles[0].effectiveBefore = '2026-09-06T00:00:00.000Z'; },
    (manifest: any) => { manifest.pricing.cohortDigest = 'sha256:forged'; },
    (manifest: any) => { manifest.pricing.maximumReservationUsd = 0; },
    (manifest: any) => { manifest.cardinality.caseCellAssignments = 0; },
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
        status: 'not_admitted', missingReasons: ['component_pricing_unavailable'],
      });
    } finally {
      vi.doUnmock('../../../src/addie/eval/dated-pricing-cohort.js');
      vi.resetModules();
    }
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
