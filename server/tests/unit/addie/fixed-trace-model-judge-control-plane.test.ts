import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_DIAGNOSTIC_ASSIGNMENT_REQUIREMENT,
  FIXED_TRACE_FROZEN_GOLDEN_CALIBRATION_REQUIREMENT,
  FIXED_TRACE_CUSTODY_REQUIREMENT,
  FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT,
  FIXED_TRACE_PROVIDER_EXCLUDING_JUDGE_ELIGIBILITY_REQUIREMENT,
  assessFixedTraceModelJudgedDiagnostic,
  assertFixedTraceBlindedModelJudgePacket,
  classifyFixedTraceProviderExcludingJudgeEligibility,
} from '../../../src/addie/eval/fixed-trace-model-judge-control-plane.js';
import {
  FIXED_TRACE_API_BUDGET_LADDER,
  assertFixedTraceV2SmokeIdentity,
  assertFixedTraceUnverifiedTrancheLedgerShape,
} from '../../../src/addie/eval/fixed-trace-api-budget-ladder.js';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';

const hash = (letter = 'a') => letter.repeat(64);
const ledger = () => ({
  trancheId: 'tranche_3_exploratory_and_architecture_diagnostic', unverifiedAuthorizationReferenceDigest: hash(),
  declaredMaximumProviderCalls: 1, declaredCapMicrodollars: 1,
  priorReconciledObservedMicrodollars: 0, priorOutstandingReservedMicrodollars: 0,
  priorUnknownExposureMicrodollars: 0, currentTrancheReservedMicrodollars: 0,
  observedProviderCalls: 0,
});
const firstTrancheLedger = () => ({
  trancheId: 'tranche_1_component_smoke', unverifiedAuthorizationReferenceDigest: hash(),
  declaredMaximumProviderCalls: 192, declaredCapMicrodollars: 5_000_000,
  priorReconciledObservedMicrodollars: 0, priorOutstandingReservedMicrodollars: 0,
  priorUnknownExposureMicrodollars: 0, currentTrancheReservedMicrodollars: 2_819_484,
  observedProviderCalls: 0,
});
const packet = () => ({ packetId: 'opaque-1', prompt: 'Summarize supplied facts.', candidateOutput: 'A bounded answer.', scoringContext: 'Apply the locked rubric.', outputCondition: 'complete' as const });
const input = () => ({
  budgetLedger: ledger(),
  candidateOutputs: [{ assignmentId: 'a1', caseId: 'case1', stratum: 's1', architectureArm: 'direct_generation', configurationCellIds: ['generation:openai:gpt-5.6-luna:none'], repetition: 1, packetId: 'opaque-1', outputStatus: 'complete', candidateOutput: 'A bounded answer.' }],
  deterministicEvidence: [{ assignmentId: 'a1', correctness: true, mutationSafety: true, promptInjection: true, toolCorrectness: true, provenance: true, returnedIdentity: true, latency: true, cost: true }],
  judgments: [{ packetId: 'opaque-1', judgeProvider: 'anthropic', judgeModel: 'judge-a', outcome: 'pass', reason: 'synthetic only' }, { packetId: 'opaque-1', judgeProvider: 'google', judgeModel: 'judge-b', outcome: 'pass', reason: 'synthetic only' }],
  manualReview: 'not_requested', packets: [packet()],
  randomization: { seedCommitment: hash('b'), scheduleDigest: hash('c'), lockedHoldoutDigest: hash('d') },
});
const invalid = (value: ReturnType<typeof input>) =>
  expect(assessFixedTraceModelJudgedDiagnostic(value).blockers).toContainEqual(expect.stringMatching(/^invalid_unverified_input:/));

describe('fixed-trace no-spend model-judge amendment', () => {
  it('is explicitly non-admitted while real calibration and assignment artifacts are absent', () => {
    expect(FIXED_TRACE_FROZEN_GOLDEN_CALIBRATION_REQUIREMENT.status).toMatch(/^unavailable/);
    expect(FIXED_TRACE_DIAGNOSTIC_ASSIGNMENT_REQUIREMENT.status).toMatch(/^unavailable/);
    expect(FIXED_TRACE_CUSTODY_REQUIREMENT.status).toMatch(/^unavailable/);
    expect(FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT).toMatchObject({
      status: expect.stringMatching(/^not_admitted/),
      componentSmoke: 'unchanged_v2_mechanical_feasibility_only_no_quality_or_architecture_claim',
      architectureArms: ['direct_generation', 'two_stage_llm_router', 'deterministic_policy_llm_fallback_hybrid'],
      humanPanel: 'dormant_optional_control_plane_not_admission_blocker_and_not_evidence_that_humans_ran',
    });
    expect(FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT.claimLimits).toEqual(expect.arrayContaining([
      'no_architecture_winner_claim', 'no_model_winner_claim', 'no_effort_winner_claim', 'no_quality_rate_claim',
    ]));
    expect(FIXED_TRACE_MODEL_JUDGED_DIAGNOSTIC_AMENDMENT.judges).toMatch(/^exactly_two_judges/);
    const result = assessFixedTraceModelJudgedDiagnostic(input());
    expect(result).toMatchObject({ admitted: false });
    expect(result.blockers.some((blocker) => blocker.startsWith('invalid_unverified_input:'))).toBe(false);
  });

  it('makes current-registry provider-excluding eligibility exact and fails closed for mixed-provider arms', () => {
    expect(FIXED_TRACE_PROVIDER_EXCLUDING_JUDGE_ELIGIBILITY_REQUIREMENT.currentPlanningTruth).toEqual({
      potentiallyLlmJudgeableProviderMatchedCombinations: 97,
      mixedProviderCombinationsRequiringHumanOrFourthProvider: 134,
    });
    expect(FIXED_TRACE_PROVIDER_EXCLUDING_JUDGE_ELIGIBILITY_REQUIREMENT.universeScope).toMatch(/not_an_exhaustive_model_universe/);
    expect(classifyFixedTraceProviderExcludingJudgeEligibility(['anthropic'])).toEqual({
      candidateProviders: ['anthropic'],
      status: 'eligible_pending_custodied_manifest_calibration_and_authority',
      requiredJudgeProviders: ['openai', 'google'],
      promotable: false,
    });
    expect(classifyFixedTraceProviderExcludingJudgeEligibility(['anthropic', 'openai'])).toEqual({
      candidateProviders: ['anthropic', 'openai'],
      status: 'unavailable_mixed_provider_requires_human_or_fourth_provider',
      requiredJudgeProviders: [],
      promotable: false,
    });
    expect(() => classifyFixedTraceProviderExcludingJudgeEligibility([])).toThrow(/nonempty subset/);
  });

  it.each([
    ['two_stage_llm_router', ['router:anthropic:claude-haiku-4-5:provider_default', 'generation:anthropic:claude-sonnet-5:provider_default']],
    ['deterministic_policy_llm_fallback_hybrid', ['router:anthropic:claude-haiku-4-5:provider_default', 'generation:anthropic:claude-sonnet-5:provider_default']],
  ])('retains valid ordered same-provider %s treatment cells', (architectureArm, configurationCellIds) => {
    const value = input();
    value.candidateOutputs[0].architectureArm = architectureArm;
    value.candidateOutputs[0].configurationCellIds = configurationCellIds;
    value.judgments[0].judgeProvider = 'openai';
    value.judgments[1].judgeProvider = 'google';
    const result = assessFixedTraceModelJudgedDiagnostic(value);
    expect(result.admitted).toBe(false);
    expect(result.blockers.some((blocker) => blocker.startsWith('invalid_unverified_input:'))).toBe(false);
  });

  it.each([
    (v: any) => { v.candidateOutputs[0].configurationCellIds = []; },
    (v: any) => { v.candidateOutputs[0].configurationCellIds = ['router:anthropic:claude-haiku-4-5:provider_default']; },
    (v: any) => { v.candidateOutputs[0].architectureArm = 'two_stage_llm_router'; v.candidateOutputs[0].configurationCellIds = ['generation:anthropic:claude-sonnet-5:provider_default', 'router:anthropic:claude-haiku-4-5:provider_default']; },
    (v: any) => { v.candidateOutputs[0].architectureArm = 'two_stage_llm_router'; v.candidateOutputs[0].configurationCellIds = ['router:anthropic:claude-haiku-4-5:provider_default']; },
    (v: any) => { v.candidateOutputs[0].architectureArm = 'deterministic_policy_llm_fallback_hybrid'; v.candidateOutputs[0].configurationCellIds = ['router:anthropic:claude-haiku-4-5:provider_default', 'generation:anthropic:claude-sonnet-5:provider_default', 'generation:openai:gpt-5.6-luna:none']; },
    (v: any) => { v.candidateOutputs[0].architectureArm = 'deterministic_policy_llm_fallback_hybrid'; v.candidateOutputs[0].configurationCellIds = ['router:anthropic:claude-haiku-4-5:provider_default', 'router:openai:gpt-5.6-luna:none']; },
    (v: any) => { v.candidateOutputs[0].architectureArm = 'two_stage_llm_router'; v.candidateOutputs[0].configurationCellIds = ['router:anthropic:claude-haiku-4-5:provider_default', 'generation:openai:gpt-5.6-luna:none']; },
    (v: any) => { v.judgments[0].judgeProvider = 'openai'; },
    (v: any) => { v.judgments[0].judgeProvider = 'arbitrary'; },
    (v: any) => { v.judgments[1].judgeProvider = 'anthropic'; v.judgments[1].judgeModel = 'judge-a'; },
  ])('fails closed on invalid architecture or provider-excluding judge treatment', (mutate) => {
    const value = input(); mutate(value); invalid(value);
  });

  it('requires the exact v2 smoke identity before exposing tranche-one planning', () => {
    const smoke = fixedTraceComponentSmokeAdmission();
    expect(smoke.fingerprints.aggregateAdmission).toBe('817ab57d30cc89dab4a81016f5c826857b8dc2a83e2f73aa0b7eb9c82f0b5d71');
    expect(FIXED_TRACE_API_BUDGET_LADDER.tranches[0]).toMatchObject({ v2AdmissionFingerprint: smoke.fingerprints.aggregateAdmission, maximumProviderCalls: 192, maximumCostMicrodollars: 5_000_000, reservedMaximumMicrodollars: 2_819_484 });
    const sameAggregatesDifferentIdentity = structuredClone(smoke);
    sameAggregatesDifferentIdentity.fingerprints.aggregateAdmission = 'b'.repeat(64);
    expect(() => assertFixedTraceV2SmokeIdentity(sameAggregatesDifferentIdentity)).toThrow(/fingerprint/);
    const notReady = structuredClone(smoke);
    notReady.status = 'not_admitted';
    expect(() => assertFixedTraceV2SmokeIdentity(notReady)).toThrow(/ready/);
    const differentCohort = structuredClone(smoke);
    differentCohort.pricing.cohortDigest = 'sha256:other';
    expect(() => assertFixedTraceV2SmokeIdentity(differentCohort)).toThrow(/pricing cohort/);
  });

  it.each([
    (value: any) => { value.calibration = { id: 'invented', digest: hash() }; },
    (value: any) => { value.extra = 'top-level leak'; },
    (value: any) => { value.packets.pop(); },
    (value: any) => { value.candidateOutputs.pop(); },
    (value: any) => { delete value.candidateOutputs[0].architectureArm; },
    (value: any) => { value.candidateOutputs[0].extra = 'leak'; },
    (value: any) => { value.deterministicEvidence[0].extra = 'ignored-before'; },
    (value: any) => { value.randomization.extra = 'ignored-before'; },
    (value: any) => { value.judgments[0].extra = 'ignored-before'; },
    (value: any) => { value.budgetLedger.extra = 'forged'; },
  ])('rejects invented calibration, omitted treatment/cell/packet, or extra unverified evidence fields', (mutate) => {
    const value = input(); mutate(value);
    expect(assessFixedTraceModelJudgedDiagnostic(value).blockers).toContainEqual(expect.stringMatching(/^invalid_unverified_input:/));
  });

  it('allows ordinary task language while rejecting exact locked treatment identifiers and extra metadata', () => {
    expect(() => assertFixedTraceBlindedModelJudgePacket({
      ...packet(),
      prompt: 'How should a model select a provider under a cost and price budget?',
      candidateOutput: 'Compare model behavior, provider constraints, and cost without naming a treatment.',
    })).not.toThrow();
    expect(() => assertFixedTraceBlindedModelJudgePacket({ ...packet(), candidateOutput: 'Use indirect_generation and direct_generation_strategy.' })).not.toThrow();
    expect(() => assertFixedTraceBlindedModelJudgePacket({ ...packet(), candidateOutput: 'Use direct_generation.' })).toThrow(/exact locked-v2 treatment identifier/);
    expect(() => assertFixedTraceBlindedModelJudgePacket({ ...packet(), candidateOutput: 'Use generation:openai:gpt-5.6-luna:none.' })).toThrow(/exact locked-v2 treatment identifier/);
    expect(() => assertFixedTraceBlindedModelJudgePacket({ ...packet(), architecture: 'direct_generation' })).toThrow(/extra or missing fields/);
  });

  it.each([
    () => Object.defineProperty(packet(), 'prompt', { enumerable: true, get: () => 'getter' }),
    () => new Proxy(packet(), {}),
  ])('rejects hostile judge packets', (badPacket) => {
    expect(() => assertFixedTraceBlindedModelJudgePacket(badPacket())).toThrow();
  });

  it.each([
    (value: any) => { value.judgments.push({ ...value.judgments[0] }); },
    (value: any) => { value.judgments.push({ ...value.judgments[0], judgeProvider: 'other-1', judgeModel: 'judge-1' }, { ...value.judgments[0], judgeProvider: 'other-2', judgeModel: 'judge-2' }); },
    (value: any) => { value.candidateOutputs[0].outputStatus = 'missing'; value.candidateOutputs[0].candidateOutput = null; },
  ])('rejects duplicate or malformed structural judgment and output evidence', (mutate) => {
    const value = input(); mutate(value);
    expect(assessFixedTraceModelJudgedDiagnostic(value).blockers).toContainEqual(expect.stringMatching(/^invalid_unverified_input:/));
  });

  it('preserves structurally complete missingness and hard-gate failures for a future exact denominator', () => {
    for (const outcome of ['missing', 'refusal', 'malformed', 'abstain']) {
      const value = input(); value.judgments[0].outcome = outcome;
      expect(assessFixedTraceModelJudgedDiagnostic(value).blockers.some((blocker) => blocker.startsWith('invalid_unverified_input:'))).toBe(false);
    }
    const failedGate = input(); failedGate.deterministicEvidence[0].cost = false;
    expect(assessFixedTraceModelJudgedDiagnostic(failedGate).blockers.some((blocker) => blocker.startsWith('invalid_unverified_input:'))).toBe(false);
  });

  it('rejects floating point, negative zero, one-micro overage, cumulative overage, overlap, and forged structure', () => {
    const cases = [
      () => ({ ...ledger(), declaredCapMicrodollars: 1.5 }),
      () => ({ ...ledger(), declaredCapMicrodollars: -0 }),
      () => ({ ...ledger(), currentTrancheReservedMicrodollars: 2 }),
      () => ({ ...ledger(), priorReconciledObservedMicrodollars: 699_000_000, declaredCapMicrodollars: 2_000_000 }),
      () => ({ ...ledger(), priorOutstandingReservedMicrodollars: 1 }),
      () => ({ ...ledger(), priorUnknownExposureMicrodollars: 1 }),
      () => ({ ...ledger(), unverifiedAuthorizationReferenceDigest: 'external-signature' }),
    ];
    for (const build of cases) expect(() => assertFixedTraceUnverifiedTrancheLedgerShape(build())).toThrow();
  });

  it('distinguishes tranche cap from cumulative ceiling and never grants raw authority', () => {
    expect(() => assertFixedTraceUnverifiedTrancheLedgerShape(firstTrancheLedger())).not.toThrow();
    expect(() => assertFixedTraceUnverifiedTrancheLedgerShape({ ...firstTrancheLedger(), currentTrancheReservedMicrodollars: 5_000_001 })).toThrow(/tranche cost cap/);
    expect(() => assertFixedTraceUnverifiedTrancheLedgerShape({ ...ledger(), currentTrancheReservedMicrodollars: 2 })).toThrow(/tranche cost cap/);
    expect(() => assertFixedTraceUnverifiedTrancheLedgerShape({ ...ledger(), priorReconciledObservedMicrodollars: 700_000_000, declaredCapMicrodollars: 1 })).toThrow(/cumulative ceiling/);
    expect(assessFixedTraceModelJudgedDiagnostic(input())).toMatchObject({ admitted: false });
  });
});
