import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL,
  assertFixedTraceEvaluationProtocol,
  assertFixedTraceEvaluationProtocolTrusted,
  estimateFixedTraceEvaluationProtocol,
  fixedTraceEvaluationProtocolFingerprint,
  fixedTraceEvaluationProtocolRunnerBinding,
  type FixedTraceEvaluationProtocol,
} from '../../../src/addie/eval/fixed-trace-evaluation-protocol.js';

function protocol(): FixedTraceEvaluationProtocol {
  return structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
}

describe('fixed-trace evaluation protocol projection', () => {
  it('is an exact, non-dispatchable ceiling with staged case and call counts', () => {
    const estimate = estimateFixedTraceEvaluationProtocol(protocol());
    expect(estimate.dispatchable).toBe(false);
    expect(estimate.expectedSpendUsd).toBeNull();
    expect(estimate.phases.map((phase) => [phase.phaseId, phase.uniqueCaseCount, phase.repetitions, phase.candidateCalls, phase.judgeCalls])).toEqual([
      ['bounded_smoke', 8, 1, 104, 0],
      ['router_screen', 46, 3, 828, 0],
      ['oracle_generator_ceiling', 46, 2, 7_728, 1_288],
      ['deployable_architecture', 46, 3, 10_626, 1_656],
      ['controlled_tuning', 36, 3, 2_808, 432],
      ['sealed_final', 38, 3, 2_964, 456],
    ]);
    expect(estimate.stages.every((stage) => stage.cacheMode === 'disabled')).toBe(true);
    expect(estimate.stages.every((stage) => stage.inputTokenCeiling === stage.requests * (
      stage.role === 'router' ? 4_096 : stage.role === 'generation' ? 16_384 : 8_192
    ))).toBe(true);
    expect(estimate.screening.totalCeilingUsd).toBeGreaterThan(0);
    expect(estimate.finalConfirmation.totalCeilingUsd).toBeGreaterThan(0);
    expect(estimate.totalCeilingUsd).toBe(
      estimate.candidateCeilingUsd + estimate.judgeCeilingUsd + estimate.contingencyUsd,
    );
    expect(estimate.approvalCeilingUsd).toBe(1_491);
  });

  it('keeps model, effort, output, cache, and timeout controls in the fingerprint', () => {
    const baseline = protocol();
    const changed = protocol();
    changed.phases[1].arms[1].stages[0].reasoningEffort = 'low';
    expect(fixedTraceEvaluationProtocolFingerprint(changed)).not.toBe(
      fixedTraceEvaluationProtocolFingerprint(baseline),
    );
    changed.phases[1].arms[1].stages[0].maxOutputTokensPerInvocation++;
    expect(estimateFixedTraceEvaluationProtocol(changed).totalCeilingUsd).toBeGreaterThan(
      estimateFixedTraceEvaluationProtocol(baseline).totalCeilingUsd,
    );
  });

  it('fails closed for unavailable pricing, self-judging, and mixed contracts', () => {
    const unknownPricing = protocol();
    unknownPricing.phases[1].arms[0].stages[0].pricingProfileId = 'unknown';
    expect(() => estimateFixedTraceEvaluationProtocol(unknownPricing)).toThrow('Unavailable immutable pricing profile');

    const selfJudge = protocol();
    const oracleOpenAi = selfJudge.phases[2].arms.find((arm) => arm.id === 'oracle-terra-low')!;
    oracleOpenAi.stages[1].provider = 'openai';
    oracleOpenAi.stages[1].model = 'gpt-5.6-terra';
    oracleOpenAi.stages[1].pricingProfileId = 'openai-gpt-5.6-standard-2026-09-05:gpt-5.6-terra';
    expect(() => assertFixedTraceEvaluationProtocol(selfJudge)).toThrow('not provider-independent');

    const duplicate = protocol();
    duplicate.phases[1].arms.push(structuredClone(duplicate.phases[1].arms[0]));
    expect(() => assertFixedTraceEvaluationProtocol(duplicate)).toThrow('Duplicate protocol arm ID');
  });

  it('requires an evaluator-owned manifest before a protocol can become executable evidence', () => {
    const current = protocol();
    const fingerprint = fixedTraceEvaluationProtocolFingerprint(current);
    expect(() => assertFixedTraceEvaluationProtocolTrusted(current, () => null)).toThrow('Trusted evaluation manifest is unavailable');
    const trusted = {
      id: current.trustedManifestId,
      protocolFingerprint: fingerprint,
      sourceId: 'externally-sealed-addie-v120',
      sourceRevision: 'sealed-revision-1',
      traceSuiteSha256: 'b'.repeat(64),
      tracePackSha256: 'a'.repeat(64),
      rawLedgerVersion: 'addie-fixed-trace-raw-ledger-v2',
      partitions: Object.fromEntries(current.phases.map((phase) => [phase.id, phase.uniqueCaseCount])),
      verifiedAdmissions: ['planning_only', 'requires_verified_hybrid_contract', 'requires_verified_direct_contract'] as const,
    };
    expect(assertFixedTraceEvaluationProtocolTrusted(current, (id) => id === trusted.id ? trusted : null)).toBe(trusted);
    expect(fixedTraceEvaluationProtocolRunnerBinding(current, (id) => id === trusted.id ? trusted : null)).toEqual({
      trustedManifestId: trusted.id,
      protocolFingerprint: fingerprint,
      traceSuiteSha256: 'b'.repeat(64),
    });
    trusted.partitions.sealed_final = 37;
    expect(() => assertFixedTraceEvaluationProtocolTrusted(current, (id) => id === trusted.id ? trusted : null)).toThrow('count mismatch');
    trusted.partitions.sealed_final = 38;
    trusted.traceSuiteSha256 = 'not-a-digest';
    expect(() => assertFixedTraceEvaluationProtocolTrusted(current, (id) => id === trusted.id ? trusted : null)).toThrow('does not bind');
  });
});
