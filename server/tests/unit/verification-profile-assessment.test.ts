import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';
import { deriveVerificationProfileRoleAssessments } from '../../src/services/verification-profile-assessment.js';

function result(overrides: Partial<ComplianceResult> = {}): ComplianceResult {
  return {
    agent_url: 'https://seller.example.test/mcp',
    adcp_version: '3.1.4',
    completeness: 'complete',
    agent_profile: {
      specialisms: ['sales-non-guaranteed'],
      adcp_supported_versions: ['3.1'],
    },
    overall_status: 'passing',
    tracks: [],
    tested_tracks: [],
    skipped_tracks: [],
    summary: {
      tracks_passed: 0,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      tracks_silent: 0,
      headline: 'Passing',
    },
    observations: [],
    bundle_results: [
      { kind: 'universal', id: 'universal', storyboard_ids: ['universal_baseline'], status: 'passing' },
      { kind: 'protocol', id: 'media-buy', storyboard_ids: ['media_buy_seller'], status: 'passing' },
      { kind: 'specialism', id: 'sales-non-guaranteed', storyboard_ids: ['sales_non_guaranteed'], status: 'passing' },
    ],
    tested_at: new Date().toISOString(),
    total_duration_ms: 10,
    notices: [],
    ...overrides,
  } as ComplianceResult;
}

const statuses = [{
  storyboard_id: 'sales_non_guaranteed',
  status: 'passing' as const,
  steps_passed: 2,
  steps_total: 2,
}];

describe('verification profile role assessment', () => {
  it('keeps Legacy parity while requiring complete exact-role bundles for Strict Spec', () => {
    const assessments = deriveVerificationProfileRoleAssessments({
      result: result(),
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.1',
      storyboardStatuses: statuses,
    });
    expect(assessments.map(a => [a.grading_profile, a.status, a.selectable])).toEqual([
      ['legacy', 'passing', true],
      ['spec', 'passing', true],
      ['sandbox', null, false],
    ]);
    expect(assessments.every(a => a.role === 'media-buy' && a.adcp_version === '3.1')).toBe(true);
  });

  it('fails Strict Spec closed when a required protocol bundle is absent', () => {
    const withoutProtocol = result({
      bundle_results: result().bundle_results!.filter(bundle => bundle.kind !== 'protocol'),
    });
    const assessments = deriveVerificationProfileRoleAssessments({
      result: withoutProtocol,
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.1',
      storyboardStatuses: statuses,
    });
    expect(assessments.find(a => a.grading_profile === 'legacy')?.status).toBe('passing');
    expect(assessments.find(a => a.grading_profile === 'spec')?.status).toBe('partial');
  });

  it('never lets Strict Spec pass when the exact Legacy role verdict is non-passing', () => {
    const assessments = deriveVerificationProfileRoleAssessments({
      result: result(),
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.1',
      storyboardStatuses: [{
        storyboard_id: 'sales_non_guaranteed',
        status: 'failing',
        steps_passed: 1,
        steps_total: 2,
      }],
    });

    expect(assessments.find(a => a.grading_profile === 'legacy')?.status).toBe('failing');
    expect(assessments.find(a => a.grading_profile === 'spec')?.status).toBe('failing');
  });

  it('applies an unattributed run failure to every role instead of passing it', () => {
    const withFailure = result({
      failures: [{
        track: 'core',
        storyboard_id: 'unknown_storyboard',
        step_id: 'detached',
        step_title: 'Detached assertion',
        task: 'get_adcp_capabilities',
        fix_command: 'npx adcp test',
      }],
    });
    const assessments = deriveVerificationProfileRoleAssessments({
      result: withFailure,
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.1',
      storyboardStatuses: statuses,
    });
    expect(assessments.find(a => a.grading_profile === 'spec')?.status).toBe('failing');
  });

  it('does not produce enforceable rows without an exact badge release', () => {
    expect(deriveVerificationProfileRoleAssessments({
      result: result({ adcp_version: undefined }),
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.1',
      storyboardStatuses: statuses,
    })).toEqual([]);
  });

  it.each([
    ['a prerelease diagnostic target', '3.1-rc', '3.1.4', ['3.1']],
    ['an exact bundle diagnostic target', '3.1.4', '3.1.4', ['3.1']],
    ['an unsupported stable line', '4.0', '4.0.1', ['4.0']],
    ['a stable line the agent did not advertise', '3.1', '3.1.4', ['3.0']],
    ['a malformed patch suffix', '3.1', '3.1.4', ['3.1.foo']],
    ['an empty patch suffix', '3.1', '3.1.4', ['3.1.']],
    ['a malformed observed patch suffix', '3.1', '3.1.foo', ['3.1']],
    ['a run whose observed release differs from its target', '3.1', '3.0.12', ['3.1']],
  ])('does not produce selectable evidence from %s', (
    _description,
    requestedComplianceTarget,
    adcpVersion,
    advertisedVersions,
  ) => {
    const diagnostic = result({
      adcp_version: adcpVersion,
      agent_profile: {
        specialisms: ['sales-non-guaranteed'],
        adcp_supported_versions: advertisedVersions,
      },
    });

    expect(deriveVerificationProfileRoleAssessments({
      result: diagnostic,
      lifecycleStage: 'production',
      requestedComplianceTarget,
      storyboardStatuses: statuses,
    })).toEqual([]);
  });

  it('accepts a stable supported line advertised through a concrete patch version', () => {
    const assessments = deriveVerificationProfileRoleAssessments({
      result: result({
        agent_profile: {
          specialisms: ['sales-non-guaranteed'],
          adcp_supported_versions: ['3.1.9'],
        },
      }),
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.1',
      storyboardStatuses: statuses,
    });

    expect(assessments).toHaveLength(3);
    expect(assessments.every(assessment => assessment.adcp_version === '3.1')).toBe(true);
  });
});
