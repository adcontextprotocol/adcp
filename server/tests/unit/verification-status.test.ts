import { describe, it, expect } from 'vitest';
import { deriveVerificationStatus } from '../../src/addie/services/compliance-testing.js';
import type { StoryboardStatusEntry } from '../../src/db/compliance-db.js';

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

  it('excludes preview specialisms from badge issuance', () => {
    // sales-exchange is `status: preview` in the catalog; sales-broadcast-tv is stable
    const declared = ['sales-exchange', 'sales-broadcast-tv'];
    const statuses = [
      makeStatus('sales_exchange', 'passing'),
      makeStatus('sales_broadcast_tv', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('media-buy');
    // Only the stable specialism shows up in the badge
    expect(result.roles[0].specialisms).toEqual(['sales-broadcast-tv']);
    expect(result.roles[0].passing).toEqual(['sales-broadcast-tv']);
  });

  it('does not issue a badge when only preview specialisms are declared', () => {
    // All declared specialisms are preview — no stable badge should issue
    const declared = ['sales-exchange', 'sales-streaming-tv'];
    const statuses = [
      makeStatus('sales_exchange', 'passing'),
      makeStatus('sales_streaming_tv', 'passing'),
    ];
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
