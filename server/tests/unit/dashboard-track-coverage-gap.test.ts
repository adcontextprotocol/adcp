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
const verificationPanelStart = dashboardSource.indexOf('function renderVerificationPanel');
const verificationPanelEnd = dashboardSource.indexOf('function timeAgo', verificationPanelStart);
if (
  blockerHelperStart < 0 ||
  blockerHelperEnd < 0 ||
  verificationPanelStart < 0 ||
  verificationPanelEnd < 0
) {
  throw new Error('verification panel helpers not found');
}

const verificationContext = vm.createContext({
  buildNoticesSectionHtml: () => '',
  escapeHtml: (value: unknown) => String(value),
});
vm.runInContext(dashboardSource.slice(blockerHelperStart, blockerHelperEnd), verificationContext);
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
