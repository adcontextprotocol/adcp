import { describe, expect, it } from 'vitest';
import { InMemoryStateStore } from '@adcp/sdk/server';
import { supplyPathSnapshotEvidence } from '../../../src/services/supply-path-snapshot.js';

const publisher = 'host.example';
const snapshot = () => ({ manifest: { authorized_agents: [] }, fetchedAt: new Date(), expiresAt: new Date(Date.now() + 86400000), resolvedUrl: 'https://host.example/.well-known/adagents.json', discoveryMethod: 'direct' });
describe('registry cache authority provenance', () => {
  it('accepts fresh publisher evidence and requires attribution on cross-origin pointers', async () => {
    const direct = snapshot();
    expect((await supplyPathSnapshotEvidence(publisher, direct, new InMemoryStateStore())).manifest).toEqual(direct.manifest);
    const delegated = await supplyPathSnapshotEvidence(publisher, { ...direct, discoveryMethod: 'authoritative_location', resolvedUrl: 'https://cdn.example/host.json' }, new InMemoryStateStore());
    expect(delegated.manifest).toEqual(direct.manifest);
    expect(delegated.explicitPublisher).toBe(true);
  });
  it.each([
    { resolvedUrl: null }, { resolvedUrl: 'https://cdn.example/' + 'x'.repeat(8192) },
    { fetchedAt: null }, { fetchedAt: new Date(0) }, { fetchedAt: new Date('2100-01-01') },
    { expiresAt: new Date(0) }, { discoveryMethod: 'manager_domain' }, { discoveryMethod: 'community' },
    { resolvedUrl: 'https://other.example/adagents.json' },
    { discoveryMethod: 'authoritative_location', resolvedUrl: 'http://cdn.example/adagents.json' },
    { discoveryMethod: 'authoritative_location', resolvedUrl: 'https://cdn.example/adagents.json#' },
  ])('refuses unauthoritative or stale evidence: %j', async patch => {
    const result = await supplyPathSnapshotEvidence(publisher, { ...snapshot(), ...patch }, new InMemoryStateStore());
    expect(result.manifest).toBeNull();
  });
  it('retains a previous denial when the next snapshot is stale', async () => {
    const store = new InMemoryStateStore();
    await supplyPathSnapshotEvidence(publisher, { ...snapshot(), manifest: { authorized_agents: [], revoked_publisher_domains: ['owner.example'] } }, store);
    const result = await supplyPathSnapshotEvidence(publisher, { ...snapshot(), fetchedAt: new Date(0) }, store);
    expect(result.manifest).toBeNull();
    expect(result.held).toEqual(['owner.example']);
  });
  it.each(['not a URL', 'https://[invalid', ''])('retains held denials when persisted provenance is malformed: %j', async resolvedUrl => {
    const store = new InMemoryStateStore();
    await supplyPathSnapshotEvidence(publisher, { ...snapshot(), manifest: { authorized_agents: [], revoked_publisher_domains: ['owner.example'] } }, store);
    const result = await supplyPathSnapshotEvidence(publisher, { ...snapshot(), discoveryMethod: 'authoritative_location', resolvedUrl }, store);
    expect(result.manifest).toBeNull();
    expect(result.held).toEqual(['owner.example']);
    // Invalid provenance must not replace the previously established authority pin.
    await expect(supplyPathSnapshotEvidence(publisher, {
      ...snapshot(), discoveryMethod: 'authoritative_location', resolvedUrl: 'https://other.example/host.json',
    }, store)).rejects.toThrow(/migration requires independent confirmation/);
    expect((await supplyPathSnapshotEvidence(publisher, snapshot(), store)).manifest).toEqual(snapshot().manifest);
  });
  it.each([
    {}, { authorized_agents: null },
    { authorized_agents: [], authoritative_location: 'https://other.example/chain.json' },
    { authorized_agents: [], authoritative_location: null },
    { authorized_agents: [], superseded_by: 'https://other.example/chain.json' },
  ])('retains denials without pinning an invalid cached manifest: %j', async invalid => {
    const store = new InMemoryStateStore();
    const result = await supplyPathSnapshotEvidence(publisher, {
      ...snapshot(), manifest: { ...invalid, revoked_publisher_domains: ['owner.example'] },
    }, store);
    expect(result.manifest).toBeNull();
    expect(result.held).toEqual(['owner.example']);
    const delegated = { ...snapshot(), discoveryMethod: 'authoritative_location', resolvedUrl: 'https://cdn.example/host.json' };
    expect((await supplyPathSnapshotEvidence(publisher, delegated, store)).manifest).toEqual(delegated.manifest);
    // The valid manifest establishes the baseline; later invalid observations
    // preserve that pin and cannot erase the held denial.
    expect((await supplyPathSnapshotEvidence(publisher, { ...snapshot(), manifest: invalid }, store)).held).toEqual(['owner.example']);
    await expect(supplyPathSnapshotEvidence(publisher, snapshot(), store)).rejects.toThrow(/migration requires independent confirmation/);
    expect((await supplyPathSnapshotEvidence(publisher, delegated, store)).manifest).toEqual(delegated.manifest);
  });
});
