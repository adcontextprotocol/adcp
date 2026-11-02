import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';
import {
  deriveV4ReadinessReport,
  loadV4CompatibilityRegistry,
  v4ReadinessEvidenceFromComplianceResult,
  type V4CompatibilityRegistry,
  type V4ReadinessEvidence,
} from '../../src/compliance/v4-readiness.js';
import { complianceResultToDbInput } from '../../src/addie/services/compliance-testing.js';

// Synthetic ids: the derivation must work from whatever the registry lists.
const registry: V4CompatibilityRegistry = {
  version: '1.0.0',
  target_version: '4.0',
  migration_guide: 'docs/reference/migration/v4-compatibility.mdx',
  checks: [
    {
      id: 'widget_removed_in_4_0',
      issue: 1,
      change: 'removal',
      detection: 'Products declare widgets.',
      fix: 'Stop declaring widgets.',
      observed_by: { validation: { storyboard: 'sb_alpha', steps: ['step_a', 'step_a_alt'] } },
    },
    {
      id: 'gadget_specialism_deprecated',
      issue: 2,
      change: 'removal',
      detection: 'Capabilities list the gadget specialism.',
      fix: 'Drop the gadget specialism.',
      observed_by: { notice: { storyboards: ['sb_gadget'] } },
    },
    {
      id: 'unseen_required_in_4_0',
      detection: 'Something a 3.x agent cannot show.',
      fix: 'Do the thing.',
      observed_by: { none: { reason: 'not expressible on 3.x' } },
    },
  ],
};

function evidence(overrides: Partial<V4ReadinessEvidence> = {}): V4ReadinessEvidence {
  return { storyboards_run: [], steps: [], notice_codes: [], ...overrides };
}

function check(report: ReturnType<typeof deriveV4ReadinessReport>, id: string) {
  const found = report.checks.find(c => c.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

describe('deriveV4ReadinessReport — validation-observed checks', () => {
  const id = 'widget_removed_in_4_0';

  it('passes only on a graded validation result with the check id', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{
        storyboard_id: 'sb_alpha',
        step_id: 'step_a',
        skipped: false,
        validations: [{ id, passed: true, not_applicable: false }],
      }],
    }));
    expect(check(report, id)).toMatchObject({ status: 'passed', reason: null });
  });

  it('fails on a failed validation result and carries the registry fix and guide anchor', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{
        storyboard_id: 'sb_alpha',
        step_id: 'step_a_alt',
        skipped: false,
        validations: [{ id, passed: false }],
      }],
    }));
    expect(check(report, id)).toEqual({
      id,
      status: 'failing',
      reason: null,
      issue: 1,
      change: 'removal',
      detection: 'Products declare widgets.',
      fix: 'Stop declaring widgets.',
      guide_url: 'https://adcontextprotocol.org/docs/reference/migration/v4-compatibility#widget_removed_in_4_0',
    });
  });

  it('fails on a failure summary that names the check id', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{ storyboard_id: 'sb_alpha', step_id: 'step_a', skipped: false, failed_validation_ids: [id] }],
    }));
    expect(check(report, id).status).toBe('failing');
  });

  it('treats a not_applicable validation as not observable, never passed', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{
        storyboard_id: 'sb_alpha',
        step_id: 'step_a',
        skipped: false,
        validations: [{ id, passed: true, not_applicable: true }],
      }],
    }));
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'not_graded' });
  });

  it('does not infer a pass from a step that ran without reporting the validation', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{ storyboard_id: 'sb_alpha', step_id: 'step_a', skipped: false }],
    }));
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'not_graded' });
  });

  it('is not observable when the grading step was skipped', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{ storyboard_id: 'sb_alpha', step_id: 'step_a', skipped: true }],
    }));
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'step_skipped' });
  });

  it('is not observable when the storyboard ran but no grading step did', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_alpha'],
      steps: [{
        storyboard_id: 'sb_alpha',
        step_id: 'some_other_step',
        skipped: false,
        validations: [{ id, passed: true }],
      }],
    }));
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'step_not_run' });
  });

  it('is not observable when the storyboard did not run', () => {
    const report = deriveV4ReadinessReport(registry, evidence({ storyboards_run: ['sb_other'] }));
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'storyboard_not_run' });
  });
});

describe('deriveV4ReadinessReport — notice-observed and unobservable checks', () => {
  const id = 'gadget_specialism_deprecated';

  it('fails when the run emitted a notice with the check id', () => {
    const report = deriveV4ReadinessReport(registry, evidence({
      storyboards_run: ['sb_gadget'],
      notice_codes: ['unrelated_code', id],
    }));
    expect(check(report, id)).toMatchObject({ status: 'failing', reason: null });
  });

  it('treats an absent notice as not observable, not passed', () => {
    const report = deriveV4ReadinessReport(registry, evidence({ storyboards_run: ['sb_gadget'] }));
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'notice_absent' });
  });

  it('reports storyboard_not_run when none of the notice storyboards ran', () => {
    const report = deriveV4ReadinessReport(registry, evidence());
    expect(check(report, id)).toMatchObject({ status: 'not_observable', reason: 'storyboard_not_run' });
  });

  it('reports observed_by.none checks as not observable', () => {
    const report = deriveV4ReadinessReport(registry, evidence({ storyboards_run: ['sb_alpha', 'sb_gadget'] }));
    expect(check(report, 'unseen_required_in_4_0')).toMatchObject({
      status: 'not_observable',
      reason: 'not_observed_by_suite',
      issue: null,
      change: null,
    });
  });

  it('reports every registry check in registry order', () => {
    const report = deriveV4ReadinessReport(registry, evidence());
    expect(report.registry_version).toBe('1.0.0');
    expect(report.target_version).toBe('4.0');
    expect(report.checks.map(c => c.id)).toEqual(registry.checks.map(c => c.id));
  });
});

describe('v4ReadinessEvidenceFromComplianceResult', () => {
  function result(partial: Partial<ComplianceResult> & Record<string, unknown>): ComplianceResult {
    return { tracks: [], ...partial } as unknown as ComplianceResult;
  }

  it('attributes flattened steps through the resolver and keeps structured validations', () => {
    const out = v4ReadinessEvidenceFromComplianceResult(result({
      tracks: [{
        track: 'core',
        scenarios: [{
          scenario: 'sb_alpha/discovery',
          steps: [
            { step: 'Get products', task: 'get_products', passed: true, validations: [{ id: 'x', passed: true }] },
            { step: 'Unknown step', task: 'get_products', passed: true },
            { step: 'Skipped step', step_id: 'step_b', task: 'get_products', passed: false, skipped: true },
          ],
        }],
      }],
    } as never), (_result, storyboardId, phaseId, step) =>
      storyboardId === 'sb_alpha' && phaseId === 'discovery' && step.step === 'Get products' ? 'step_a' : undefined);

    expect(out.storyboards_run).toEqual(['sb_alpha']);
    expect(out.steps).toEqual([
      {
        storyboard_id: 'sb_alpha',
        step_id: 'step_a',
        skipped: false,
        validations: [{ id: 'x', passed: true, not_applicable: false }],
      },
      { storyboard_id: 'sb_alpha', step_id: 'step_b', skipped: true, validations: undefined },
    ]);
  });

  it('records unrelated storyboards as run without attributing their steps', () => {
    let lookups = 0;
    const out = v4ReadinessEvidenceFromComplianceResult(result({
      tracks: [{
        track: 'core',
        scenarios: [{ scenario: 'sb_other/phase', steps: [{ step: 'Anything', task: 'x', passed: true }] }],
      }],
    } as never), () => { lookups++; return 'step_x'; }, new Set(['sb_alpha']));

    expect(out.storyboards_run).toEqual(['sb_other']);
    expect(out.steps).toEqual([]);
    expect(lookups).toBe(0);
  });

  it('reads failed validation ids from failure summaries and notice codes from the run', () => {
    const out = v4ReadinessEvidenceFromComplianceResult(result({
      failures: [
        { track: 'core', storyboard_id: 'sb_alpha', step_id: 'step_a', step_title: 'Get products', task: 'get_products', fix_command: '', validation: { id: 'widget_removed_in_4_0', check: 'field_present', description: 'd' } },
        { track: 'core', storyboard_id: 'sb_alpha', step_id: 'step_c', step_title: 'No id', task: 'get_products', fix_command: '' },
      ],
      notices: [{ code: 'gadget_specialism_deprecated', severity: 'deprecation', message: 'm' }, { severity: 'info' }],
    }), () => undefined);

    expect(out.storyboards_run).toEqual(['sb_alpha']);
    expect(out.steps).toEqual([
      { storyboard_id: 'sb_alpha', step_id: 'step_a', skipped: false, failed_validation_ids: ['widget_removed_in_4_0'] },
    ]);
    expect(out.notice_codes).toEqual(['gadget_specialism_deprecated']);
  });
});

describe('registry loading and ingest', () => {
  it('loads the working registry when the run bundle predates it', () => {
    const loaded = loadV4CompatibilityRegistry('3.0.0');
    expect(loaded).not.toBeNull();
    expect(loaded!.target_version).toBe('4.0');
    expect(loaded!.checks.length).toBeGreaterThan(0);
  });

  it('ignores a run version that is not an exact release', () => {
    expect(loadV4CompatibilityRegistry('../../etc')).not.toBeNull();
  });

  it('persists a report on the run input, with an emitted notice graded failing', () => {
    const loaded = loadV4CompatibilityRegistry(null)!;
    const noticeCheck = loaded.checks.find(c => c.observed_by.notice);
    expect(noticeCheck).toBeDefined();

    const dbInput = complianceResultToDbInput({
      agent_url: 'https://agent.example',
      overall_status: 'passing',
      tracks: [],
      tested_tracks: [],
      skipped_tracks: [],
      summary: { tracks_passed: 0, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 0, tracks_silent: 0, headline: '' },
      observations: [],
      agent_profile: { name: 'a', tools: [] },
      tested_at: new Date().toISOString(),
      total_duration_ms: 1,
      notices: [{ code: noticeCheck!.id, severity: 'deprecation', message: 'm', storyboard_ids: [] }],
    } as unknown as ComplianceResult, 'https://agent.example', 'production');

    const report = dbInput.v4_readiness_json;
    expect(report).not.toBeNull();
    expect(report!.checks.map(c => c.id)).toEqual(loaded.checks.map(c => c.id));
    expect(report!.checks.find(c => c.id === noticeCheck!.id)?.status).toBe('failing');
    // Nothing ran, so no other check may claim a verdict.
    expect(report!.checks.filter(c => c.id !== noticeCheck!.id).every(c => c.status === 'not_observable')).toBe(true);
  });
});
