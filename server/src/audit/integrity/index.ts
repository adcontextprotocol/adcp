/**
 * Public surface of the integrity-invariants module.
 */
export type {
  Severity,
  SubjectType,
  Violation,
  InvariantOptions,
  InvariantContext,
  InvariantResult,
  Invariant,
  InvariantRunStats,
  InvariantRunReport,
} from './types.js';

export { runAllInvariants, runOneInvariant } from './runner.js';
export { ALL_INVARIANTS, getInvariantByName } from './invariants/index.js';
