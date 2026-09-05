/**
 * Evaluator-only corpus surface. Do not import this from candidate dispatch:
 * it intentionally contains private fixtures, grading expectations, and exact
 * tool inputs. Candidate dispatch imports `fixed-trace-corpus` instead.
 */
export {
  FIXED_TRACE_CORPUS,
  FIXED_TRACE_CORPUS_VERSION,
  FIXED_TRACE_LEGACY_COVERAGE_INVENTORY,
  FIXED_TRACE_FICTIONAL_IDENTITY_MANIFEST,
  FIXED_TRACE_PHASE_COUNTS,
  FIXED_TRACE_PHASE_TARGETS,
  fixedTraceCasesForPhase,
  fixedTraceCorpusSha256,
  fixedTraceCorpusValidationReport,
  fixedTraceCoverageInventory,
  fixedTracePhaseSha256,
  validateFixedTraceCandidateVisibleLeakage,
  validateFixedTraceCorpus,
} from './fixed-trace-suite.js';
export {
  candidateVisibleMarkerOverlap,
  fixedTraceTuningSemanticSha256,
  validateFixedTraceCandidateInputProvenance,
  validateFixedTraceCorpusSemanticAuthority,
  validateFixedTraceCorpusToolContracts,
} from './fixed-trace-corpus-contracts.js';
export {
  FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY,
  FIXED_TRACE_TUNING_SEMANTIC_AUTHORITY_VERSION,
} from './fixed-trace-corpus-authority.js';
export { detachFixedTraceSnapshot } from './fixed-trace-corpus-snapshot.js';
export type {
  FixedTraceCorpusCase,
  FixedTraceCorpusCoverageInventory,
  FixedTraceCorpusReviewedLock,
  FixedTraceCorpusValidationReport,
  FixedTracePhase,
} from './fixed-trace-suite.js';
