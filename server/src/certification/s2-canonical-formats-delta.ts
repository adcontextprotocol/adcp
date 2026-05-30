export const S2_CANONICAL_FORMATS_DELTA_UPDATE_ID = 's2_canonical_formats_3_1';
export const S2_CANONICAL_FORMATS_MODULE_ID = 'S2';
export const S2_CANONICAL_FORMATS_CREDENTIAL_ID = 'specialist_creative';

export const S2_CANONICAL_FORMATS_CRITERION_IDS = [
  's2_ex1_sc_format_kind_selection',
  's2_ex1_sc_format_options_cardinality',
  's2_ex1_sc_option_vs_capability_id',
  's2_ex1_sc_source_taxonomy',
  's2_ex1_sc_validation_order',
] as const;

export interface S2CanonicalFormatsDeltaReleaseSetting {
  adcp_3_1_ga_at: string | null;
  criteria_deployed_at: string | null;
}

export type S2CanonicalFormatsDeltaStatusKind =
  | 'gated'
  | 'not_required'
  | 'delta_available'
  | 'delta_completed'
  | 'full_recertification_required';

export interface S2CanonicalFormatsDeltaStatus {
  update_id: typeof S2_CANONICAL_FORMATS_DELTA_UPDATE_ID;
  module_id: typeof S2_CANONICAL_FORMATS_MODULE_ID;
  credential_id: typeof S2_CANONICAL_FORMATS_CREDENTIAL_ID;
  status: S2CanonicalFormatsDeltaStatusKind;
  active: boolean;
  reason: string;
  adcp_3_1_ga_at: string | null;
  criteria_deployed_at: string | null;
  criteria_effective_at: string | null;
  delta_window_opens_at: string | null;
  delta_window_closes_at: string | null;
  missing_criterion_ids: string[];
}

export interface S2CanonicalFormatsDeltaInput {
  release: S2CanonicalFormatsDeltaReleaseSetting | null;
  hasCreativeSpecialistCredential: boolean;
  credentialAwardedAt: string | null;
  s2CompletedAt: string | null;
  deltaCompletedAt?: string | null;
  canonicalCriteriaPresent?: boolean;
  hasPriorAuditableS2Record?: boolean;
  verifiedCriterionIds: string[];
  now?: Date;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function addUtcCalendarDaysEndOfDay(value: Date, days: number): Date {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate() + days,
    23,
    59,
    59,
    999,
  ));
}

function baseStatus(
  release: S2CanonicalFormatsDeltaReleaseSetting | null,
  status: S2CanonicalFormatsDeltaStatusKind,
  active: boolean,
  reason: string,
  criteriaEffectiveAt: Date | null,
  missingCriterionIds: string[] = [],
): S2CanonicalFormatsDeltaStatus {
  return {
    update_id: S2_CANONICAL_FORMATS_DELTA_UPDATE_ID,
    module_id: S2_CANONICAL_FORMATS_MODULE_ID,
    credential_id: S2_CANONICAL_FORMATS_CREDENTIAL_ID,
    status,
    active,
    reason,
    adcp_3_1_ga_at: release?.adcp_3_1_ga_at ?? null,
    criteria_deployed_at: release?.criteria_deployed_at ?? null,
    criteria_effective_at: toIso(criteriaEffectiveAt),
    delta_window_opens_at: toIso(criteriaEffectiveAt),
    delta_window_closes_at: criteriaEffectiveAt ? toIso(addUtcCalendarDaysEndOfDay(criteriaEffectiveAt, 90)) : null,
    missing_criterion_ids: missingCriterionIds,
  };
}

export function computeS2CanonicalFormatsDeltaStatus(
  input: S2CanonicalFormatsDeltaInput,
): S2CanonicalFormatsDeltaStatus {
  const gaAt = parseDate(input.release?.adcp_3_1_ga_at);
  const deployedAt = parseDate(input.release?.criteria_deployed_at);

  if (!gaAt || !deployedAt) {
    const missing = [
      !gaAt ? 'AdCP 3.1.0 GA date' : null,
      !deployedAt ? 'production deployment date for migration 496_curriculum_3_1_canonical_formats_criteria.sql' : null,
    ].filter(Boolean).join(' and ');
    return baseStatus(input.release, 'gated', false, `Blocked until ${missing} is configured.`, null);
  }

  const criteriaEffectiveAt = new Date(Math.max(gaAt.getTime(), deployedAt.getTime()));
  const deltaWindowClosesAt = addUtcCalendarDaysEndOfDay(criteriaEffectiveAt, 90);
  const now = input.now ?? new Date();

  if (input.canonicalCriteriaPresent === false) {
    return baseStatus(
      input.release,
      'gated',
      false,
      'Blocked until the five AdCP 3.1 S2 canonical-format criteria are present in certification_modules.exercise_definitions.',
      criteriaEffectiveAt,
    );
  }

  if (now < criteriaEffectiveAt) {
    return baseStatus(
      input.release,
      'gated',
      false,
      'Blocked until the later of AdCP 3.1.0 GA and production deployment of the S2 canonical-format criteria.',
      criteriaEffectiveAt,
    );
  }

  if (!input.hasCreativeSpecialistCredential) {
    return baseStatus(
      input.release,
      'not_required',
      true,
      'Learner does not hold the S2 Creative specialist credential.',
      criteriaEffectiveAt,
    );
  }

  const awardedAt = parseDate(input.credentialAwardedAt);
  const completedAt = parseDate(input.s2CompletedAt);
  const deltaCompletedAt = parseDate(input.deltaCompletedAt);

  if (completedAt && completedAt >= criteriaEffectiveAt) {
    return baseStatus(
      input.release,
      'not_required',
      true,
      'S2 completion is already on or after the AdCP 3.1 canonical-format criteria effective point.',
      criteriaEffectiveAt,
    );
  }

  if (!completedAt) {
    if (awardedAt && awardedAt >= criteriaEffectiveAt) {
      return baseStatus(
        input.release,
        'not_required',
        true,
        'S2 credential was awarded after the AdCP 3.1 canonical-format criteria effective point.',
        criteriaEffectiveAt,
      );
    }
    return baseStatus(
      input.release,
      'full_recertification_required',
      true,
      'Prior S2 completion record is missing, so the learner does not meet the auditable-record requirement for a delta.',
      criteriaEffectiveAt,
      [...S2_CANONICAL_FORMATS_CRITERION_IDS],
    );
  }

  const verified = new Set(input.verifiedCriterionIds);
  const missingCriterionIds = S2_CANONICAL_FORMATS_CRITERION_IDS.filter(id => !verified.has(id));

  if (deltaCompletedAt) {
    return baseStatus(
      input.release,
      'delta_completed',
      true,
      'Learner has auditable evidence for all AdCP 3.1 S2 canonical-format criteria.',
      criteriaEffectiveAt,
    );
  }

  if (input.hasPriorAuditableS2Record === false) {
    return baseStatus(
      input.release,
      'full_recertification_required',
      true,
      'Prior S2 checkpoint trail is missing, so the learner does not meet the auditable-record requirement for a delta.',
      criteriaEffectiveAt,
      missingCriterionIds,
    );
  }

  if (now > deltaWindowClosesAt) {
    return baseStatus(
      input.release,
      'full_recertification_required',
      true,
      'The S2 canonical-formats delta window has closed.',
      criteriaEffectiveAt,
      missingCriterionIds,
    );
  }

  return baseStatus(
    input.release,
    'delta_available',
    true,
    'Pre-3.1 S2 holder is eligible for the canonical-formats delta assessment.',
    criteriaEffectiveAt,
    missingCriterionIds,
  );
}
