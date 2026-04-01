import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationIndex, type AuthorizationEntry } from '../../../src/registry-sync/authorization-index.js';
import { CatalogPropertyIndex } from '../../../src/registry-sync/property-index.js';

function makeEntry(overrides: Partial<AuthorizationEntry>): AuthorizationEntry {
  return {
    agent_url: 'https://agent.example.com',
    publisher_domain: 'publisher.example.com',
    authorization_type: 'publisher_properties',
    ...overrides,
  };
}

describe('AuthorizationIndex', () => {
  let index: AuthorizationIndex;
  let propertyIndex: CatalogPropertyIndex;

  beforeEach(() => {
    propertyIndex = new CatalogPropertyIndex();
    index = new AuthorizationIndex(propertyIndex);

    // Set up a property so we can resolve rid -> domain
    propertyIndex.upsert({
      property_rid: 'rid-001',
      identifiers: [{ type: 'domain', value: 'publisher.example.com' }],
      classification: 'property',
      publisher_domain: 'publisher.example.com',
    });
  });

  // ── Index mutations ─────────────────────────────────────────────

  describe('addEntry / removeEntry', () => {
    it('adds and retrieves entries', () => {
      index.addEntry(makeEntry({}));
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.authorized).toBe(true);
    });

    it('removes entries', () => {
      index.addEntry(makeEntry({}));
      index.removeEntry('https://agent.example.com', 'publisher.example.com');
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.authorized).toBe(false);
    });

    it('removes all entries for an agent', () => {
      index.addEntry(makeEntry({ publisher_domain: 'a.com' }));
      index.addEntry(makeEntry({ publisher_domain: 'b.com' }));
      index.removeAgent('https://agent.example.com');
      expect(index.size).toBe(0);
    });

    it('skips signal_ids and signal_tags types', () => {
      index.addEntry(makeEntry({ authorization_type: 'signal_ids' }));
      index.addEntry(makeEntry({ authorization_type: 'signal_tags' }));
      expect(index.size).toBe(0);
    });

    it('tracks size correctly', () => {
      index.addEntry(makeEntry({}));
      index.addEntry(makeEntry({ publisher_domain: 'other.com' }));
      expect(index.size).toBe(2);
    });
  });

  // ── Authorization type: publisher_properties ─────────────────────

  describe('authorization_type: publisher_properties', () => {
    beforeEach(() => {
      index.addEntry(makeEntry({ authorization_type: 'publisher_properties' }));
    });

    it('authorizes any property under the publisher domain', () => {
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.authorized).toBe(true);
      expect(result.authorization_type).toBe('publisher_properties');
    });

    it('rejects property under different publisher', () => {
      propertyIndex.upsert({
        property_rid: 'rid-002',
        identifiers: [{ type: 'domain', value: 'other.example.com' }],
        classification: 'property',
        publisher_domain: 'other.example.com',
      });
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-002' });
      expect(result.authorized).toBe(false);
    });
  });

  // ── Authorization type: property_ids ─────────────────────────────

  describe('authorization_type: property_ids', () => {
    beforeEach(() => {
      index.addEntry(makeEntry({
        authorization_type: 'property_ids',
        property_ids: ['homepage', 'news_section'],
      }));
    });

    it('authorizes matching property_id', () => {
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        property_id: 'homepage',
      });
      expect(result.authorized).toBe(true);
    });

    it('rejects non-matching property_id', () => {
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        property_id: 'sports_section',
      });
      expect(result.authorized).toBe(false);
    });

    it('authorizes when no property_id in query', () => {
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
      });
      expect(result.authorized).toBe(true);
    });
  });

  // ── Authorization type: property_tags ────────────────────────────

  describe('authorization_type: property_tags', () => {
    it('authorizes (tag resolution deferred to index build time)', () => {
      index.addEntry(makeEntry({
        authorization_type: 'property_tags',
        property_tags: ['premium', 'news'],
      }));
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.authorized).toBe(true);
    });
  });

  // ── Authorization type: inline_properties ────────────────────────

  describe('authorization_type: inline_properties', () => {
    beforeEach(() => {
      index.addEntry(makeEntry({
        authorization_type: 'inline_properties',
        property_ids: ['inline_prop_1'],
      }));
    });

    it('authorizes matching inline property_id', () => {
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        property_id: 'inline_prop_1',
      });
      expect(result.authorized).toBe(true);
    });

    it('rejects non-matching property_id', () => {
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        property_id: 'other_prop',
      });
      expect(result.authorized).toBe(false);
    });
  });

  // ── Placement scoping ───────────────────────────────────────────

  describe('placement scoping', () => {
    it('authorizes when placement_ids match', () => {
      index.addEntry(makeEntry({
        placement_ids: ['pre_roll_30s', 'mid_roll_15s'],
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        placement_id: 'pre_roll_30s',
      });
      expect(result.authorized).toBe(true);
    });

    it('rejects when placement_ids do not match', () => {
      index.addEntry(makeEntry({
        placement_ids: ['pre_roll_30s'],
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        placement_id: 'post_roll_60s',
      });
      expect(result.authorized).toBe(false);
    });

    it('authorizes all placements when no placement_ids on entry', () => {
      index.addEntry(makeEntry({}));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        placement_id: 'any_placement',
      });
      expect(result.authorized).toBe(true);
    });

    it('authorizes when no placement in query', () => {
      index.addEntry(makeEntry({
        placement_ids: ['pre_roll_30s'],
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
      });
      expect(result.authorized).toBe(true);
    });

    it('matches placement_tags', () => {
      index.addEntry(makeEntry({
        placement_tags: ['video', 'premium'],
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        placement_tags: ['video'],
      });
      expect(result.authorized).toBe(true);
    });
  });

  // ── Country filtering ───────────────────────────────────────────

  describe('country filtering', () => {
    it('authorizes matching country', () => {
      index.addEntry(makeEntry({ countries: ['US', 'CA'] }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        country: 'US',
      });
      expect(result.authorized).toBe(true);
    });

    it('rejects non-matching country', () => {
      index.addEntry(makeEntry({ countries: ['US', 'CA'] }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        country: 'DE',
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toBe('country not authorized');
    });

    it('authorizes worldwide when no countries on entry', () => {
      index.addEntry(makeEntry({}));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        country: 'JP',
      });
      expect(result.authorized).toBe(true);
    });

    it('authorizes when no country in query', () => {
      index.addEntry(makeEntry({ countries: ['US'] }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
      });
      expect(result.authorized).toBe(true);
    });
  });

  // ── Collection scoping ──────────────────────────────────────────

  describe('collection scoping', () => {
    it('authorizes matching collection', () => {
      index.addEntry(makeEntry({
        collections: [{ publisher_domain: 'publisher.example.com', collection_id: 'primetime_drama' }],
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        collection_id: 'primetime_drama',
      });
      expect(result.authorized).toBe(true);
    });

    it('rejects non-matching collection', () => {
      index.addEntry(makeEntry({
        collections: [{ publisher_domain: 'publisher.example.com', collection_id: 'primetime_drama' }],
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        collection_id: 'kids_animation',
      });
      expect(result.authorized).toBe(false);
    });

    it('authorizes all collections when none on entry', () => {
      index.addEntry(makeEntry({}));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        collection_id: 'anything',
      });
      expect(result.authorized).toBe(true);
    });
  });

  // ── Time windows ────────────────────────────────────────────────

  describe('time windows', () => {
    const now = new Date('2026-06-15T12:00:00Z');

    it('authorizes within window', () => {
      index.addEntry(makeEntry({
        effective_from: '2026-01-01T00:00:00Z',
        effective_until: '2026-12-31T23:59:59Z',
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        timestamp: now,
      });
      expect(result.authorized).toBe(true);
    });

    it('rejects before window', () => {
      index.addEntry(makeEntry({
        effective_from: '2026-07-01T00:00:00Z',
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        timestamp: now,
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toBe('authorization not yet effective');
    });

    it('rejects after window', () => {
      index.addEntry(makeEntry({
        effective_until: '2026-01-01T00:00:00Z',
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        timestamp: now,
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toBe('authorization expired');
    });

    it('authorizes with no time constraints', () => {
      index.addEntry(makeEntry({}));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        timestamp: now,
      });
      expect(result.authorized).toBe(true);
    });

    it('handles effective_from only', () => {
      index.addEntry(makeEntry({
        effective_from: '2026-01-01T00:00:00Z',
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        timestamp: now,
      });
      expect(result.authorized).toBe(true);
    });

    it('handles effective_until only', () => {
      index.addEntry(makeEntry({
        effective_until: '2027-01-01T00:00:00Z',
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        timestamp: now,
      });
      expect(result.authorized).toBe(true);
    });
  });

  // ── Signing keys ────────────────────────────────────────────────

  describe('signing keys', () => {
    it('returns signing keys for agent/publisher pair', () => {
      index.addEntry(makeEntry({
        signing_keys: [{ algorithm: 'ed25519', public_key: 'base64key' }],
      }));
      const keys = index.getSigningKeys('https://agent.example.com', 'publisher.example.com');
      expect(keys).toHaveLength(1);
      expect(keys[0].algorithm).toBe('ed25519');
    });

    it('returns empty for unknown pair', () => {
      const keys = index.getSigningKeys('https://unknown.example.com', 'publisher.example.com');
      expect(keys).toHaveLength(0);
    });

    it('includes signing keys in check result', () => {
      index.addEntry(makeEntry({
        signing_keys: [{ algorithm: 'ed25519', public_key: 'key1' }],
      }));
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.authorized).toBe(true);
      expect(result.signing_keys).toHaveLength(1);
    });
  });

  // ── Delegation and exclusivity ──────────────────────────────────

  describe('delegation and exclusivity metadata', () => {
    it('propagates delegation_type in result', () => {
      index.addEntry(makeEntry({ delegation_type: 'direct' }));
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.delegation_type).toBe('direct');
    });

    it('propagates exclusive flag in result', () => {
      index.addEntry(makeEntry({ exclusive: true }));
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-001' });
      expect(result.exclusive).toBe(true);
    });
  });

  // ── Multiple entries ────────────────────────────────────────────

  describe('multiple entries for same agent/publisher', () => {
    it('finds most permissive match across entries', () => {
      // First entry: restricted to specific placement
      index.addEntry(makeEntry({
        authorization_type: 'property_ids',
        property_ids: ['homepage'],
        placement_ids: ['banner_300x250'],
      }));
      // Second entry: blanket authorization
      index.addEntry(makeEntry({
        authorization_type: 'publisher_properties',
      }));

      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        property_id: 'sports_section',
        placement_id: 'pre_roll_30s',
      });
      // Second entry should match even though first doesn't
      expect(result.authorized).toBe(true);
      expect(result.authorization_type).toBe('publisher_properties');
    });
  });

  // ── Reverse index ───────────────────────────────────────────────

  describe('getAuthorizedAgents (reverse index)', () => {
    it('returns agents authorized for a property', () => {
      index.addEntry(makeEntry({ agent_url: 'https://agent1.example.com' }));
      index.addEntry(makeEntry({ agent_url: 'https://agent2.example.com' }));
      index.addEntry(makeEntry({
        agent_url: 'https://agent3.example.com',
        publisher_domain: 'other.example.com',
      }));

      const agents = index.getAuthorizedAgents('rid-001');
      expect(agents).toContain('https://agent1.example.com');
      expect(agents).toContain('https://agent2.example.com');
      expect(agents).not.toContain('https://agent3.example.com');
    });

    it('returns empty for unknown property', () => {
      const agents = index.getAuthorizedAgents('unknown-rid');
      expect(agents).toHaveLength(0);
    });
  });

  // ── getAuthorizedPlacements ─────────────────────────────────────

  describe('getAuthorizedPlacements', () => {
    it('returns placement IDs from entries', () => {
      index.addEntry(makeEntry({ placement_ids: ['pre_roll', 'mid_roll'] }));
      index.addEntry(makeEntry({ placement_ids: ['post_roll'] }));
      const placements = index.getAuthorizedPlacements('https://agent.example.com', 'rid-001');
      expect(placements).toContain('pre_roll');
      expect(placements).toContain('mid_roll');
      expect(placements).toContain('post_roll');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('rejects unknown agent', () => {
      const result = index.check({ agent_url: 'https://unknown.example.com', property_rid: 'rid-001' });
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('agent not found');
    });

    it('rejects when property cannot be resolved to domain', () => {
      index.addEntry(makeEntry({}));
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'unknown-rid' });
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain('cannot resolve property');
    });

    it('handles blanket authorization (no scoping)', () => {
      index.addEntry(makeEntry({
        authorization_type: 'publisher_properties',
        // No placement, country, collection, or time constraints
      }));
      const result = index.check({
        agent_url: 'https://agent.example.com',
        property_rid: 'rid-001',
        placement_id: 'anything',
        country: 'JP',
        collection_id: 'any_collection',
        timestamp: new Date('2030-01-01'),
      });
      expect(result.authorized).toBe(true);
    });

    it('agent authorized by publisher A rejected for publisher B', () => {
      index.addEntry(makeEntry({ publisher_domain: 'publisher-a.com' }));
      propertyIndex.upsert({
        property_rid: 'rid-b',
        identifiers: [],
        classification: 'property',
        publisher_domain: 'publisher-b.com',
      });
      const result = index.check({ agent_url: 'https://agent.example.com', property_rid: 'rid-b' });
      expect(result.authorized).toBe(false);
    });
  });
});
