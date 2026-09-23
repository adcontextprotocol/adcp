import { describe, it, expect } from 'vitest';
import {
  derivePublicComplianceEligibility,
  deriveVerificationStatus,
  ELIGIBILITY_CRITERIA_VERSION,
} from '../../src/addie/services/compliance-testing.js';
import type { StoryboardStatusEntry } from '../../src/db/compliance-db.js';
import { AgentComplianceDetailSchema } from '../../src/schemas/registry.js';

function makeStatus(id: string, status: StoryboardStatusEntry['status']): StoryboardStatusEntry {
  return { storyboard_id: id, status, steps_passed: status === 'passing' ? 5 : 0, steps_total: 5 };
}

describe('deriveVerificationStatus', () => {
  it('returns not verified when no specialisms declared', () => {
    const result = deriveVerificationStatus([], []);
    expect(result.verified).toBe(false);
    expect(result.roles).toHaveLength(0);
  });

  it('verifies media-buy role when the declared sales specialism passes', () => {
    const declared = ['sales-non-guaranteed'];
    const statuses = [makeStatus('sales_non_guaranteed', 'passing')];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('media-buy');
    expect(result.roles[0].verified).toBe(true);
    expect(result.roles[0].passing).toEqual(['sales-non-guaranteed']);
    expect(result.roles[0].failing).toHaveLength(0);
  });

  it('does not verify when a declared specialism is failing', () => {
    const declared = ['sales-non-guaranteed', 'sales-guaranteed'];
    const statuses = [
      makeStatus('sales_non_guaranteed', 'passing'),
      makeStatus('sales_guaranteed', 'failing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].role).toBe('media-buy');
    expect(result.roles[0].verified).toBe(false);
    expect(result.roles[0].failing).toEqual(['sales-guaranteed']);
  });

  it('does not verify when a declared specialism has no status (untested)', () => {
    const declared = ['sales-non-guaranteed'];
    const statuses: StoryboardStatusEntry[] = [];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].verified).toBe(false);
    expect(result.roles[0].failing).toEqual(['sales-non-guaranteed']);
  });

  it('keeps a legacy zero-step row untested while denying badge eligibility', () => {
    const declared = ['sales-non-guaranteed'];
    const statuses: StoryboardStatusEntry[] = [{
      storyboard_id: 'sales_non_guaranteed',
      status: 'failing',
      steps_passed: 0,
      steps_total: 0,
    }];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].verified).toBe(false);
    expect(result.roles[0].passing).toEqual([]);
    expect(result.roles[0].failing).toEqual([]);
    expect(result.roles[0].untested).toEqual(['sales-non-guaranteed']);
  });

  it('handles multiple protocols when specialisms from different protocols all pass', () => {
    const declared = ['sales-non-guaranteed', 'creative-template'];
    const statuses = [
      makeStatus('sales_non_guaranteed', 'passing'),
      makeStatus('creative_template', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(2);

    const mediaBuy = result.roles.find(r => r.role === 'media-buy');
    const creative = result.roles.find(r => r.role === 'creative');
    expect(mediaBuy?.verified).toBe(true);
    expect(creative?.verified).toBe(true);
  });

  it('can verify one protocol while another fails', () => {
    const declared = ['sales-non-guaranteed', 'creative-template'];
    const statuses = [
      makeStatus('sales_non_guaranteed', 'passing'),
      makeStatus('creative_template', 'failing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true); // at least one role verified

    const mediaBuy = result.roles.find(r => r.role === 'media-buy');
    const creative = result.roles.find(r => r.role === 'creative');
    expect(mediaBuy?.verified).toBe(true);
    expect(creative?.verified).toBe(false);
  });

  it('ignores unknown specialisms', () => {
    const declared = ['not-a-real-specialism'];
    const statuses: StoryboardStatusEntry[] = [];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles).toHaveLength(0);
  });

  it('handles partial storyboard status as not verified', () => {
    const declared = ['sales-non-guaranteed'];
    const statuses = [makeStatus('sales_non_guaranteed', 'partial')];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].verified).toBe(false);
  });

  it('excludes preview specialisms from badge issuance (when any are marked preview)', () => {
    // No specialisms are marked `status: preview` in the catalog as of merge into main —
    // the previously-preview ones (sales-exchange, sales-retail-media, sales-streaming-tv,
    // measurement-verification) were removed from the enum entirely. The preview-handling
    // path (deriveVerificationStatus filters via isStableSpecialism) still exists for when
    // future specialisms ship with status: preview. This test exercises the filter by
    // mocking an unknown specialism — isStableSpecialism returns true for unknown
    // (safe default) so it doesn't substitute, but the overall pipeline should drop
    // unknowns from the catalog mapping below.
    const declared = ['not-a-real-specialism', 'sales-broadcast-tv'];
    const statuses = [
      makeStatus('sales_broadcast_tv', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('media-buy');
    // Only the known specialism shows up in the badge
    expect(result.roles[0].specialisms).toEqual(['sales-broadcast-tv']);
    expect(result.roles[0].passing).toEqual(['sales-broadcast-tv']);
  });

  it('does not issue a badge when no declared specialisms are known to the catalog', () => {
    const declared = ['fake-specialism-1', 'fake-specialism-2'];
    const statuses: StoryboardStatusEntry[] = [];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles).toHaveLength(0);
  });

  it('groups multiple governance specialisms under the governance protocol', () => {
    const declared = ['property-lists', 'governance-spend-authority'];
    const statuses = [
      makeStatus('property_lists', 'passing'),
      makeStatus('governance_spend_authority', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('governance');
    expect(result.roles[0].verified).toBe(true);
    expect(result.roles[0].specialisms).toHaveLength(2);
  });

  it('puts audience-sync under media-buy protocol', () => {
    const declared = ['audience-sync'];
    const statuses = [makeStatus('audience_sync', 'passing')];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('media-buy');
  });
});

describe('derivePublicComplianceEligibility', () => {
  it('publishes a versioned agent-level blocker when no specialisms were declared', () => {
    expect(derivePublicComplianceEligibility([], [])).toEqual({
      criteria_version: ELIGIBILITY_CRITERIA_VERSION,
      blockers: [{ code: 'no_declared_specialisms' }],
      roles: {},
    });
  });

  it('preserves failing, partial, and untested as distinct role blockers', () => {
    const result = derivePublicComplianceEligibility(
      ['sales-guaranteed', 'sales-non-guaranteed', 'sales-social'],
      [
        makeStatus('sales_guaranteed', 'failing'),
        makeStatus('sales_non_guaranteed', 'partial'),
      ],
    );

    expect(result.roles['media-buy']).toEqual({
      eligible: false,
      blockers: [
        { code: 'storyboards_failing' },
        { code: 'storyboards_partial' },
        { code: 'storyboards_untested' },
      ],
    });
  });

  it('treats explicit untested and legacy zero-step rows as untested', () => {
    for (const status of [
      makeStatus('sales_guaranteed', 'untested'),
      { ...makeStatus('sales_guaranteed', 'failing'), steps_total: 0 },
    ]) {
      expect(derivePublicComplianceEligibility(['sales-guaranteed'], [status]).roles['media-buy'])
        .toEqual({ eligible: false, blockers: [{ code: 'storyboards_untested' }] });
    }
  });

  it('evaluates roles independently and emits no blocker for a passing role', () => {
    const result = derivePublicComplianceEligibility(
      ['sales-guaranteed', 'creative-template'],
      [
        makeStatus('sales_guaranteed', 'passing'),
        makeStatus('creative_template', 'partial'),
      ],
    );

    expect(result.roles['media-buy']).toEqual({ eligible: true, blockers: [] });
    expect(result.roles.creative).toEqual({
      eligible: false,
      blockers: [{ code: 'storyboards_partial' }],
    });
  });

  it('does not invent a role for unknown specialisms and still explains ineligibility', () => {
    expect(derivePublicComplianceEligibility(['not-a-real-specialism'], [])).toEqual({
      criteria_version: ELIGIBILITY_CRITERIA_VERSION,
      blockers: [{ code: 'no_declared_specialisms' }],
      roles: {},
    });
  });

  it('fails closed when a future storyboard status reaches the public projection', () => {
    const result = derivePublicComplianceEligibility(
      ['sales-guaranteed'],
      [{ storyboard_id: 'sales_guaranteed', status: 'future-status', steps_total: 5 }],
    );

    expect(result.roles['media-buy']).toEqual({
      eligible: false,
      blockers: [{ code: 'storyboards_untested' }],
    });
  });

  it('publishes a partial role map and keeps membership blockers owner-scoped', () => {
    const parsed = AgentComplianceDetailSchema.parse({
      agent_url: 'https://agent.example.com/mcp',
      status: 'failing',
      lifecycle_stage: 'production',
      eligibility: {
        criteria_version: ELIGIBILITY_CRITERIA_VERSION,
        blockers: [],
        roles: {
          'media-buy': {
            eligible: false,
            blockers: [{ code: 'storyboards_partial' }],
          },
        },
      },
      eligibility_owner: {
        criteria_version: ELIGIBILITY_CRITERIA_VERSION,
        eligible: null,
        blockers: [],
      },
    });

    expect(parsed.eligibility?.roles['media-buy']?.blockers).toEqual([
      { code: 'storyboards_partial' },
    ]);
    expect(() => AgentComplianceDetailSchema.parse({
      agent_url: 'https://agent.example.com/mcp',
      status: 'failing',
      lifecycle_stage: 'production',
      eligibility: {
        criteria_version: ELIGIBILITY_CRITERIA_VERSION,
        blockers: [],
        roles: {
          'media-buy': {
            eligible: false,
            blockers: [{ code: 'membership_tier_ineligible' }],
          },
        },
      },
    })).toThrow();
  });
});
