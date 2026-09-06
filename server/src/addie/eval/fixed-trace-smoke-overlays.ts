import { createHash } from 'node:crypto';
import { detachFixedTraceSnapshot } from './fixed-trace-corpus-snapshot.js';

/**
 * This is an evaluator-owned component probe, not a corpus overlay. It binds
 * to the reviewed source case only to record provenance; it deliberately does
 * not replay its request, fixtures, rubric, or semantic conclusion.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_VERSION = 'addie-fixed-trace-component-smoke-v2' as const;
export const FIXED_TRACE_COMPONENT_SMOKE_ID = 'component-admin-two-receipt-loop-v1' as const;

const PARENT_CASE = Object.freeze({
  id: 'admin-member-records-without-slack',
  corpusVersion: 'addie-fixed-traces-v32',
  phase: 'development',
  // Domain-separated digest of the locked corpus case, captured before this
  // derived probe was authored. It is provenance only, never a substitute for
  // the parent case's two-receipt semantic comparison.
  semanticSha256: 'b528ad8b76a88aa31a359e7ecb22257d24bbd32fd73a00f630d0af65a164ca09',
} as const);

const COMPONENT_TOOL_DESCRIPTORS = Object.freeze([
  Object.freeze({ name: 'component_receipt_a', inputSchema: Object.freeze({ type: 'object' }) }),
  Object.freeze({ name: 'component_receipt_b', inputSchema: Object.freeze({ type: 'object' }) }),
] as const);

const REQUIRED_CALL_SEQUENCE = Object.freeze([
  Object.freeze({ name: 'component_receipt_a', input: Object.freeze({}) }),
  Object.freeze({ name: 'component_receipt_b', input: Object.freeze({}) }),
] as const);

export type FixedTraceComponentSmokeEvidenceUse =
  | 'component_descriptor_tool_loop_wiring'
  | 'tuning'
  | 'final'
  | 'architecture_comparison'
  | 'model_quality_scoring'
  | 'noninferiority'
  | 'corpus_count';

export interface FixedTraceComponentSmokeCase {
  readonly version: typeof FIXED_TRACE_COMPONENT_SMOKE_VERSION;
  readonly id: typeof FIXED_TRACE_COMPONENT_SMOKE_ID;
  readonly parent: typeof PARENT_CASE;
  /** Fresh, domain-separated identity for this derived, non-corpus probe. */
  readonly semanticSha256: string;
  readonly descriptors: readonly {
    readonly name: 'component_receipt_a' | 'component_receipt_b';
    readonly inputSchema: { readonly type: 'object' };
    readonly definitionSha256: string;
  }[];
  /** Only a wiring loop: values are opaque and carry no account semantics. */
  readonly requiredCallSequence: typeof REQUIRED_CALL_SEQUENCE;
  readonly evidence: {
    readonly owner: 'evaluator';
    readonly permittedUse: 'component_descriptor_tool_loop_wiring';
    readonly scoring: false;
    readonly architectureComparison: false;
    readonly modelQualityScoring: false;
    readonly noninferiority: false;
    readonly tuning: false;
    readonly final: false;
    readonly corpusCount: false;
  };
}

export class FixedTraceComponentSmokeError extends Error {
  constructor(readonly code: string) {
    super(`Fixed trace component smoke rejected: ${code}`);
    this.name = 'FixedTraceComponentSmokeError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FixedTraceComponentSmokeError('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new FixedTraceComponentSmokeError('non_json_value');
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({ domain, value }), 'utf8').digest('hex');
}

/** Verifies a parent binding without importing the production corpus surface. */
export function fixedTraceComponentSmokeParentSemanticSha256(parent: unknown): string {
  const detached = detachFixedTraceSnapshot(parent);
  if (!detached.snapshot) throw new FixedTraceComponentSmokeError(`unsafe_parent:${detached.error}`);
  return digest('addie-fixed-trace-smoke-overlays-v1/case-semantic/v1', detached.snapshot);
}

/** Bind a supplied locked parent at use time; a stale provenance record fails closed. */
export function assertFixedTraceComponentSmokeParentBinding(
  parent: unknown,
  smoke: FixedTraceComponentSmokeCase = FIXED_TRACE_COMPONENT_SMOKE,
): void {
  assertFixedTraceComponentSmokeContract(smoke);
  if (fixedTraceComponentSmokeParentSemanticSha256(parent) !== smoke.parent.semanticSha256) {
    throw new FixedTraceComponentSmokeError('parent_lineage_drift');
  }
}

function descriptorWithHash(descriptor: typeof COMPONENT_TOOL_DESCRIPTORS[number]) {
  return Object.freeze({ ...descriptor, definitionSha256: digest(`${FIXED_TRACE_COMPONENT_SMOKE_VERSION}/descriptor/v1`, descriptor) });
}

function componentSemanticSha256(caseRecord: Omit<FixedTraceComponentSmokeCase, 'semanticSha256'>): string {
  return digest(`${FIXED_TRACE_COMPONENT_SMOKE_VERSION}/case-semantic/v1`, caseRecord);
}

const componentCaseBase = Object.freeze({
  version: FIXED_TRACE_COMPONENT_SMOKE_VERSION,
  id: FIXED_TRACE_COMPONENT_SMOKE_ID,
  parent: PARENT_CASE,
  descriptors: Object.freeze(COMPONENT_TOOL_DESCRIPTORS.map(descriptorWithHash)),
  requiredCallSequence: REQUIRED_CALL_SEQUENCE,
  evidence: Object.freeze({
    owner: 'evaluator',
    permittedUse: 'component_descriptor_tool_loop_wiring',
    scoring: false,
    architectureComparison: false,
    modelQualityScoring: false,
    noninferiority: false,
    tuning: false,
    final: false,
    corpusCount: false,
  } as const),
} satisfies Omit<FixedTraceComponentSmokeCase, 'semanticSha256'>);

export const FIXED_TRACE_COMPONENT_SMOKE: FixedTraceComponentSmokeCase = Object.freeze({
  ...componentCaseBase,
  semanticSha256: componentSemanticSha256(componentCaseBase),
});

function requiredKeys(value: Record<string, unknown>, keys: readonly string[], owner: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new FixedTraceComponentSmokeError(`unknown_or_missing_fields:${owner}`);
  }
}

/** Reject everything except the single, evaluator-owned wiring use. */
export function assertFixedTraceComponentSmokeEvidenceUse(
  use: FixedTraceComponentSmokeEvidenceUse,
  smoke: FixedTraceComponentSmokeCase = FIXED_TRACE_COMPONENT_SMOKE,
): void {
  assertFixedTraceComponentSmokeContract(smoke);
  if (use !== 'component_descriptor_tool_loop_wiring') {
    throw new FixedTraceComponentSmokeError(`evidence_promotion_blocked:${use}`);
  }
}

/**
 * Validate the derived identity before it reaches even the local simulator.
 * The component case is intentionally not assignable to a corpus case and
 * cannot be used to augment source-corpus counts.
 */
export function assertFixedTraceComponentSmokeContract(
  smoke: FixedTraceComponentSmokeCase = FIXED_TRACE_COMPONENT_SMOKE,
): void {
  const detached = detachFixedTraceSnapshot(smoke);
  if (!detached.snapshot) throw new FixedTraceComponentSmokeError(`unsafe_snapshot:${detached.error}`);
  const snapshot = detached.snapshot as FixedTraceComponentSmokeCase;
  requiredKeys(snapshot as unknown as Record<string, unknown>, [
    'version', 'id', 'parent', 'semanticSha256', 'descriptors', 'requiredCallSequence', 'evidence',
  ], 'component_smoke');
  requiredKeys(snapshot.parent as unknown as Record<string, unknown>, ['id', 'corpusVersion', 'phase', 'semanticSha256'], 'parent');
  requiredKeys(snapshot.evidence as unknown as Record<string, unknown>, [
    'owner', 'permittedUse', 'scoring', 'architectureComparison', 'modelQualityScoring', 'noninferiority', 'tuning', 'final', 'corpusCount',
  ], 'evidence');
  if (
    snapshot.version !== FIXED_TRACE_COMPONENT_SMOKE_VERSION
    || snapshot.id !== FIXED_TRACE_COMPONENT_SMOKE_ID
    || snapshot.descriptors.length !== 2
    || snapshot.requiredCallSequence.length !== 2
    || snapshot.evidence.owner !== 'evaluator'
    || snapshot.evidence.permittedUse !== 'component_descriptor_tool_loop_wiring'
    || snapshot.evidence.scoring !== false
    || snapshot.evidence.architectureComparison !== false
    || snapshot.evidence.modelQualityScoring !== false
    || snapshot.evidence.noninferiority !== false
    || snapshot.evidence.tuning !== false
    || snapshot.evidence.final !== false
    || snapshot.evidence.corpusCount !== false
  ) throw new FixedTraceComponentSmokeError('component_identity_or_admission_mismatch');
  if (canonicalJson(snapshot.parent) !== canonicalJson(PARENT_CASE)) {
    throw new FixedTraceComponentSmokeError('parent_lineage_mismatch');
  }
  const expectedDescriptors = COMPONENT_TOOL_DESCRIPTORS.map(descriptorWithHash);
  if (canonicalJson(snapshot.descriptors) !== canonicalJson(expectedDescriptors)
    || canonicalJson(snapshot.requiredCallSequence) !== canonicalJson(REQUIRED_CALL_SEQUENCE)) {
    throw new FixedTraceComponentSmokeError('component_tool_sequence_mismatch');
  }
  const { semanticSha256: _semanticSha256, ...base } = snapshot;
  if (snapshot.semanticSha256 !== componentSemanticSha256(base)) {
    throw new FixedTraceComponentSmokeError('component_semantic_hash_mismatch');
  }
}

export interface FixedTraceComponentSmokeSimulator {
  execute(calls: readonly { readonly name: string; readonly input: Record<string, never> }[]): {
    readonly status: 'component_complete';
    readonly receipts: readonly { readonly name: string; readonly definitionSha256: string }[];
  };
}

/**
 * In-memory only. Callers must supply the exact loop; the simulator neither
 * defaults calls nor prewrites a semantic answer or external-account state.
 */
export function createFixedTraceComponentSmokeSimulator(
  parent: unknown,
  smoke: FixedTraceComponentSmokeCase = FIXED_TRACE_COMPONENT_SMOKE,
): FixedTraceComponentSmokeSimulator {
  assertFixedTraceComponentSmokeParentBinding(parent, smoke);
  return Object.freeze({
    execute(calls: readonly { readonly name: string; readonly input: Record<string, never> }[]) {
      if (!Array.isArray(calls)) throw new FixedTraceComponentSmokeError('unsafe_calls:non_array');
      const detached = detachFixedTraceSnapshot(calls);
      if (!detached.snapshot || !Array.isArray(detached.snapshot)) {
        throw new FixedTraceComponentSmokeError(`unsafe_calls:${detached.error ?? 'non_array'}`);
      }
      if (canonicalJson(detached.snapshot) !== canonicalJson(smoke.requiredCallSequence)) {
        throw new FixedTraceComponentSmokeError('call_sequence_mismatch');
      }
      return Object.freeze({
        status: 'component_complete' as const,
        receipts: Object.freeze(smoke.descriptors.map(({ name, definitionSha256 }) => Object.freeze({ name, definitionSha256 }))),
      });
    },
  });
}

/** No architecture arm is accepted: this is not an architecture presentation. */
export function fixedTraceComponentSmokePresentation(
  id: typeof FIXED_TRACE_COMPONENT_SMOKE_ID,
): FixedTraceComponentSmokeCase {
  if (arguments.length !== 1) throw new FixedTraceComponentSmokeError('unexpected_presentation_argument');
  assertFixedTraceComponentSmokeContract();
  if (id !== FIXED_TRACE_COMPONENT_SMOKE_ID) throw new FixedTraceComponentSmokeError(`case_missing:${id}`);
  return FIXED_TRACE_COMPONENT_SMOKE;
}
