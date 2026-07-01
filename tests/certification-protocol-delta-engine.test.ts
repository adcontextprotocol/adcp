import { describe, expect, it } from 'vitest';
import {
  computeProtocolDeltaStatus,
  type ProtocolDeltaInput,
} from '../server/src/certification/s2-canonical-formats-delta.js';
import type { DeltaDefinition } from '../server/src/config/recertification-deltas.js';

// A second, synthetic definition for a hypothetical module — NOT S2. Different
// window length (30 days vs S2's 90) and a different criterion count (3 vs 5),
// with its own reason phrasing. This proves the engine is definition-driven:
// the same code path that serves S2 must produce this module's windows, counts,
// and copy without any S2 hard-coding leaking through.
const SYNTHETIC_DELTA: DeltaDefinition = {
  update_id: 'x9_widget_protocol_4_0',
  module_id: 'X9',
  credential_id: 'specialist_widget',
  criterion_ids: ['x9_c1', 'x9_c2', 'x9_c3'],
  release_setting_key: 'certification_x9_widget_delta_release',
  delta_window_days: 30,
  label: 'X9 Widget protocol refresh',
  delta_action_label: 'X9 widget refresh',
  specialist_label: 'X9 Widget',
  criteria_migration: '900_x9_widget_criteria.sql',
  reason_phrases: {
    criteria_count_word: 'three',
    criteria_phrase: 'AdCP 4.0 X9 widget',
    criteria_short_phrase: 'X9 widget',
    ga_milestone_label: 'AdCP 4.0.0 GA',
    ga_date_label: 'AdCP 4.0.0 GA date',
    module_label: 'X9',
    delta_name: 'X9 widget',
    completion_after_effective: 'X9 completion is already on or after the AdCP 4.0 widget criteria effective point.',
    credential_after_effective: 'X9 credential was awarded after the AdCP 4.0 widget criteria effective point.',
    delta_completed: 'Learner has auditable evidence for all AdCP 4.0 X9 widget criteria.',
    not_credentialed: 'Learner does not hold the X9 Widget specialist credential.',
    delta_available: 'Pre-4.0 X9 holder is eligible for the widget refresh delta assessment.',
  },
};

const release = {
  adcp_3_1_ga_at: '2027-01-10T00:00:00.000Z',
  criteria_deployed_at: '2027-01-05T00:00:00.000Z',
};

function input(overrides: Partial<ProtocolDeltaInput> = {}): ProtocolDeltaInput {
  return {
    release,
    hasCredential: true,
    credentialAwardedAt: '2026-12-01T00:00:00.000Z',
    moduleCompletedAt: '2026-12-01T00:00:00.000Z',
    verifiedCriterionIds: [],
    now: new Date('2027-01-12T00:00:00.000Z'),
    ...overrides,
  };
}

describe('computeProtocolDeltaStatus is module-agnostic', () => {
  it('uses the definition window (30 days) for the closes-at boundary', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input());

    // Effective point = later of GA (2027-01-10) and deploy (2027-01-05) = 2027-01-10.
    // Window closes 30 calendar days later at end-of-day UTC.
    expect(status.status).toBe('delta_available');
    expect(status.criteria_effective_at).toBe('2027-01-10T00:00:00.000Z');
    expect(status.delta_window_closes_at).toBe('2027-02-09T23:59:59.999Z');
  });

  it('carries the definition identity into the status payload', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input());
    expect(status.update_id).toBe('x9_widget_protocol_4_0');
    expect(status.module_id).toBe('X9');
    expect(status.credential_id).toBe('specialist_widget');
  });

  it('reports all three (not five) criteria as missing when none are verified', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input());
    expect(status.missing_criterion_ids).toEqual(['x9_c1', 'x9_c2', 'x9_c3']);
  });

  it('templates the gated-config reason from the definition migration + GA label', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input({
      release: { adcp_3_1_ga_at: null, criteria_deployed_at: null },
    }));
    expect(status.status).toBe('gated');
    expect(status.reason).toBe(
      'Blocked until AdCP 4.0.0 GA date and production deployment date for migration 900_x9_widget_criteria.sql is configured.',
    );
  });

  it('templates the criteria-present gate from the definition count word + phrase', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input({ criteriaPresent: false }));
    expect(status.status).toBe('gated');
    expect(status.reason).toBe(
      'Blocked until the three AdCP 4.0 X9 widget criteria are present in certification_modules.exercise_definitions.',
    );
  });

  it('keeps the auditable-record reason wording while substituting the module label', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input({ moduleCompletedAt: null }));
    expect(status.status).toBe('full_recertification_required');
    expect(status.reason).toBe(
      'Prior X9 completion record is missing, so the learner does not meet the auditable-record requirement for a delta.',
    );
    // Same invariant the frozen S2 guard pins, proven for a different module.
    expect(status.reason).toContain('auditable-record requirement');
  });

  it('names the definition delta when the window has closed', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input({
      now: new Date('2027-03-01T00:00:00.000Z'),
    }));
    expect(status.status).toBe('full_recertification_required');
    expect(status.reason).toBe('The X9 widget delta window has closed.');
  });

  it('surfaces the not-credentialed reason from the definition', () => {
    const status = computeProtocolDeltaStatus(SYNTHETIC_DELTA, input({
      hasCredential: false,
      credentialAwardedAt: null,
      moduleCompletedAt: null,
    }));
    expect(status.status).toBe('not_required');
    expect(status.reason).toBe('Learner does not hold the X9 Widget specialist credential.');
  });
});
