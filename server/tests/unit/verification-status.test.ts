import { describe, it, expect } from 'vitest';
import { deriveVerificationStatus } from '../../src/addie/services/compliance-testing.js';
import type { StoryboardStatusEntry } from '../../src/db/compliance-db.js';

function makeStatus(id: string, status: StoryboardStatusEntry['status']): StoryboardStatusEntry {
  return { storyboard_id: id, status, steps_passed: status === 'passing' ? 5 : 0, steps_total: 5 };
}

describe('deriveVerificationStatus', () => {
  it('returns not verified when no storyboards declared', () => {
    const result = deriveVerificationStatus([], []);
    expect(result.verified).toBe(false);
    expect(result.roles).toHaveLength(0);
  });

  it('verifies sales role when all declared media_buy storyboards pass', () => {
    const declared = ['media_buy_seller'];
    const statuses = [makeStatus('media_buy_seller', 'passing')];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('sales');
    expect(result.roles[0].verified).toBe(true);
    expect(result.roles[0].passing).toEqual(['media_buy_seller']);
    expect(result.roles[0].failing).toHaveLength(0);
  });

  it('does not verify when a declared storyboard is failing', () => {
    const declared = ['media_buy_seller', 'media_buy_non_guaranteed'];
    const statuses = [
      makeStatus('media_buy_seller', 'passing'),
      makeStatus('media_buy_non_guaranteed', 'failing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].role).toBe('sales');
    expect(result.roles[0].verified).toBe(false);
    expect(result.roles[0].failing).toEqual(['media_buy_non_guaranteed']);
  });

  it('does not verify when a declared storyboard has no status (untested)', () => {
    const declared = ['media_buy_seller'];
    const statuses: StoryboardStatusEntry[] = [];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].verified).toBe(false);
    expect(result.roles[0].failing).toEqual(['media_buy_seller']);
  });

  it('handles multiple roles from different storyboard tracks', () => {
    const declared = ['media_buy_seller', 'creative_template'];
    const statuses = [
      makeStatus('media_buy_seller', 'passing'),
      makeStatus('creative_template', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(2);

    const salesRole = result.roles.find(r => r.role === 'sales');
    const creativeRole = result.roles.find(r => r.role === 'creative');
    expect(salesRole?.verified).toBe(true);
    expect(creativeRole?.verified).toBe(true);
  });

  it('can verify one role while another fails', () => {
    const declared = ['media_buy_seller', 'creative_template'];
    const statuses = [
      makeStatus('media_buy_seller', 'passing'),
      makeStatus('creative_template', 'failing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true); // at least one role verified

    const salesRole = result.roles.find(r => r.role === 'sales');
    const creativeRole = result.roles.find(r => r.role === 'creative');
    expect(salesRole?.verified).toBe(true);
    expect(creativeRole?.verified).toBe(false);
  });

  it('ignores core storyboards that do not map to a role', () => {
    const declared = ['capability_discovery', 'schema_validation'];
    const statuses = [
      makeStatus('capability_discovery', 'passing'),
      makeStatus('schema_validation', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    // Core storyboards don't map to any role badge
    expect(result.verified).toBe(false);
    expect(result.roles).toHaveLength(0);
  });

  it('handles partial storyboard status as not verified', () => {
    const declared = ['media_buy_seller'];
    const statuses = [makeStatus('media_buy_seller', 'partial')];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(false);
    expect(result.roles[0].verified).toBe(false);
  });

  it('groups governance storyboards from both governance and campaign_governance tracks', () => {
    const declared = ['property_governance', 'campaign_governance_denied'];
    const statuses = [
      makeStatus('property_governance', 'passing'),
      makeStatus('campaign_governance_denied', 'passing'),
    ];
    const result = deriveVerificationStatus(declared, statuses);

    expect(result.verified).toBe(true);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].role).toBe('governance');
    expect(result.roles[0].verified).toBe(true);
    expect(result.roles[0].storyboards).toHaveLength(2);
  });
});
