/**
 * Evaluator-owned policy for the component-only smoke.  It deliberately
 * contains no credential, signer, authorization, or mutable ledger state.
 */
export const FIXED_TRACE_COMPONENT_SMOKE_ADMISSION_POLICY = Object.freeze({
  providerCeilingUsd: 5,
  budgetReservation: Object.freeze({
    policy: 'evaluator_owned_per_authorization_private_ledger_required',
    replay: 'one_use_external_authorization_required_no_caller_ledger_or_reservation',
    concurrency: 'exclusive_reservation_required_before_any_provider_dispatch',
    unknownExposure: 'preserved_in_spend_and_denominator_then_admission_closed',
  }),
  dispatch: Object.freeze({
    defaultOff: true,
    currentModuleCanDispatch: false,
    ambientEnvironmentAuthority: false,
    requiredAuthorization: 'explicit_one_use_external_paid_authorization',
  }),
  evidence: Object.freeze({
    permittedClaims: 'mechanical_feasibility_only',
    permanentlyNonPromotable: true,
    prohibitedClaims: Object.freeze([
      'architecture', 'quality', 'safety_rate', 'noninferiority', 'superiority',
      'final', 'tuning', 'corpus_count', 'production',
    ]),
  }),
  denominator: Object.freeze({
    unit: 'case_cell_assignment_and_each_provider_invocation',
    prepared: 'included',
    dispatched: 'included',
    failed: 'included',
    unknownExposure: 'included_and_spend_reserved',
    omissions: 'failure',
  }),
} as const);
