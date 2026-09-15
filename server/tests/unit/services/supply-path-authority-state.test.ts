import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStateStore } from '@adcp/sdk/server';
import { observeSupplyPathAuthority, approveSupplyPathAuthorityChange } from '../../../src/services/supply-path-authority-state.js';

const host = 'host.example';
const pointer = 'https://cdn.example/host.json';
const revoked = (publisher = 'owner.example', timestamp = '2026-09-01T00:00:00Z') => ({ revoked_publisher_domains: [{ publisher_domain: publisher, revoked_at: timestamp }] });
afterEach(() => vi.useRealTimers());
describe('persistent supply-path authority state', () => {
  it('preserves concurrent revocations across missing and refreshed manifests', async () => {
    const store = new InMemoryStateStore();
    await Promise.all([
      observeSupplyPathAuthority(host, revoked(), pointer, store),
      observeSupplyPathAuthority(host, revoked('second.example'), pointer, store),
    ]);
    expect((await observeSupplyPathAuthority(host, null, undefined, store)).revoked.sort()).toEqual(['owner.example', 'second.example']);
    expect((await observeSupplyPathAuthority('unrelated.example', null, undefined, store)).revoked).toEqual([]);
  });
  it('holds for seven days from first observation regardless of changed publisher timestamps', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const store = new InMemoryStateStore();
    await observeSupplyPathAuthority(host, revoked(), pointer, store);
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
    await observeSupplyPathAuthority(host, revoked('owner.example', '2026-09-07T00:00:00Z'), pointer, store);
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    expect((await observeSupplyPathAuthority(host, null, undefined, store)).revoked).toEqual([]);
  });
  it('rejects changed pointers and preserves holds after independently confirmed migrations', async () => {
    const store = new InMemoryStateStore();
    await observeSupplyPathAuthority(host, revoked(), pointer, store);
    await expect(observeSupplyPathAuthority(host, {}, 'https://new.example/host.json', store)).rejects.toThrow(/independent confirmation/);
    await approveSupplyPathAuthorityChange(host, 'https://new.example/host.json', store);
    expect((await observeSupplyPathAuthority(host, {}, 'https://new.example/host.json', store)).revoked).toEqual(['owner.example']);
  });
  it('rejects malformed revocations and insecure authoritative locations', async () => {
    const store = new InMemoryStateStore();
    await expect(observeSupplyPathAuthority(host, { revoked_publisher_domains: ['owner.example', {}] }, pointer, store)).rejects.toThrow(/revocation evidence/);
    await expect(observeSupplyPathAuthority(host, {}, 'http://cdn.example/host.json', store)).rejects.toThrow(/authority/);
    await expect(observeSupplyPathAuthority(host, {}, `${pointer}#`, store)).rejects.toThrow(/authority/);
    await observeSupplyPathAuthority(host, revoked(), pointer, store);
    await expect(approveSupplyPathAuthorityChange(host, `${pointer}#`, store)).rejects.toThrow(/authority/);
    expect((await observeSupplyPathAuthority(host, {}, pointer, store)).revoked).toEqual(['owner.example']);
  });
});

it('does not contend on unchanged observations after a concurrent first pin', async () => {
  const store = new InMemoryStateStore();
  const write = vi.spyOn(store, 'putIfMatch');
  const results = await Promise.all(Array.from({ length: 40 }, () => observeSupplyPathAuthority(host, revoked(), pointer, store)));
  for (const result of results) expect(result.revoked).toEqual(['owner.example']);
  write.mockClear();
  await Promise.all(Array.from({ length: 40 }, () => observeSupplyPathAuthority(host, {}, pointer, store)));
  expect(write).not.toHaveBeenCalled();
});
