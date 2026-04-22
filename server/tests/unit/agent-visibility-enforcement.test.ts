import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/types.js';

describe('demotePublicAgentsOnTierDowngrade', () => {
  let memberDb: any;
  let brandDb: any;
  let demote: typeof import('../../src/services/agent-visibility-enforcement.js').demotePublicAgentsOnTierDowngrade;

  beforeEach(async () => {
    memberDb = {
      getProfileByOrgId: vi.fn(),
      updateProfileByOrgId: vi.fn().mockResolvedValue(null),
    };
    brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      updateManifestAgents: vi.fn().mockResolvedValue(undefined),
    };
    ({ demotePublicAgentsOnTierDowngrade: demote } = await import(
      '../../src/services/agent-visibility-enforcement.js'
    ));
  });

  function agent(url: string, visibility: AgentConfig['visibility']): AgentConfig {
    return { url, visibility };
  }

  it('no-op when old tier had no API access', async () => {
    const result = await demote('org1', 'individual_academic', null, memberDb, brandDb);
    expect(result).toBeNull();
    expect(memberDb.getProfileByOrgId).not.toHaveBeenCalled();
  });

  it('no-op when new tier still has API access', async () => {
    const result = await demote('org1', 'company_icl', 'individual_professional', memberDb, brandDb);
    expect(result).toBeNull();
    expect(memberDb.getProfileByOrgId).not.toHaveBeenCalled();
  });

  it('no-op when org has no profile', async () => {
    memberDb.getProfileByOrgId.mockResolvedValue(null);
    const result = await demote('org1', 'individual_professional', null, memberDb, brandDb);
    expect(result).toBeNull();
    expect(memberDb.updateProfileByOrgId).not.toHaveBeenCalled();
  });

  it('no-op when profile has no public agents', async () => {
    memberDb.getProfileByOrgId.mockResolvedValue({
      agents: [agent('https://a.example', 'private'), agent('https://b.example', 'members_only')],
      primary_brand_domain: null,
    });
    const result = await demote('org1', 'individual_professional', 'individual_academic', memberDb, brandDb);
    expect(result).toBeNull();
    expect(memberDb.updateProfileByOrgId).not.toHaveBeenCalled();
  });

  it('demotes public agents to members_only on Professional → Explorer', async () => {
    memberDb.getProfileByOrgId.mockResolvedValue({
      agents: [
        agent('https://pub.example', 'public'),
        agent('https://mem.example', 'members_only'),
        agent('https://priv.example', 'private'),
      ],
      primary_brand_domain: null,
    });
    const result = await demote('org1', 'individual_professional', 'individual_academic', memberDb, brandDb);
    expect(result).toEqual({ orgId: 'org1', demotedCount: 1, brandJsonCleared: false });
    expect(memberDb.updateProfileByOrgId).toHaveBeenCalledWith('org1', {
      agents: [
        agent('https://pub.example', 'members_only'),
        agent('https://mem.example', 'members_only'),
        agent('https://priv.example', 'private'),
      ],
    });
  });

  it('demotes on full cancellation (newTier = null)', async () => {
    memberDb.getProfileByOrgId.mockResolvedValue({
      agents: [agent('https://p.example', 'public')],
      primary_brand_domain: null,
    });
    const result = await demote('org1', 'company_leader', null, memberDb, brandDb);
    expect(result?.demotedCount).toBe(1);
  });

  it('clears demoted agents from a community brand.json', async () => {
    memberDb.getProfileByOrgId.mockResolvedValue({
      agents: [agent('https://p.example', 'public')],
      primary_brand_domain: 'acme.example',
    });
    brandDb.getDiscoveredBrandByDomain.mockResolvedValue({
      source_type: 'community',
      brand_manifest: {
        agents: [
          { url: 'https://p.example', type: 'brand', id: 'p' },
          { url: 'https://other.example', type: 'brand', id: 'other' },
        ],
      },
    });
    const result = await demote('org1', 'individual_professional', null, memberDb, brandDb);
    expect(result?.brandJsonCleared).toBe(true);
    expect(brandDb.updateManifestAgents).toHaveBeenCalledWith(
      'acme.example',
      [{ url: 'https://other.example', type: 'brand', id: 'other' }],
      expect.objectContaining({ summary: expect.stringContaining('Tier downgrade') }),
    );
  });

  it('does not touch brand.json for self-hosted brands', async () => {
    memberDb.getProfileByOrgId.mockResolvedValue({
      agents: [agent('https://p.example', 'public')],
      primary_brand_domain: 'acme.example',
    });
    brandDb.getDiscoveredBrandByDomain.mockResolvedValue({
      source_type: 'brand_json',
      brand_manifest: {
        agents: [{ url: 'https://p.example', type: 'brand', id: 'p' }],
      },
    });
    const result = await demote('org1', 'individual_professional', null, memberDb, brandDb);
    expect(result?.brandJsonCleared).toBe(false);
    expect(brandDb.updateManifestAgents).not.toHaveBeenCalled();
  });
});
