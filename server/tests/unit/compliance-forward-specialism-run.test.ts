/**
 * Hosted grading when an agent declares a specialism its graded compliance
 * release does not define (adcp#8269).
 *
 * The SDK is mocked so the test controls what capability resolution does; the
 * hosted compliance-version service and the checked-in `dist/compliance`
 * artifacts are real, because which specialisms a release defines is exactly
 * what decides whether the run is retried or stays failed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sdkComply: vi.fn(),
  discovery: vi.fn(),
  safeFetch: vi.fn(),
  CapabilityResolutionError: class CapabilityResolutionError extends Error {
    code: string;
    specialism?: string;
    parentProtocol?: string;

    constructor(params: { code: string; message: string; specialism?: string; parentProtocol?: string }) {
      super(params.message);
      this.code = params.code;
      this.specialism = params.specialism;
      this.parentProtocol = params.parentProtocol;
    }
  },
}));

vi.mock('@adcp/sdk/testing', () => ({
  SAMPLE_BRIEFS: [],
  getBriefsByVertical: vi.fn(),
  setAgentTesterLogger: vi.fn(),
  comply: mocks.sdkComply,
  loadComplianceIndex: vi.fn(),
  getComplianceCacheDir: vi.fn(() => ''),
  testCapabilityDiscovery: mocks.discovery,
  isComplianceVersionSupported: () => true,
  CapabilityResolutionError: mocks.CapabilityResolutionError,
}));

vi.mock('../../src/compliance/storyboard-cache.js', () => ({
  getCachedComplianceStoryboardById: vi.fn(),
}));

vi.mock('../../src/utils/sdk-safe-fetch.js', () => ({
  withSdkSafeTransport: (options: Record<string, unknown>) => ({
    ...options,
    transport: {
      ...(options.transport as Record<string, unknown> | undefined),
      fetchFn: mocks.safeFetch,
    },
  }),
}));

import type { ComplianceResult } from '@adcp/sdk/testing';

import {
  SPECIALISM_NOT_IN_RELEASE_NOTICE_CODE,
  comply,
  computeSpecialismStatus,
  derivePublicComplianceEligibility,
  deriveVerificationStatus,
} from '../../src/addie/services/compliance-testing.js';
import { hostedComplianceTarget } from '../../src/services/hosted-compliance-version.js';
import {
  complianceDirWith3_0GovernanceScoping,
  HOSTED_3_0_GOVERNANCE_POLICY,
} from '../../src/compliance/hosted-3-0-governance.js';

const AGENT_URL = 'https://agent.example/mcp';
const target = hostedComplianceTarget('3.0');

function resultFor(specialisms: string[]): ComplianceResult {
  return {
    agent_url: AGENT_URL,
    adcp_version: target.version,
    completeness: 'complete',
    agent_profile: { name: 'Seller', tools: [], specialisms },
    overall_status: 'passing',
    tracks: [],
    tested_tracks: [],
    skipped_tracks: [],
    summary: { tracks_passed: 1, tracks_failed: 0, tracks_skipped: 0, tracks_partial: 0, headline: 'ok' },
    observations: [],
    storyboards_executed: ['media_buy_seller'],
    bundle_results: [
      { kind: 'protocol', id: 'media-buy', storyboard_ids: ['media_buy_seller'], status: 'passing' },
      { kind: 'specialism', id: 'sales-guaranteed', storyboard_ids: ['sales_guaranteed'], status: 'passing' },
      ...specialisms.includes('sponsored-intelligence')
        ? [{ kind: 'specialism' as const, id: 'sponsored-intelligence', storyboard_ids: [], status: 'untested' as const }]
        : [],
    ],
    tested_at: new Date().toISOString(),
    total_duration_ms: 1,
    notices: [],
  } as unknown as ComplianceResult;
}

function unknownSpecialismError(specialism: string) {
  return new mocks.CapabilityResolutionError({
    code: 'unknown_specialism',
    specialism,
    message: `Agent declared specialism "${specialism}" but no bundle exists at /compliance/specialisms/${specialism}.`,
  });
}

function complianceDirsUsed(): Array<string | undefined> {
  return mocks.sdkComply.mock.calls.map(call => (call[1] as { complianceDir?: string }).complianceDir);
}

describe('hosted comply() with a specialism the graded release predates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discovery.mockResolvedValue({ profile: { tools: [], supported_protocols: ['media_buy'] }, steps: [] });
  });

  it('grades the rest of the run and marks the specialism not applicable', async () => {
    mocks.sdkComply
      .mockRejectedValueOnce(unknownSpecialismError('sponsored-intelligence'))
      .mockResolvedValueOnce(resultFor(['sales-guaranteed', 'sponsored-intelligence']));

    const result = await comply(AGENT_URL, {}, target);

    expect(mocks.sdkComply).toHaveBeenCalledTimes(2);
    const [firstDir, retryDir] = complianceDirsUsed();
    expect(firstDir).toBe(await complianceDirWith3_0GovernanceScoping(target));
    expect(retryDir).toBeTruthy();
    expect(retryDir).not.toBe(target.complianceDir);
    expect(retryDir).not.toBe(firstDir);

    const { resolveStoryboardsForCapabilities } = await vi.importActual<typeof import('@adcp/sdk/testing')>('@adcp/sdk/testing');
    const retriedSelection = resolveStoryboardsForCapabilities({
      supported_protocols: ['media_buy'],
      specialisms: ['sales-guaranteed', 'sponsored-intelligence'],
    }, { complianceDir: retryDir });
    expect(retriedSelection.storyboards.some(storyboard => storyboard.id.startsWith('media_buy_seller/governance_')))
      .toBe(false);

    expect(result.overall_status).toBe('passing');
    expect(result.completeness).toBe('complete');

    // The stored audit record says plainly that resolution saw more than the
    // released index, so a reader is never told 3.0.x graded a 3.1 specialism.
    const provenance = (result as ComplianceResult & { hosted_provenance?: { tolerated_undefined_specialisms?: string[] } })
      .hosted_provenance;
    expect(provenance?.tolerated_undefined_specialisms).toEqual(['sponsored-intelligence']);
    expect(result).toHaveProperty('hosted_provenance.grading_policy_version', HOSTED_3_0_GOVERNANCE_POLICY);

    const specialismBundle = result.bundle_results
      ?.find(bundle => bundle.kind === 'specialism' && bundle.id === 'sponsored-intelligence');
    expect(specialismBundle?.status).toBe('not_applicable');
    expect(result.bundle_results?.find(bundle => bundle.id === 'sales-guaranteed')?.status).toBe('passing');

    const notice = result.notices.find(entry => entry.code === SPECIALISM_NOT_IN_RELEASE_NOTICE_CODE);
    expect(notice?.severity).toBe('info');
    expect(notice?.message).toContain('sponsored-intelligence');
    expect(notice?.message).toContain(target.version);
    const observation = result.observations.find(entry =>
      entry.source?.code === 'specialism-not-in-compliance-release');
    expect(observation?.severity).toBe('info');
    expect(observation?.evidence).toMatchObject({ specialisms: ['sponsored-intelligence'] });
  });

  it('rewrites re-run commands back to the released bundle', async () => {
    mocks.sdkComply
      .mockRejectedValueOnce(unknownSpecialismError('sponsored-intelligence'))
      .mockImplementationOnce((_url: string, options: { complianceDir?: string }) => {
        const base = resultFor(['sales-guaranteed', 'sponsored-intelligence']);
        return Promise.resolve({
          ...base,
          failures: [{ fix_command: `adcp storyboard step agent sb step --compliance-dir ${options.complianceDir}` }],
        } as unknown as ComplianceResult);
      });

    const result = await comply(AGENT_URL, {}, target);

    expect(result.failures?.[0].fix_command).toContain(target.complianceDir);
    expect(result.failures?.[0].fix_command).not.toContain('adcp-compliance-overlay-');
    expect(result.failures?.[0].fix_command).not.toContain('adcp-3-0-governance-');
  });

  it('hands the retry what is left of the run budget', async () => {
    mocks.sdkComply
      .mockRejectedValueOnce(unknownSpecialismError('sponsored-intelligence'))
      .mockResolvedValueOnce(resultFor(['sales-guaranteed', 'sponsored-intelligence']));

    await comply(AGENT_URL, { timeout_ms: 60_000 }, target);

    const retryTimeout = (mocks.sdkComply.mock.calls[1][1] as { timeout_ms?: number }).timeout_ms;
    expect(retryTimeout).toBeGreaterThan(0);
    expect(retryTimeout).toBeLessThanOrEqual(60_000);
  });

  it('keeps failing closed on a specialism no release defines', async () => {
    mocks.sdkComply.mockRejectedValue(unknownSpecialismError('definitely-not-a-specialism'));

    await expect(comply(AGENT_URL, {}, target)).rejects.toThrow('definitely-not-a-specialism');
    expect(mocks.sdkComply).toHaveBeenCalledTimes(1);
  });

  it('retries once and still fails closed when an unknown id rides along', async () => {
    mocks.sdkComply
      .mockRejectedValueOnce(unknownSpecialismError('sponsored-intelligence'))
      .mockRejectedValueOnce(unknownSpecialismError('definitely-not-a-specialism'));

    await expect(comply(AGENT_URL, {}, target)).rejects.toThrow('definitely-not-a-specialism');
    expect(mocks.sdkComply).toHaveBeenCalledTimes(2);
  });

  it('does not retry a parent-protocol misconfiguration', async () => {
    mocks.sdkComply.mockRejectedValue(new mocks.CapabilityResolutionError({
      code: 'specialism_parent_protocol_missing',
      specialism: 'sales-guaranteed',
      parentProtocol: 'media-buy',
      message: 'Agent declared specialism "sales-guaranteed" (parent protocol: media-buy) but did not include "media-buy" in supported_protocols.',
    }));

    await expect(comply(AGENT_URL, {}, target)).rejects.toThrow('parent protocol');
    expect(mocks.sdkComply).toHaveBeenCalledTimes(1);
  });

  it('applies governance scoping without tolerating any unknown specialisms on a normal run', async () => {
    mocks.sdkComply.mockResolvedValueOnce(resultFor(['sales-guaranteed']));

    const result = await comply(AGENT_URL, {}, target);

    expect(mocks.sdkComply).toHaveBeenCalledTimes(1);
    expect(complianceDirsUsed()).toEqual([await complianceDirWith3_0GovernanceScoping(target)]);
    expect(
      (result as ComplianceResult & { hosted_provenance?: { tolerated_undefined_specialisms?: string[] } })
        .hosted_provenance?.tolerated_undefined_specialisms,
    ).toBeUndefined();
    expect(result.notices).toEqual([]);
    expect(result.observations).toEqual([]);
  });
});

describe('badge eligibility for a specialism the graded release predates', () => {
  // sales-dooh is a stable media-buy specialism in SPECIALISM_CATALOG that
  // AdCP introduced after 3.0, so a 3.0 run has no storyboards for it.
  const passingGuaranteed = [
    { storyboard_id: 'sales_guaranteed', status: 'passing' as const, steps_passed: 4, steps_total: 4 },
  ];

  it('never credits a specialism the release could not grade', () => {
    const verification = deriveVerificationStatus(
      ['sales-guaranteed', 'sales-dooh'],
      passingGuaranteed,
      target.version,
    );
    const mediaBuy = verification.roles.find(role => role.role === 'media-buy');
    expect(mediaBuy?.specialisms).toEqual(['sales-guaranteed']);
    expect(mediaBuy?.passing).toEqual(['sales-guaranteed']);
    expect(mediaBuy?.failing).toEqual([]);
    expect(mediaBuy?.untested).toEqual([]);
  });

  it('issues no role at all when every declared specialism is ungradable here', () => {
    const verification = deriveVerificationStatus(['sales-dooh'], [], target.version);
    expect(verification.roles).toEqual([]);
    expect(verification.verified).toBe(false);
  });

  it('still blocks a role whose gradable specialism has no evidence', () => {
    const verification = deriveVerificationStatus(
      ['sales-guaranteed', 'sales-dooh'],
      [],
      target.version,
    );
    const mediaBuy = verification.roles.find(role => role.role === 'media-buy');
    expect(mediaBuy?.verified).toBe(false);
    expect(mediaBuy?.failing).toEqual(['sales-guaranteed']);
  });

  it('keeps the historical reading when the graded release is unknown', () => {
    const verification = deriveVerificationStatus(['sales-guaranteed', 'sales-dooh'], passingGuaranteed);
    const mediaBuy = verification.roles.find(role => role.role === 'media-buy');
    expect(mediaBuy?.verified).toBe(false);
    expect(mediaBuy?.failing).toContain('sales-dooh');
  });

  it('reports no public eligibility blocker for an ungradable specialism', () => {
    const eligibility = derivePublicComplianceEligibility(
      ['sales-guaranteed', 'sales-dooh'],
      passingGuaranteed.map(entry => ({ ...entry })),
      target.version,
    );
    expect(eligibility.roles['media-buy']).toEqual({ eligible: true, blockers: [] });
  });

  it('reports the specialism as not applicable rather than as an agent defect', () => {
    expect(computeSpecialismStatus(
      ['sales-guaranteed', 'sales-dooh', 'definitely-not-a-specialism'],
      [{ storyboard_id: 'sales_guaranteed', status: 'passing', steps_passed: 4, steps_total: 4 }],
      target.version,
    )).toEqual({
      'sales-guaranteed': 'passing',
      'sales-dooh': 'not_applicable',
      'definitely-not-a-specialism': 'unknown',
    });
  });

  it('keeps the untested reading when the graded release is unknown', () => {
    expect(computeSpecialismStatus(
      ['sales-dooh'],
      [],
    )).toEqual({ 'sales-dooh': 'untested' });
  });

  it('keeps a real verdict from a release that does define the specialism', () => {
    expect(computeSpecialismStatus(
      ['sales-dooh'],
      [{ storyboard_id: 'sales_dooh', status: 'passing', steps_passed: 6, steps_total: 6 }],
      target.version,
    )).toEqual({ 'sales-dooh': 'passing' });
  });
});
