/**
 * Candidate-facing corpus boundary. It can project requests but never exports
 * evaluator fixtures, expectations, phases, or exact replay inputs. Evaluator
 * code must import `fixed-trace-corpus-evaluator` explicitly.
 */
import {
  FIXED_TRACE_CORPUS,
  candidateVisibleTraceInput,
  type FixedTracePhase,
} from './fixed-trace-suite.js';

export { candidateVisibleTraceInput } from './fixed-trace-suite.js';
export type { FixedTracePhase } from './fixed-trace-suite.js';

/** Candidate material for one phase, detached from all evaluator controls. */
export function fixedTraceCandidateInputsForPhase(phase: FixedTracePhase): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return Object.freeze(FIXED_TRACE_CORPUS
    .filter((trace) => trace.phase === phase)
    .map((trace) => candidateVisibleTraceInput(trace)));
}
