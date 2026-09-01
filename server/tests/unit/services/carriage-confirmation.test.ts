import { describe, it, expect } from 'vitest';
import { hostConfirmsCarriage } from '../../../src/services/carriage-confirmation.js';
import type { AdagentsManifest } from '../../../src/db/publisher-db.js';

function hostManifest(overrides: Partial<AdagentsManifest> = {}): AdagentsManifest {
  return {
    properties: [
      { property_id: 'hoststream_ctv', name: 'HostStream CTV', tags: ['fast'] },
      { property_id: 'hoststream_web', name: 'HostStream Web' },
    ] as never,
    authorized_agents: [{
      url: 'https://sales.channel-owner.example',
      authorization_type: 'property_ids',
      property_ids: ['hoststream_ctv'],
      collections: [{ publisher_domain: 'channel-owner.example', collection_ids: ['retro_news'] }],
    }],
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof hostConfirmsCarriage>[0]> = {}) {
  return {
    ownerDomain: 'channel-owner.example',
    collectionId: 'retro_news',
    hostDomain: 'hoststream.example',
    claimedPropertyIds: ['hoststream_ctv'],
    hostManifest: hostManifest(),
    ...overrides,
  };
}

describe('hostConfirmsCarriage', () => {
  it('confirms when a host entry names the owner collection and reaches the claimed property', () => {
    expect(hostConfirmsCarriage(input())).toBe(true);
  });

  it('confirms via a bulk-grant selector (no collection_ids)', () => {
    expect(hostConfirmsCarriage(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: 'https://sales.channel-owner.example',
          authorization_type: 'property_ids',
          property_ids: ['hoststream_ctv'],
          collections: [{ publisher_domain: 'channel-owner.example' }],
        }],
      }),
    }))).toBe(true);
  });

  it('does NOT confirm from an unconstrained grant — confirmation requires naming the owner', () => {
    expect(hostConfirmsCarriage(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: 'https://sales.anyone.example',
          authorization_type: 'property_ids',
          property_ids: ['hoststream_ctv'],
        }],
      }),
    }))).toBe(false);
  });

  it('rejects a selector naming a different owner domain', () => {
    expect(hostConfirmsCarriage(input({ ownerDomain: 'different-owner.example' }))).toBe(false);
  });

  it('rejects when the entry property scope misses every claimed property', () => {
    expect(hostConfirmsCarriage(input({ claimedPropertyIds: ['hoststream_web'] }))).toBe(false);
  });

  it('confirms a publisher-wide entry (no authorization_type) regardless of claimed properties', () => {
    expect(hostConfirmsCarriage(input({
      claimedPropertyIds: ['hoststream_web'],
      hostManifest: hostManifest({
        authorized_agents: [{
          url: 'https://sales.channel-owner.example',
          collections: [{ publisher_domain: 'channel-owner.example', collection_ids: ['retro_news'] }],
        }],
      }),
    }))).toBe(true);
  });

  it('confirms identifier-only carriage (no claimed property_ids) on naming alone', () => {
    expect(hostConfirmsCarriage(input({ claimedPropertyIds: [] }))).toBe(true);
  });

  it('fails closed on a missing host manifest', () => {
    expect(hostConfirmsCarriage(input({ hostManifest: null }))).toBe(false);
  });

  it('resolves property_tags scope through the host property catalog', () => {
    expect(hostConfirmsCarriage(input({
      hostManifest: hostManifest({
        authorized_agents: [{
          url: 'https://sales.channel-owner.example',
          authorization_type: 'property_tags',
          property_tags: ['fast'],
          collections: [{ publisher_domain: 'channel-owner.example', collection_ids: ['retro_news'] }],
        }],
      }),
    }))).toBe(true);
  });
});
