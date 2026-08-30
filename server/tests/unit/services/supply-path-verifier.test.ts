import { describe, it, expect } from 'vitest';
import {
  verifySupplyPath,
  parseInventoryPartnerDomains,
  type SupplyPathInput,
} from '../../../src/services/supply-path-verifier.js';
import type { AdagentsManifest } from '../../../src/db/publisher-db.js';

const AGENT = 'https://sales.channel-owner.example';

function ownerManifest(overrides: Partial<AdagentsManifest> = {}): AdagentsManifest {
  return {
    authorized_agents: [{ url: AGENT, authorized_for: 'Owner-sold avails' }],
    collections: [{
      collection_id: 'retro_news',
      name: 'Acme Retro News',
      kind: 'channel',
      distribution: [{
        publisher_domain: 'hoststream.example',
        property_ids: ['hoststream_ctv'],
      }],
    }] as never,
    ...overrides,
  };
}

function hostManifest(overrides: Partial<AdagentsManifest> = {}): AdagentsManifest {
  return {
    properties: [{ property_id: 'hoststream_ctv', name: 'HostStream CTV' }] as never,
    authorized_agents: [{
      url: AGENT,
      authorized_for: 'Owner-sold avails for Acme Retro News',
      authorization_type: 'property_ids',
      property_ids: ['hoststream_ctv'],
      collections: [{ publisher_domain: 'channel-owner.example', collection_ids: ['retro_news'] }],
    }],
    ...overrides,
  };
}

function input(overrides: Partial<SupplyPathInput> = {}): SupplyPathInput {
  return {
    ownerDomain: 'channel-owner.example',
    hostDomain: 'hoststream.example',
    agentUrl: AGENT,
    collectionId: 'retro_news',
    ownerManifest: ownerManifest(),
    hostManifest: hostManifest(),
    hostInventoryPartnerDomains: null,
    ...overrides,
  };
}

describe('verifySupplyPath', () => {
  it('returns verified_owner_sold when both declarations match', () => {
    const verdict = verifySupplyPath(input());
    expect(verdict.state).toBe('verified_owner_sold');
    expect(verdict.legs.owner_collection_declared.ok).toBe(true);
    expect(verdict.legs.owner_distribution_carriage.ok).toBe(true);
    expect(verdict.legs.owner_distribution_carriage.property_ids_matched).toEqual(['hoststream_ctv']);
    expect(verdict.legs.host_authorization.ok).toBe(true);
    expect(verdict.legs.host_authorization.matched_entry?.url).toBe(AGENT);
  });

  it('accepts a bulk-grant host selector (no collection_ids)', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: AGENT,
          authorization_type: 'property_ids',
          property_ids: ['hoststream_ctv'],
          collections: [{ publisher_domain: 'channel-owner.example' }],
        }],
      }),
    }));
    expect(verdict.state).toBe('verified_owner_sold');
  });

  it('accepts an unconstrained host grant as covering the collection', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: AGENT,
          authorization_type: 'property_ids',
          property_ids: ['hoststream_ctv'],
        }],
      }),
    }));
    expect(verdict.state).toBe('verified_owner_sold');
  });

  it('diagnoses collection_scope_mismatch when the host names a different owner', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: AGENT,
          authorization_type: 'property_ids',
          property_ids: ['hoststream_ctv'],
          collections: [{ publisher_domain: 'different-owner.example', collection_ids: ['retro_news'] }],
        }],
      }),
    }));
    expect(verdict.state).toBe('owner_attested');
    expect(verdict.legs.host_authorization.failure).toBe('collection_scope_mismatch');
  });

  it('diagnoses property_scope_mismatch when the grant misses the carried property', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: AGENT,
          authorization_type: 'property_ids',
          property_ids: ['other_property'],
          collections: [{ publisher_domain: 'channel-owner.example', collection_ids: ['retro_news'] }],
        }],
      }),
    }));
    expect(verdict.legs.host_authorization.failure).toBe('property_scope_mismatch');
    expect(verdict.state).toBe('owner_attested');
  });

  it('upgrades to host_delegated on inventorypartnerdomain + owner-side declarations', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: hostManifest({ authorized_agents: [] }),
      hostInventoryPartnerDomains: ['channel-owner.example'],
    }));
    expect(verdict.legs.host_authorization.failure).toBe('no_agent_entry');
    expect(verdict.legs.inventory_partner_domain.ok).toBe(true);
    expect(verdict.state).toBe('host_delegated');
  });

  it('does not upgrade to host_delegated when the owner omits the agent', () => {
    const verdict = verifySupplyPath(input({
      ownerManifest: ownerManifest({ authorized_agents: [] }),
      hostManifest: hostManifest({ authorized_agents: [] }),
      hostInventoryPartnerDomains: ['channel-owner.example'],
    }));
    expect(verdict.legs.owner_agent_declared.failure).toBe('agent_not_declared_by_owner');
    expect(verdict.state).toBe('owner_attested');
  });

  it('falls to owner_attested when the host publishes nothing', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: null,
      hostInventoryPartnerDomains: [],
    }));
    expect(verdict.legs.host_authorization.failure).toBe('manifest_not_found');
    expect(verdict.legs.owner_distribution_carriage.failure).toBe('host_manifest_not_found');
    expect(verdict.state).toBe('owner_attested');
  });

  it('treats dangling distribution property_ids as unverified carriage but still owner_attested', () => {
    const verdict = verifySupplyPath(input({
      hostManifest: hostManifest({ properties: [] as never, authorized_agents: [] }),
      hostInventoryPartnerDomains: [],
    }));
    expect(verdict.legs.owner_distribution_carriage.failure).toBe('property_ids_unresolved');
    expect(verdict.legs.owner_distribution_carriage.property_ids_unmatched).toEqual(['hoststream_ctv']);
    expect(verdict.state).toBe('owner_attested');
  });

  it('returns unverified when the owner does not declare the collection', () => {
    const verdict = verifySupplyPath(input({ collectionId: 'not_a_channel' }));
    expect(verdict.legs.owner_collection_declared.failure).toBe('collection_not_declared');
    expect(verdict.state).toBe('unverified');
  });

  it('returns unverified when the owner has no manifest', () => {
    const verdict = verifySupplyPath(input({ ownerManifest: null }));
    expect(verdict.legs.owner_collection_declared.failure).toBe('manifest_not_found');
    expect(verdict.state).toBe('unverified');
  });

  it('verifies at domain level when collection_id is omitted (bulk deals)', () => {
    const verdict = verifySupplyPath(input({ collectionId: undefined }));
    expect(verdict.state).toBe('verified_owner_sold');
  });

  it('reports ads_txt_unavailable distinctly from not_declared', () => {
    const unavailable = verifySupplyPath(input({
      hostManifest: hostManifest({ authorized_agents: [] }),
      hostInventoryPartnerDomains: null,
    }));
    expect(unavailable.legs.inventory_partner_domain.failure).toBe('ads_txt_unavailable');

    const absent = verifySupplyPath(input({
      hostManifest: hostManifest({ authorized_agents: [] }),
      hostInventoryPartnerDomains: [],
    }));
    expect(absent.legs.inventory_partner_domain.failure).toBe('not_declared');
  });
});

describe('parseInventoryPartnerDomains', () => {
  it('parses declarations with comments, casing, and whitespace', () => {
    const lines = [
      'google.com, pub-1, DIRECT, f08c47fec0942fa0',
      'INVENTORYPARTNERDOMAIN = Channel-Owner.example  # scripps deal',
      'inventorypartnerdomain=other-owner.example',
      '# inventorypartnerdomain=commented-out.example',
      'inventorypartnerdomain=not a domain!!',
    ].join('\n');
    expect(parseInventoryPartnerDomains(lines).sort()).toEqual([
      'channel-owner.example',
      'other-owner.example',
    ]);
  });
});
