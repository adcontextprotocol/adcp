import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertFixedTraceComponentSmokeContract,
  assertFixedTraceComponentSmokeEvidenceUse,
  assertFixedTraceComponentSmokeParentBinding,
  createFixedTraceComponentSmokeSimulator,
  FixedTraceComponentSmokeError,
  FIXED_TRACE_COMPONENT_SMOKE,
  FIXED_TRACE_COMPONENT_SMOKE_ID,
  fixedTraceComponentSmokeParentSemanticSha256,
  fixedTraceComponentSmokePresentation,
} from '../../../src/addie/eval/fixed-trace-smoke-overlays.js';
import { FIXED_TRACE_CORPUS } from '../../../src/addie/eval/fixed-trace-suite.js';

function rejectionCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FixedTraceComponentSmokeError);
    return (error as FixedTraceComponentSmokeError).code;
  }
  throw new Error('Expected evaluator boundary rejection');
}

describe('fixed-trace evaluator-owned component smoke', () => {
  it('does not import the shared diagnostic universe or any production admin, billing, or provider surface', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-smoke-overlays.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('direct-tool-universe');
    expect(source).not.toContain('/mcp/');
    expect(source).not.toContain('model-providers');
  });

  it('is a distinct non-scoring derived case bound to—not masquerading as—its parent', () => {
    expect(() => assertFixedTraceComponentSmokeContract()).not.toThrow();
    expect(FIXED_TRACE_COMPONENT_SMOKE.id).not.toBe(FIXED_TRACE_COMPONENT_SMOKE.parent.id);
    expect(FIXED_TRACE_COMPONENT_SMOKE.evidence).toMatchObject({
      owner: 'evaluator', permittedUse: 'component_descriptor_tool_loop_wiring', scoring: false,
      architectureComparison: false, modelQualityScoring: false, noninferiority: false,
      tuning: false, final: false, corpusCount: false,
    });
    expect(FIXED_TRACE_CORPUS.some((candidate) => candidate.id === FIXED_TRACE_COMPONENT_SMOKE.id)).toBe(false);
    const parent = FIXED_TRACE_CORPUS.find((candidate) => candidate.id === FIXED_TRACE_COMPONENT_SMOKE.parent.id)!;
    expect(fixedTraceComponentSmokeParentSemanticSha256(parent)).toBe(FIXED_TRACE_COMPONENT_SMOKE.parent.semanticSha256);
  });

  it('uses neutral opaque descriptors and only accepts a caller-supplied two-receipt wiring loop', () => {
    const parent = FIXED_TRACE_CORPUS.find((candidate) => candidate.id === FIXED_TRACE_COMPONENT_SMOKE.parent.id)!;
    const simulator = createFixedTraceComponentSmokeSimulator(parent);
    expect(rejectionCode(() => (simulator.execute as unknown as () => unknown)())).toBe('unsafe_calls:non_array');
    expect(simulator.execute(FIXED_TRACE_COMPONENT_SMOKE.requiredCallSequence)).toEqual({
      status: 'component_complete',
      receipts: FIXED_TRACE_COMPONENT_SMOKE.descriptors.map(({ name, definitionSha256 }) => ({ name, definitionSha256 })),
    });
  });

  it('rejects case-id/hash collisions, parent-lineage drift, tool-sequence edits, and invented semantic facts', () => {
    const collision = structuredClone(FIXED_TRACE_COMPONENT_SMOKE);
    (collision as { id: string }).id = collision.parent.id;
    expect(rejectionCode(() => assertFixedTraceComponentSmokeContract(collision))).toBe('component_identity_or_admission_mismatch');

    const parentDrift = structuredClone(FIXED_TRACE_COMPONENT_SMOKE);
    (parentDrift.parent as { semanticSha256: string }).semanticSha256 = '0'.repeat(64);
    expect(rejectionCode(() => assertFixedTraceComponentSmokeContract(parentDrift))).toBe('parent_lineage_mismatch');

    const semanticCollision = structuredClone(FIXED_TRACE_COMPONENT_SMOKE);
    semanticCollision.semanticSha256 = semanticCollision.parent.semanticSha256;
    expect(rejectionCode(() => assertFixedTraceComponentSmokeContract(semanticCollision))).toBe('component_semantic_hash_mismatch');

    const sequence = structuredClone(FIXED_TRACE_COMPONENT_SMOKE);
    sequence.requiredCallSequence.reverse();
    expect(rejectionCode(() => assertFixedTraceComponentSmokeContract(sequence))).toBe('component_tool_sequence_mismatch');

    const inventedFact = structuredClone(FIXED_TRACE_COMPONENT_SMOKE) as Record<string, unknown>;
    inventedFact.semanticFact = 'a synthetic member has no Slack account';
    expect(rejectionCode(() => assertFixedTraceComponentSmokeContract(inventedFact as typeof FIXED_TRACE_COMPONENT_SMOKE)))
      .toBe('unknown_or_missing_fields:component_smoke');
  });

  it('rejects altered runtime loops and results because result truth remains evaluator-owned', () => {
    const parent = FIXED_TRACE_CORPUS.find((candidate) => candidate.id === FIXED_TRACE_COMPONENT_SMOKE.parent.id)!;
    const simulator = createFixedTraceComponentSmokeSimulator(parent);
    expect(rejectionCode(() => simulator.execute([
      ...FIXED_TRACE_COMPONENT_SMOKE.requiredCallSequence,
      { name: 'component_receipt_a', input: {} },
    ]))).toBe('call_sequence_mismatch');
    expect(rejectionCode(() => simulator.execute([
      { name: 'component_receipt_a', input: {}, result: 'invented account state' },
      FIXED_TRACE_COMPONENT_SMOKE.requiredCallSequence[1]!,
    ] as never))).toBe('call_sequence_mismatch');
  });

  it('requires the parent at simulator construction and rejects a drifted corpus parent', () => {
    const parent = structuredClone(FIXED_TRACE_CORPUS.find((candidate) => candidate.id === FIXED_TRACE_COMPONENT_SMOKE.parent.id)!);
    parent.toolFixtures[0]!.result = 'altered source receipt';
    expect(rejectionCode(() => assertFixedTraceComponentSmokeParentBinding(parent))).toBe('parent_lineage_drift');
    expect(rejectionCode(() => createFixedTraceComponentSmokeSimulator(parent))).toBe('parent_lineage_drift');
  });

  it('has no arm parameter and fails closed on arm misuse or any scored-evidence promotion', () => {
    expect(fixedTraceComponentSmokePresentation(FIXED_TRACE_COMPONENT_SMOKE_ID)).toBe(FIXED_TRACE_COMPONENT_SMOKE);
    expect(rejectionCode(() => (fixedTraceComponentSmokePresentation as unknown as (...args: unknown[]) => unknown)(
      FIXED_TRACE_COMPONENT_SMOKE_ID, 'direct_generation',
    ))).toBe('unexpected_presentation_argument');
    for (const target of [
      'tuning', 'final', 'architecture_comparison', 'model_quality_scoring', 'noninferiority', 'corpus_count',
    ] as const) {
      expect(rejectionCode(() => assertFixedTraceComponentSmokeEvidenceUse(target))).toBe(`evidence_promotion_blocked:${target}`);
    }
  });
});
