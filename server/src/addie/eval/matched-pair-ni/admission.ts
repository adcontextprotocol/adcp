/**
 * This diagnostic has no production admission path.  Its hard-coded reasons
 * intentionally cannot be supplied or overridden by a caller.
 */
export const MATCHED_PAIR_NI_ADMISSION = Object.freeze({
  admitted: false as const,
  reasons: Object.freeze([
    'missing_independent_reference_match',
    'continuous_type_i_certificate_review_required',
    'supported_n_has_no_confirmatory_sample_size_validation',
    'unvalidated_adaptive_reestimation',
  ] as const),
});

export type MatchedPairNiAdmission = typeof MATCHED_PAIR_NI_ADMISSION;
export function matchedPairNiAdmission(): MatchedPairNiAdmission { return MATCHED_PAIR_NI_ADMISSION; }

/** Deliberate one-way gate for any consumer tempted to promote a diagnostic. */
export function denyMatchedPairNiPromotion(_diagnostic: unknown): MatchedPairNiAdmission {
  return MATCHED_PAIR_NI_ADMISSION;
}
