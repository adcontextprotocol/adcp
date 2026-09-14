import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/url-security.js', () => ({ safeFetchAxiosLike: safeFetch }));
import { fetchHostInventoryPartnerDomains } from '../../../src/services/supply-path-evidence.js';
const corpus = JSON.parse(readFileSync(new URL('../../../../static/compliance/source/test-vectors/supply-path/vectors.json', import.meta.url), 'utf8'));
const input = corpus.vectors[0].input;
describe('registry supply-path IAB fetching', () => {
  beforeEach(() => safeFetch.mockReset());
  it('fetches only applicable evidence with bounded bytes/time and no redirects', async () => {
    safeFetch.mockResolvedValue({ status: 200, data: Buffer.from('inventorypartnerdomain=channel-owner.example'), headers: { 'content-type': 'text/plain; charset=utf-8' } });
    expect(await fetchHostInventoryPartnerDomains(input)).toEqual({ 'app-ads.txt': ['channel-owner.example'] });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledWith('https://hoststream.example/app-ads.txt', expect.objectContaining({ maxRedirects: 0, maxResponseBytes: 256 * 1024, timeoutMs: 5000 }));
  });
  it('distinguishes missing from failed and refuses mislabeled evidence', async () => {
    safeFetch.mockResolvedValueOnce({ status: 404, headers: {}, data: Buffer.from('missing') });
    expect(await fetchHostInventoryPartnerDomains(input)).toEqual({ 'app-ads.txt': [] });
    safeFetch.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await fetchHostInventoryPartnerDomains(input)).toEqual({ 'app-ads.txt': null });
    safeFetch.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('inventorypartnerdomain=channel-owner.example') });
    expect(await fetchHostInventoryPartnerDomains(input)).toEqual({ 'app-ads.txt': null });
  });
});

it('includes identifier-only fallback files when another bulk candidate is a website', async () => {
  const fixture = corpus.ads_txt_policy_vectors.find((v: { id: string }) => v.id === 'bulk-fetch-includes-untyped-collection-fallback').input;
  safeFetch.mockReset();
  safeFetch.mockImplementation(async (url: string) => ({ status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from(url.endsWith('/app-ads.txt') ? 'inventorypartnerdomain=channel-owner.example' : '') }));
  expect(await fetchHostInventoryPartnerDomains(fixture)).toEqual({ 'ads.txt': [], 'app-ads.txt': ['channel-owner.example'] });
  expect(safeFetch).toHaveBeenCalledTimes(2);
});
