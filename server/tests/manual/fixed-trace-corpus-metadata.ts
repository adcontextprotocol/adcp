/**
 * Deterministic, no-provider corpus audit. It intentionally prints only
 * partition metadata (never requests, fixtures, expectations, or answers).
 *
 * npm run validate:addie-fixed-traces
 */
import {
  FIXED_TRACE_CORPUS,
  fixedTraceCoverageInventory,
  fixedTraceCorpusValidationReport,
  validateFixedTraceCorpusToolContracts,
} from '../../src/addie/eval/fixed-trace-corpus.js';

const report = fixedTraceCorpusValidationReport();
const structuralFailures = [
  ...report.failures,
  ...validateFixedTraceCorpusToolContracts(FIXED_TRACE_CORPUS),
];
if (structuralFailures.length) throw new Error(`Fixed trace corpus validation failed: ${structuralFailures.join(', ')}`);
const inventory = fixedTraceCoverageInventory();
console.log(JSON.stringify({
  version: inventory.version,
  total: inventory.total,
  sealedFinalTarget: inventory.sealedFinalTarget,
  sealedFinalDeficit: inventory.sealedFinalDeficit,
  phaseCounts: inventory.phaseCounts,
  categoryCounts: inventory.categoryCounts,
  nearDuplicateCandidateRequests: inventory.nearDuplicateCandidateRequests,
  crossPhaseStructuralFingerprintDuplicates: inventory.crossPhaseStructuralFingerprintDuplicates,
  highSimilarityRequestPairs: inventory.highSimilarityRequestPairs,
  phaseBehavior: inventory.phaseBehavior,
  suiteSha256: inventory.suiteSha256,
  phaseSha256: inventory.phaseSha256,
  trustedLockVerified: report.trustedLockVerified,
  manualFictionalIdentityReviewRequired: true,
}, null, 2));
