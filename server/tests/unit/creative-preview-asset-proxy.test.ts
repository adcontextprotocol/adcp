import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock('../../src/utils/url-security.js', () => ({ safeFetch: mocks.safeFetch }));

import { createCreativeAgentRouter, previewQuotaKey } from '../../src/creative-agent/index.js';
import {
  getOrCreatePreviewAssetDownload,
  storePreviewAsset,
} from '../../src/creative-agent/preview-store.js';

function app() {
  const instance = express();
  instance.use('/api/creative-agent', createCreativeAgentRouter());
  return instance;
}

describe('creative preview asset proxy', () => {
  beforeEach(() => mocks.safeFetch.mockReset());

  it('shares one quota key across IPv6 addresses in the same /56', () => {
    const requestA = { ip: '2001:db8:abcd:1200::1', headers: {} };
    const requestB = { ip: '2001:db8:abcd:12ff::2', headers: {} };
    const requestOtherNetwork = { ip: '2001:db8:abcd:1300::1', headers: {} };

    expect(previewQuotaKey(requestA as Request)).toBe(previewQuotaKey(requestB as Request));
    expect(previewQuotaKey(requestA as Request)).not.toBe(previewQuotaKey(requestOtherNetwork as Request));
  });

  it('serves an allowlisted raster asset with an inert response policy', async () => {
    const token = randomUUID();
    expect(storePreviewAsset(token, 'https://cdn.example/ad.png', randomUUID())).not.toBeNull();
    mocks.safeFetch.mockResolvedValue(new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
    }));

    const response = await request(app()).get(`/api/creative-agent/preview-assets/${token}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("script-src 'none'");
  });

  it('rejects SVG instead of serving active same-origin content', async () => {
    const token = randomUUID();
    expect(storePreviewAsset(token, 'https://cdn.example/active.svg', randomUUID())).not.toBeNull();
    mocks.safeFetch.mockResolvedValue(new Response('<svg><script>alert(1)</script></svg>', {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' },
    }));

    const response = await request(app()).get(`/api/creative-agent/preview-assets/${token}`);

    expect(response.status).toBe(415);
    expect(response.headers['content-security-policy']).toContain("script-src 'none'");
  });

  it('deduplicates concurrent downloads for the same token', async () => {
    const token = randomUUID();
    expect(storePreviewAsset(token, 'https://cdn.example/ad.webp', randomUUID())).not.toBeNull();
    mocks.safeFetch.mockResolvedValue(new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/webp', 'Content-Length': '3' },
    }));
    const instance = app();

    const [first, second] = await Promise.all([
      request(instance).get(`/api/creative-agent/preview-assets/${token}`),
      request(instance).get(`/api/creative-agent/preview-assets/${token}`),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('enforces a strict per-preview token quota without evicting existing tokens', () => {
    const scope = randomUUID();
    const stored = Array.from({ length: 9 }, () =>
      storePreviewAsset(randomUUID(), 'https://cdn.example/ad.png', scope)
    );

    expect(stored.slice(0, 8).every(Boolean)).toBe(true);
    expect(stored[8]).toBeNull();
  });

  it('prevents one principal from consuming another principal\'s token quota', () => {
    const principalA = randomUUID();
    const principalB = randomUUID();
    const aTokens = Array.from({ length: 65 }, (_, index) =>
      storePreviewAsset(
        randomUUID(),
        'https://cdn.example/ad.png',
        `${principalA}-scope-${Math.floor(index / 8)}`,
        principalA,
      )
    );

    expect(aTokens.slice(0, 64).every(Boolean)).toBe(true);
    expect(aTokens[64]).toBeNull();
    expect(storePreviewAsset(
      randomUUID(),
      'https://cdn.example/ad.png',
      `${principalB}-scope`,
      principalB,
    )).not.toBeNull();
  });

  it('isolates in-flight cache reservations by principal and reports saturation as 503', async () => {
    const maxBytes = 10 * 1024 * 1024;
    const principalA = randomUUID();
    const principalB = randomUUID();
    const neverCompletes = () => new Promise<never>(() => {});
    const aTokens = Array.from({ length: 7 }, (_, index) => {
      const token = randomUUID();
      expect(storePreviewAsset(token, 'https://cdn.example/ad.png', `${principalA}-${index}`, principalA)).not.toBeNull();
      return token;
    });

    for (const token of aTokens.slice(0, 6)) {
      expect(getOrCreatePreviewAssetDownload(token, maxBytes, neverCompletes)).not.toBeNull();
    }
    const saturated = await request(app()).get(`/api/creative-agent/preview-assets/${aTokens[6]}`);
    expect(saturated.status).toBe(503);
    expect(saturated.text).toContain('temporarily unavailable');
    expect(mocks.safeFetch).not.toHaveBeenCalled();

    const bToken = randomUUID();
    expect(storePreviewAsset(bToken, 'https://cdn.example/ad.png', principalB, principalB)).not.toBeNull();
    expect(getOrCreatePreviewAssetDownload(bToken, maxBytes, neverCompletes)).not.toBeNull();
  });
});
