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

describe('Strict Spec universal bundles for surfaces the agent does not declare', () => {
  // Every universal storyboard the 3.2.8 bundle reports as missing tools for a
  // signals-only agent (#8527) under the hosted SDK's applicability order.
  const signalsOnlyMissing = [
    'agent_notification_configs',
    'billing_gate_dispatch',
    'canonical_format_validate_input',
    'pagination_integrity_collection_lists',
    'pagination_integrity_content_standards',
    'ctv_experience_validate_input',
    'error_compliance',
    'get_media_buys_pagination_integrity',
    'notification_config_event_scope',
    'notification_config_lifecycle',
    'notification_config_rejections',
    'pagination_integrity_creative_formats',
    'pagination_integrity_list_accounts',
    'pagination_integrity',
    'premium_display_canonical_validation',
    'principal',
    'pagination_integrity_property_lists',
    'schema_validation',
    'stale_response_advisory',
  ];

  function universalRun(input: {
    missing: string[];
    protocols?: string[];
    specialism: string;
    protocolBundle: string;
    specialismStoryboard: string;
    tools: string[];
    rawCapabilities?: unknown;
  }): ComplianceResult {
    return result({
      adcp_version: '3.2.8',
      agent_profile: {
        name: 'Example agent',
        tools: input.tools,
        specialisms: [input.specialism],
        adcp_supported_versions: ['3.2'],
        ...(input.protocols && { supported_protocols: input.protocols }),
        ...(input.rawCapabilities !== undefined && { raw_capabilities: input.rawCapabilities }),
      },
      storyboards_executed: ['capability_discovery'],
      storyboards_missing_tools: input.missing,
      bundle_results: [
        { kind: 'universal', id: 'capability-discovery', storyboard_ids: ['capability_discovery'], status: 'passing' },
        ...input.missing.map(id => ({
          kind: 'universal' as const,
          id: id.replace(/_/g, '-'),
          storyboard_ids: [id],
          status: 'partial' as const,
        })),
        { kind: 'protocol', id: input.protocolBundle, storyboard_ids: [`${input.protocolBundle}_baseline`], status: 'passing' },
        { kind: 'specialism', id: input.specialism, storyboard_ids: [input.specialismStoryboard], status: 'passing' },
      ],
    });
  }

  function signalsRun(overrides: Partial<Parameters<typeof universalRun>[0]> = {}): ComplianceResult {
    return universalRun({
      missing: signalsOnlyMissing,
      protocols: ['signals'],
      specialism: 'signal-owned',
      protocolBundle: 'signals',
      specialismStoryboard: 'signal_owned',
      tools: ['get_adcp_capabilities', 'get_signals', 'activate_signal', 'comply_test_controller'],
      rawCapabilities: { adcp: { major_versions: [3] }, supported_protocols: ['signals'] },
      ...overrides,
    });
  }

  function spec(run: ComplianceResult, specialismStoryboard: string) {
    return deriveVerificationProfileRoleAssessments({
      result: run,
      lifecycleStage: 'production',
      requestedComplianceTarget: '3.2',
      storyboardStatuses: [{
        storyboard_id: specialismStoryboard,
        status: 'passing',
        steps_passed: 3,
        steps_total: 3,
      }],
    }).find(assessment => assessment.grading_profile === 'spec')!;
  }

  it('lets a signals-only agent reach Strict when only undeclared surfaces lack tools', () => {
    const assessment = spec(signalsRun(), 'signal_owned');
    expect(assessment.role).toBe('signals');
    expect(assessment.status).toBe('passing');
    expect(assessment.evidence.incomplete_bundle_count).toBe(0);
    expect(assessment.evidence.not_applicable_universal_bundle_ids).toHaveLength(signalsOnlyMissing.length);
  });

  it('keeps a missing signals tool incomplete for the agent that declares signals', () => {
    const assessment = spec(signalsRun({
      missing: [...signalsOnlyMissing, 'get_signals_pagination_integrity'],
      tools: ['get_adcp_capabilities', 'comply_test_controller'],
    }), 'signal_owned');
    expect(assessment.status).toBe('partial');
    expect(assessment.evidence.incomplete_bundle_count).toBe(1);
  });

  it.each([
    // Five 3.2.8 universal storyboards need sync_accounts or list_accounts.
    ['an account block', { account: { supported_billing: ['operator'] } }, 'billing_gate_dispatch', 5],
    ['principal support', { adcp: { principal: { supported: true } } }, 'principal', 1],
    [
      'capability-change notifications',
      { adcp: { capability_changes: { notifications: { supported: true } } } },
      'agent_notification_configs',
      1,
    ],
  ])('keeps a shared surface incomplete when the agent declares %s', (_label, capabilities, storyboard, incomplete) => {
    const assessment = spec(signalsRun({ rawCapabilities: { supported_protocols: ['signals'], ...capabilities } }), 'signal_owned');
    expect(assessment.status).toBe('partial');
    expect(assessment.evidence.incomplete_bundle_count).toBe(incomplete);
    expect(assessment.evidence.not_applicable_universal_bundle_ids).not.toContain(storyboard.replace(/_/g, '-'));
  });

  it('fails closed on shared surfaces when the raw capabilities are unavailable', () => {
    const assessment = spec(signalsRun({ rawCapabilities: undefined }), 'signal_owned');
    expect(assessment.status).toBe('partial');
    // Media-buy, creative and governance tools stay not applicable. The five
    // account storyboards, principal and agent notification configs do not.
    expect(assessment.evidence.incomplete_bundle_count).toBe(7);
  });

  it('fails closed when the agent profile carries no protocol declarations', () => {
    const assessment = spec(signalsRun({ protocols: undefined }), 'signal_owned');
    expect(assessment.status).toBe('partial');
    expect(assessment.evidence.incomplete_bundle_count).toBe(signalsOnlyMissing.length);
  });

  it('fails closed when the missing-tools record contradicts an advertised tool', () => {
    const assessment = spec(signalsRun({
      tools: ['get_adcp_capabilities', 'get_signals', 'activate_signal', 'comply_test_controller', 'sync_principal'],
    }), 'signal_owned');
    expect(assessment.status).toBe('partial');
    expect(assessment.evidence.not_applicable_universal_bundle_ids).not.toContain('principal');
  });

  it('fails closed on a storyboard the graded release does not define', () => {
    const assessment = spec(signalsRun({ missing: ['not_a_released_storyboard'] }), 'signal_owned');
    expect(assessment.status).toBe('partial');
  });

  it('keeps media-buy tools incomplete for a media-buy seller', () => {
    const mediaBuyMissing = ['error_compliance', 'schema_validation', 'stale_response_advisory', 'pagination_integrity'];
    for (const missing of mediaBuyMissing) {
      const assessment = spec(universalRun({
        missing: [missing],
        protocols: ['media_buy'],
        specialism: 'sales-non-guaranteed',
        protocolBundle: 'media-buy',
        specialismStoryboard: 'sales_non_guaranteed',
        tools: ['get_adcp_capabilities', 'create_media_buy', 'sync_accounts'],
        rawCapabilities: { supported_protocols: ['media_buy'], account: { supported_billing: ['operator'] } },
      }), 'sales_non_guaranteed');
      expect(assessment.status, missing).toBe('partial');
      expect(assessment.evidence.not_applicable_universal_bundle_ids, missing).toEqual([]);
    }
  });

  it('treats the badge role as declared even when supported_protocols omits it', () => {
    const assessment = spec(universalRun({
      missing: ['error_compliance'],
      protocols: [],
      specialism: 'sales-non-guaranteed',
      protocolBundle: 'media-buy',
      specialismStoryboard: 'sales_non_guaranteed',
      tools: ['get_adcp_capabilities', 'create_media_buy'],
      rawCapabilities: { supported_protocols: [] },
    }), 'sales_non_guaranteed');
    expect(assessment.status).toBe('partial');
  });
});
