import { describe, expect, it } from 'vitest';
import {
  computeS2CanonicalFormatsDeltaStatus,
  S2_CANONICAL_FORMATS_CRITERION_IDS,
} from '../server/src/certification/s2-canonical-formats-delta.js';

const release = {
  adcp_3_1_ga_at: '2026-06-01T12:00:00.000Z',
  criteria_deployed_at: '2026-05-28T13:00:00.000Z',
};

describe('computeS2CanonicalFormatsDeltaStatus', () => {
  it('stays gated until both release dates are configured', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release: { adcp_3_1_ga_at: null, criteria_deployed_at: '2026-05-28T13:00:00.000Z' },
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.active).toBe(false);
    expect(status.status).toBe('gated');
    expect(status.criteria_effective_at).toBeNull();
  });

  it('stays gated until the later configured release date has passed', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [],
      now: new Date('2026-06-01T11:59:59.000Z'),
    });

    expect(status.active).toBe(false);
    expect(status.status).toBe('gated');
    expect(status.criteria_effective_at).toBe('2026-06-01T12:00:00.000Z');
  });

  it('stays gated when the canonical-format criteria are not present in the curriculum', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      canonicalCriteriaPresent: false,
      verifiedCriterionIds: [],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.active).toBe(false);
    expect(status.status).toBe('gated');
  });

  it('targets pre-effective S2 holders for a delta during the 90-day window', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.active).toBe(true);
    expect(status.status).toBe('delta_available');
    expect(status.criteria_effective_at).toBe('2026-06-01T12:00:00.000Z');
    expect(status.delta_window_closes_at).toBe('2026-08-30T23:59:59.999Z');
    expect(status.missing_criterion_ids).toEqual([...S2_CANONICAL_FORMATS_CRITERION_IDS]);
  });

  it('requires full recertification when prior S2 audit trail is missing', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      hasPriorAuditableS2Record: false,
      verifiedCriterionIds: [],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.status).toBe('full_recertification_required');
    expect(status.reason).toContain('auditable-record requirement');
  });

  it('keeps the delta available until a passing delta outcome is recorded', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [...S2_CANONICAL_FORMATS_CRITERION_IDS],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.status).toBe('delta_available');
    expect(status.missing_criterion_ids).toEqual([]);
  });

  it('marks the delta complete when a passing delta outcome is recorded', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      deltaCompletedAt: '2026-06-02T00:00:00.000Z',
      verifiedCriterionIds: [...S2_CANONICAL_FORMATS_CRITERION_IDS],
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(status.status).toBe('delta_completed');
    expect(status.missing_criterion_ids).toEqual([]);
  });

  it('requires full recertification when the delta window has closed', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [],
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(status.status).toBe('full_recertification_required');
  });

  it('requires full recertification after the deadline even when all criteria have evidence but no passing delta outcome', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [...S2_CANONICAL_FORMATS_CRITERION_IDS],
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(status.status).toBe('full_recertification_required');
    expect(status.missing_criterion_ids).toEqual([]);
  });

  it('reports only criteria without cumulative evidence as missing', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: '2026-05-01T00:00:00.000Z',
      verifiedCriterionIds: [
        's2_ex1_sc_format_kind_selection',
        's2_ex1_sc_format_options_cardinality',
      ],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.status).toBe('delta_available');
    expect(status.missing_criterion_ids).toEqual([
      's2_ex1_sc_option_vs_capability_id',
      's2_ex1_sc_source_taxonomy',
      's2_ex1_sc_validation_order',
    ]);
  });

  it('does not target learners without the S2 Creative credential', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: false,
      credentialAwardedAt: null,
      s2CompletedAt: null,
      verifiedCriterionIds: [],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.status).toBe('not_required');
  });

  it('requires full recertification when the prior S2 completion record is missing', () => {
    const status = computeS2CanonicalFormatsDeltaStatus({
      release,
      hasCreativeSpecialistCredential: true,
      credentialAwardedAt: '2026-05-01T00:00:00.000Z',
      s2CompletedAt: null,
      verifiedCriterionIds: [],
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(status.status).toBe('full_recertification_required');
    expect(status.reason).toContain('auditable-record requirement');
  });
});
