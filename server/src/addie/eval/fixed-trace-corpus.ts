/**
 * Partitioned-corpus seam for the diagnostic architecture planner.
 *
 * The existing fixed-trace runner deliberately continues to import
 * `fixed-trace-suite` and therefore retains its established 32-case live
 * evaluator contract. Planner/foundation work must import this module instead
 * and bind one returned phase plan to one architecture arm.
 */
export {
  FIXED_TRACE_CORPUS,
  FIXED_TRACE_CORPUS_VERSION,
  FIXED_TRACE_LEGACY_COVERAGE_INVENTORY,
  FIXED_TRACE_FICTIONAL_IDENTITY_MANIFEST,
  FIXED_TRACE_PHASE_COUNTS,
  FIXED_TRACE_PHASE_TARGETS,
  candidateVisibleTraceInput,
  fixedTraceCasesForPhase,
  fixedTraceCorpusSha256,
  fixedTraceCorpusValidationReport,
  fixedTraceCoverageInventory,
  fixedTracePhaseSha256,
  validateFixedTraceCorpus,
} from './fixed-trace-suite.js';
export {
  candidateVisibleMarkerOverlap,
  fixedTraceTuningSemanticSha256,
  validateFixedTraceCorpusSemanticAuthority,
  validateFixedTraceCorpusToolContracts,
} from './fixed-trace-corpus-contracts.js';
export {
  FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY,
  FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY_VERSION,
} from './fixed-trace-corpus-authority.js';
export type {
  FixedTraceCorpusCase,
  FixedTraceCorpusCoverageInventory,
  FixedTraceCorpusReviewedLock,
  FixedTraceCorpusValidationReport,
  FixedTracePhase,
} from './fixed-trace-suite.js';
