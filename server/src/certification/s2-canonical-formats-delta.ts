import type { DeltaDefinition } from '../config/recertification-deltas.js';
import { S2_DELTA_DEFINITION } from '../config/recertification-deltas.js';

export const S2_CANONICAL_FORMATS_DELTA_UPDATE_ID = S2_DELTA_DEFINITION.update_id;
export const S2_CANONICAL_FORMATS_MODULE_ID = S2_DELTA_DEFINITION.module_id;
export const S2_CANONICAL_FORMATS_CREDENTIAL_ID = S2_DELTA_DEFINITION.credential_id;

export const S2_CANONICAL_FORMATS_CRITERION_IDS = S2_DELTA_DEFINITION.criterion_ids;

export interface ProtocolDeltaReleaseSetting {
  adcp_3_1_ga_at: string | null;
  criteria_deployed_at: string | null;
}

export type ProtocolDeltaStatusKind =
  | 'gated'
  | 'not_required'
  | 'delta_available'
  | 'delta_completed'
  | 'full_recertification_required';

export interface ProtocolDeltaStatus {
  update_id: string;
  module_id: string;
  credential_id: string;
  status: ProtocolDeltaStatusKind;
  active: boolean;
  reason: string;
  adcp_3_1_ga_at: string | null;
  criteria_deployed_at: string | null;
  criteria_effective_at: string | null;
  delta_window_opens_at: string | null;
  delta_window_closes_at: string | null;
  missing_criterion_ids: string[];
}

export interface ProtocolDeltaInput {
  release: ProtocolDeltaReleaseSetting | null;
  hasCredential: boolean;
  credentialAwardedAt: string | null;
  moduleCompletedAt: string | null;
  deltaCompletedAt?: string | null;
  criteriaPresent?: boolean;
  hasPriorAuditableRecord?: boolean;
  verifiedCriterionIds: string[];
  now?: Date;
}

// ---------------------------------------------------------------------------
// Back-compat S2 surface
// ---------------------------------------------------------------------------

export type S2CanonicalFormatsDeltaReleaseSetting = ProtocolDeltaReleaseSetting;
export type S2CanonicalFormatsDeltaStatusKind = ProtocolDeltaStatusKind;

export interface S2CanonicalFormatsDeltaStatus extends ProtocolDeltaStatus {
  update_id: typeof S2_CANONICAL_FORMATS_DELTA_UPDATE_ID;
  module_id: typeof S2_CANONICAL_FORMATS_MODULE_ID;
  credential_id: typeof S2_CANONICAL_FORMATS_CREDENTIAL_ID;
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
  definition: DeltaDefinition,
  release: ProtocolDeltaReleaseSetting | null,
  status: ProtocolDeltaStatusKind,
  active: boolean,
  reason: string,
  criteriaEffectiveAt: Date | null,
  missingCriterionIds: string[] = [],
): ProtocolDeltaStatus {
  return {
    update_id: definition.update_id,
    module_id: definition.module_id,
    credential_id: definition.credential_id,
    status,
    active,
    reason,
    adcp_3_1_ga_at: release?.adcp_3_1_ga_at ?? null,
    criteria_deployed_at: release?.criteria_deployed_at ?? null,
    criteria_effective_at: toIso(criteriaEffectiveAt),
    delta_window_opens_at: toIso(criteriaEffectiveAt),
    delta_window_closes_at: criteriaEffectiveAt
      ? toIso(addUtcCalendarDaysEndOfDay(criteriaEffectiveAt, definition.delta_window_days))
      : null,
    missing_criterion_ids: missingCriterionIds,
  };
}

export function computeProtocolDeltaStatus(
  definition: DeltaDefinition,
  input: ProtocolDeltaInput,
): ProtocolDeltaStatus {
  const phrases = definition.reason_phrases;
  const gaAt = parseDate(input.release?.adcp_3_1_ga_at);
  const deployedAt = parseDate(input.release?.criteria_deployed_at);

  if (!gaAt || !deployedAt) {
    const missing = [
      !gaAt ? phrases.ga_date_label : null,
      !deployedAt ? `production deployment date for migration ${definition.criteria_migration}` : null,
    ].filter(Boolean).join(' and ');
    return baseStatus(definition, input.release, 'gated', false, `Blocked until ${missing} is configured.`, null);
  }

  const criteriaEffectiveAt = new Date(Math.max(gaAt.getTime(), deployedAt.getTime()));
  const deltaWindowClosesAt = addUtcCalendarDaysEndOfDay(criteriaEffectiveAt, definition.delta_window_days);
  const now = input.now ?? new Date();

  if (input.criteriaPresent === false) {
    return baseStatus(
      definition,
      input.release,
      'gated',
      false,
      `Blocked until the ${phrases.criteria_count_word} ${phrases.criteria_phrase} criteria are present in certification_modules.exercise_definitions.`,
      criteriaEffectiveAt,
    );
  }

  if (now < criteriaEffectiveAt) {
    return baseStatus(
      definition,
      input.release,
      'gated',
      false,
      `Blocked until the later of ${phrases.ga_milestone_label} and production deployment of the ${phrases.criteria_short_phrase} criteria.`,
      criteriaEffectiveAt,
    );
  }

  if (!input.hasCredential) {
    return baseStatus(
      definition,
      input.release,
      'not_required',
      true,
      phrases.not_credentialed,
      criteriaEffectiveAt,
    );
  }

  const awardedAt = parseDate(input.credentialAwardedAt);
  const completedAt = parseDate(input.moduleCompletedAt);
  const deltaCompletedAt = parseDate(input.deltaCompletedAt);

  if (completedAt && completedAt >= criteriaEffectiveAt) {
    return baseStatus(
      definition,
      input.release,
      'not_required',
      true,
      phrases.completion_after_effective,
      criteriaEffectiveAt,
    );
  }

  if (!completedAt) {
    if (awardedAt && awardedAt >= criteriaEffectiveAt) {
      return baseStatus(
        definition,
        input.release,
        'not_required',
        true,
        phrases.credential_after_effective,
        criteriaEffectiveAt,
      );
    }
    return baseStatus(
      definition,
      input.release,
      'full_recertification_required',
      true,
      `Prior ${phrases.module_label} completion record is missing, so the learner does not meet the auditable-record requirement for a delta.`,
      criteriaEffectiveAt,
      [...definition.criterion_ids],
    );
  }

  const verified = new Set(input.verifiedCriterionIds);
  const missingCriterionIds = definition.criterion_ids.filter(id => !verified.has(id));

  if (deltaCompletedAt) {
    return baseStatus(
      definition,
      input.release,
      'delta_completed',
      true,
      phrases.delta_completed,
      criteriaEffectiveAt,
    );
  }

  if (input.hasPriorAuditableRecord === false) {
    return baseStatus(
      definition,
      input.release,
      'full_recertification_required',
      true,
      `Prior ${phrases.module_label} checkpoint trail is missing, so the learner does not meet the auditable-record requirement for a delta.`,
      criteriaEffectiveAt,
      missingCriterionIds,
    );
  }

  if (now > deltaWindowClosesAt) {
    return baseStatus(
      definition,
      input.release,
      'full_recertification_required',
      true,
      `The ${phrases.delta_name} delta window has closed.`,
      criteriaEffectiveAt,
      missingCriterionIds,
    );
  }

  return baseStatus(
    definition,
    input.release,
    'delta_available',
    true,
    phrases.delta_available,
    criteriaEffectiveAt,
    missingCriterionIds,
  );
}

function mapLegacyInput(input: S2CanonicalFormatsDeltaInput): ProtocolDeltaInput {
  return {
    release: input.release,
    hasCredential: input.hasCreativeSpecialistCredential,
    credentialAwardedAt: input.credentialAwardedAt,
    moduleCompletedAt: input.s2CompletedAt,
    deltaCompletedAt: input.deltaCompletedAt,
    criteriaPresent: input.canonicalCriteriaPresent,
    hasPriorAuditableRecord: input.hasPriorAuditableS2Record,
    verifiedCriterionIds: input.verifiedCriterionIds,
    now: input.now,
  };
}

export function computeS2CanonicalFormatsDeltaStatus(
  input: S2CanonicalFormatsDeltaInput,
): S2CanonicalFormatsDeltaStatus {
  return computeProtocolDeltaStatus(
    S2_DELTA_DEFINITION,
    mapLegacyInput(input),
  ) as S2CanonicalFormatsDeltaStatus;
}
