import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { pickStoryboardBlockingReason as pickServerStoryboardBlockingReason } from '../../src/services/verification-hint.js';

const dashboardSource = readFileSync(
  new URL('../../public/dashboard-agents.html', import.meta.url),
  'utf8',
);

const helperStart = dashboardSource.indexOf('function buildTrackCoverageGapNote');
const helperEnd = dashboardSource.indexOf('// Track pill click', helperStart);
if (helperStart < 0 || helperEnd < 0) {
  throw new Error('buildTrackCoverageGapNote helper not found');
}
const context = vm.createContext({});
vm.runInContext(dashboardSource.slice(helperStart, helperEnd), context);
const buildTrackCoverageGapNote = context.buildTrackCoverageGapNote as (
  trackData: { has_coverage_gap_skip?: boolean; status?: string },
) => string;

const blockerHelperStart = dashboardSource.indexOf('function pickStoryboardBlockingReason');
const blockerHelperEnd = dashboardSource.indexOf('function finiteCount', blockerHelperStart);
const gradingProfileStart = dashboardSource.indexOf('function renderGradingProfileComparisons');
const verificationPanelStart = dashboardSource.indexOf('function renderVerificationPanel');
const verificationPanelEnd = dashboardSource.indexOf('function timeAgo', verificationPanelStart);
if (
  blockerHelperStart < 0 ||
  blockerHelperEnd < 0 ||
  gradingProfileStart < 0 ||
  verificationPanelStart < 0 ||
  verificationPanelEnd < 0
) {
  throw new Error('verification panel helpers not found');
}

const verificationContext = vm.createContext({
  buildNoticesSectionHtml: () => '',
  escapeHtml: (value: unknown) => String(value),
  location: { origin: 'https://agenticadvertising.org' },
  timeAgo: () => '2h ago',
});
vm.runInContext(dashboardSource.slice(blockerHelperStart, blockerHelperEnd), verificationContext);
vm.runInContext(dashboardSource.slice(gradingProfileStart, verificationPanelStart), verificationContext);
vm.runInContext(dashboardSource.slice(verificationPanelStart, verificationPanelEnd), verificationContext);

type StoryboardStatus = { status?: string | null };
const pickDashboardStoryboardBlockingReason = verificationContext.pickStoryboardBlockingReason as (
  statuses?: StoryboardStatus[] | null,
) => string | null;
const renderVerificationPanel = verificationContext.renderVerificationPanel as (
  complianceStatus: Record<string, unknown> | null,
  agentUrl: string,
  hasAuth: boolean,
) => string;
const renderGradingProfileComparisons = verificationContext.renderGradingProfileComparisons as (
  complianceStatus: Record<string, unknown> | null,
) => string;

describe('dashboard track coverage-gap guidance', () => {
  it('explains partial tracks when coverage-gap skips block storyboard eligibility', () => {
    const html = buildTrackCoverageGapNote({
      has_coverage_gap_skip: true,
      status: 'partial',
    });

    expect(html).toContain('class="track-coverage-gap-note"');
    expect(html).toContain('Badge eligibility is storyboard-level.');
    expect(html).toContain('do not count as passing');
  });

  it.each([
    { has_coverage_gap_skip: false, status: 'partial' },
    { has_coverage_gap_skip: true, status: 'pass' },
    { has_coverage_gap_skip: true, status: 'fail' },
  ])('omits the note for $status without a partial coverage gap', (trackData) => {
    expect(buildTrackCoverageGapNote(trackData)).toBe('');
  });

  it('renders numeric scenario counts without string parsing', () => {
    expect(dashboardSource).toContain('Number(trackData.passed_count)');
    expect(dashboardSource).toContain('Number(trackData.scenario_count)');
  });
});

describe('dashboard verification blocker guidance', () => {
  it.each([
    {
      label: 'failing precedence',
      statuses: [{ status: 'untested' }, { status: 'partial' }, { status: 'failing' }],
      expected: 'failing',
    },
    {
      label: 'partial precedence',
      statuses: [{ status: 'passing' }, { status: 'untested' }, { status: 'partial' }],
      expected: 'partial',
    },
    { label: 'untested only', statuses: [{ status: 'passing' }, { status: 'untested' }], expected: 'untested' },
    { label: 'missing', statuses: undefined, expected: undefined },
    { label: 'empty', statuses: [], expected: undefined },
    { label: 'non-blocking', statuses: [{ status: 'passing' }], expected: undefined },
  ])('matches the server selector for $label results', ({ statuses, expected }) => {
    const serverReason = pickServerStoryboardBlockingReason(statuses);
    const dashboardReason = pickDashboardStoryboardBlockingReason(statuses) ?? undefined;

    expect(serverReason).toBe(expected);
    expect(dashboardReason).toBe(serverReason);
  });

  it('renders partial guidance for the production reproduction without failing copy', () => {
    const html = renderVerificationPanel({
      status: 'degraded',
      verified_badges: [],
      declared_specialisms: ['media-buy'],
      storyboard_statuses: [
        ...Array.from({ length: 13 }, () => ({ status: 'passing' })),
        ...Array.from({ length: 4 }, () => ({ status: 'partial' })),
        ...Array.from({ length: 18 }, () => ({ status: 'untested' })),
      ],
    }, 'https://sell.nofluffadvisory.com', true);

    expect(html).toContain('Some storyboards have partial results');
    expect(html).toContain('review the incomplete checks');
    expect(html).toContain('then re-test.');
    expect(html).toContain('Badge issuance also requires an API-access membership tier');
    expect(html).not.toContain('then re-test to earn');
    expect(html).not.toContain('Storyboards are failing');
    expect(html).not.toContain('failing storyboards');
    expect(html).not.toContain('declared specialisms have partial storyboard results');
  });

  it.each([
    { label: 'failing', storyboard_statuses: [{ status: 'failing' }] },
    { label: 'partial', storyboard_statuses: [{ status: 'partial' }] },
    { label: 'untested', storyboard_statuses: [{ status: 'untested' }] },
  ])('requires an upgrade for an ineligible tier with $label results', ({ storyboard_statuses }) => {
    for (const declared_specialisms of [[], ['media-buy']]) {
      const html = renderVerificationPanel(
        {
          status: 'degraded',
          verified_badges: [],
          declared_specialisms,
          storyboard_statuses,
          membership_tier_label: 'Explorer',
          is_api_access_tier: false,
        },
        'https://agent.example.com',
        true,
      );

      expect(html).toContain('Your tier (<strong>Explorer</strong>) is not eligible');
      expect(html).toContain('upgrade to earn badges');
      expect(html).not.toContain('to earn AAO Verified (Spec)');
      expect(html).not.toContain('before it can earn AAO Verified (Spec)');
      if (declared_specialisms.length === 0) {
        expect(html).toContain('must also declare specialisms');
      }
    }
  });

  it.each([
    { label: 'failing', storyboard_statuses: [{ status: 'failing' }] },
    { label: 'partial', storyboard_statuses: [{ status: 'partial' }] },
    { label: 'untested', storyboard_statuses: [{ status: 'untested' }] },
  ])('requires an API-access tier for unknown-tier viewers with $label results', ({ storyboard_statuses }) => {
    const unknownTierShapes = [
      {},
      { membership_tier_label: 'Galactic', is_api_access_tier: false },
    ];
    for (const tierFields of unknownTierShapes) {
      for (const declared_specialisms of [[], ['media-buy']]) {
        const html = renderVerificationPanel(
          {
            status: 'degraded',
            verified_badges: [],
            declared_specialisms,
            storyboard_statuses,
            ...tierFields,
          },
          'https://agent.example.com',
          true,
        );

        expect(html).toContain('Badge issuance also requires an API-access membership tier');
        expect(html).not.toContain('to earn AAO Verified (Spec)');
        expect(html).not.toContain('before it can earn AAO Verified (Spec)');
        expect(html).not.toContain('upgrade to earn badges');
        if (declared_specialisms.length === 0) {
          expect(html).toContain('must also declare specialisms');
        }
      }
    }
  });

  it('keeps action-to-earn guidance for an eligible tier', () => {
    const html = renderVerificationPanel({
      status: 'degraded',
      verified_badges: [],
      declared_specialisms: ['media-buy'],
      storyboard_statuses: [{ status: 'partial' }],
      membership_tier_label: 'Builder',
      is_api_access_tier: true,
    }, 'https://agent.example.com', true);

    expect(html).toContain('then re-test to earn AAO Verified (Spec)');
    expect(html).not.toContain('upgrade to earn badges');
  });

  it.each([
    {
      label: 'failing',
      storyboard_statuses: [{ status: 'failing' }],
      expected: 'fix the failing storyboards',
      shouldRetest: true,
    },
    {
      label: 'partial',
      storyboard_statuses: [{ status: 'partial' }],
      expected: 'review the incomplete checks',
      shouldRetest: true,
    },
    {
      label: 'untested',
      storyboard_statuses: [{ status: 'untested' }],
      expected: 'run the applicable untested storyboards',
      shouldRetest: false,
    },
    {
      label: 'missing results fallback',
      storyboard_statuses: undefined,
      expected: 'fix the failing storyboards',
      shouldRetest: true,
    },
  ])('explains both requirements with zero declarations for $label results', (
    { storyboard_statuses, expected, shouldRetest },
  ) => {
    const html = renderVerificationPanel(
      {
        status: 'degraded',
        verified_badges: [],
        declared_specialisms: [],
        storyboard_statuses,
      },
      'https://agent.example.com',
      true,
    );

    expect(html).toContain(expected);
    if (shouldRetest) expect(html).toContain('then re-test');
    expect(html).toContain('must also declare specialisms');
    expect(html).toContain('<code>get_adcp_capabilities</code>');
    expect(html).toContain('Badge issuance also requires an API-access membership tier');
    expect(html).not.toContain('before it can earn AAO Verified (Spec)');
  });
});

describe('dashboard grading profile comparison', () => {
  const currentComparison = {
    scope: 'agent',
    availability: 'current',
    selected_profile: 'legacy',
    compliance_bundle_version: '3.1.20',
    assessed_at: '2026-09-15T10:00:00.000Z',
    source_tested_at: '2026-09-15T09:59:00.000Z',
    source_run_id: '11111111-1111-4111-8111-111111111111',
    evaluator_policy_version: 'verification-profiles-v3',
    requested_compliance_target: '3.1',
    profiles: {
      legacy: { available: true, status: 'passing', observed_status: 'passing', explanation: 'Legacy passed.' },
      spec: { available: true, status: 'partial', observed_status: 'partial', explanation: 'One bundle is incomplete.' },
      sandbox: { available: true, status: 'passing', observed_status: 'passing', explanation: 'Observable behavior passed.' },
    },
    evidence: {
      selected_storyboard_count: 12,
      observed_failure_count: 0,
      flat_failure_count: 0,
      controller_gap_phase_count: 2,
      sandbox_unresolved_bundle_count: 0,
    },
  };

  it('renders agent-wide scope, all profiles, and source provenance', () => {
    const html = renderGradingProfileComparisons({ grading_profile_comparisons: [currentComparison] });
    expect(html).toContain('Agent-wide grading preview · 3.1.20');
    expect(html).toContain('Legacy grading · Current');
    expect(html).toContain('One bundle is incomplete.');
    expect(html).toContain('11111111-1111-4111-8111-111111111111');
    expect(html).toContain('verification-profiles-v3');
    expect(html).toContain('0 run-level failure records');
    expect(html).toContain('not an exact badge-role grade');
  });

  it('never renders a stale observed pass as Passed', () => {
    const stale = structuredClone(currentComparison);
    stale.availability = 'stale';
    stale.profiles.legacy = {
      available: false,
      status: null,
      observed_status: 'passing',
      explanation: 'The latest comparison is stale.',
    };
    const html = renderGradingProfileComparisons({ grading_profile_comparisons: [stale] });
    expect(html).toContain('Unavailable');
    expect(html).toContain('Historical observation: passing');
    expect(html).not.toContain('>Passed<');
  });

  it('renders missing evidence as explicitly pending', () => {
    const html = renderGradingProfileComparisons({
      grading_profile_comparisons: [{
        availability: 'pending',
        profiles: null,
        unavailable_reason: 'No current-policy comparison is available yet.',
      }],
    });
    expect(html).toContain('Agent-wide grading preview');
    expect(html).toContain('No current-policy comparison is available yet.');
  });

  it('uses the server-provided public effect and grace deadline for exact-role selection', () => {
    const exact = structuredClone(currentComparison);
    exact.scope = 'badge';
    exact.role = 'media-buy';
    exact.adcp_version = '3.1';
    exact.selection_enabled = true;
    exact.selection_revision = 4;
    exact.profiles.spec = {
      available: true,
      status: 'failing',
      observed_status: 'failing',
      explanation: 'Strict Spec fails.',
      selectable: true,
      assessment_id: '22222222-2222-4222-8222-222222222222',
      public_effect: 'degrade',
      grace_deadline: '2026-09-17T12:00:00.000Z',
    };

    const html = renderGradingProfileComparisons({
      agent_url: 'https://agent.example.com',
      grading_profile_comparisons: [exact],
    });

    expect(html).toContain('media-buy · AdCP 3.1');
    expect(html).toContain('Use Strict Spec grading');
    expect(html).toContain('data-public-effect="degrade"');
    expect(html).toContain('The public badge will enter its degraded grace period.');
    expect(html).toContain('Grace deadline:');
    expect(html).not.toContain('onclick="selectGradingProfileFromComparison(this)">Select</button>');
  });

  it('labels a change from Strict Spec back to Legacy as a rollback', () => {
    const exact = structuredClone(currentComparison);
    exact.scope = 'badge';
    exact.role = 'media-buy';
    exact.adcp_version = '3.1';
    exact.selection_enabled = true;
    exact.selection_revision = 5;
    exact.selected_profile = 'spec';
    exact.profiles.legacy = {
      available: true,
      status: 'passing',
      observed_status: 'passing',
      explanation: 'Legacy passes.',
      selectable: true,
      assessment_id: '33333333-3333-4333-8333-333333333333',
      public_effect: 'restore',
      grace_deadline: null,
    };

    const html = renderGradingProfileComparisons({
      agent_url: 'https://agent.example.com',
      grading_profile_comparisons: [exact],
    });

    expect(html).toContain('Revert to Legacy grading');
    expect(html).toContain('The public badge will return to active.');
  });

  it('explains a server-provided regrade without claiming a lifecycle change', () => {
    const exact = structuredClone(currentComparison);
    exact.scope = 'badge';
    exact.role = 'media-buy';
    exact.adcp_version = '3.1';
    exact.selection_enabled = true;
    exact.selection_revision = 2;
    exact.profiles.spec = {
      available: true,
      status: 'passing',
      observed_status: 'passing',
      explanation: 'Strict Spec passes.',
      selectable: true,
      assessment_id: '44444444-4444-4444-8444-444444444444',
      public_effect: 'regrade',
      grace_deadline: null,
    };

    const html = renderGradingProfileComparisons({
      agent_url: 'https://agent.example.com',
      grading_profile_comparisons: [exact],
    });

    expect(html).toContain('data-public-effect="regrade"');
    expect(html).toContain('keep its lifecycle status and show the newly selected grading profile');
  });
});

describe('dashboard badge grading profile labels', () => {
  it.each([
    { grading_profile: 'legacy', expected: 'Legacy grading' },
    { grading_profile: 'spec', expected: 'Strict Spec grading' },
  ])('keeps evidence mode separate from $expected', ({ grading_profile, expected }) => {
    const html = renderVerificationPanel({
      status: 'verified',
      verified_badges: [{
        role: 'media-buy',
        adcp_version: '3.1',
        verification_modes: ['spec'],
        grading_profile,
        verified_specialisms: ['sales-agent'],
        badge_url: '/api/registry/agents/example/badge/media-buy.svg',
      }],
    }, 'https://agent.example.com', true);

    expect(html).toContain(`Media Buy Agent 3.1 (Spec) · ${expected}`);
    expect(html).toContain(`alt="AAO Verified Media Buy Agent 3.1 (Spec) · ${expected}"`);
  });
});
