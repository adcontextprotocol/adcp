import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/url-security.js', () => ({ safeFetch }));

import { isManifestReferenceReachable } from '../../src/services/manifest-reference-verifier.js';

beforeEach(() => vi.clearAllMocks());

describe('isManifestReferenceReachable', () => {
  it('uses the SSRF-safe transport with bounded redirect following', async () => {
    safeFetch.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(isManifestReferenceReachable({
      reference_type: 'url',
      manifest_url: 'https://publisher.example/.well-known/brand.json',
    })).resolves.toBe(true);

    expect(safeFetch).toHaveBeenCalledWith(
      'https://publisher.example/.well-known/brand.json',
      {
        method: 'HEAD',
        maxRedirects: 3,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('does not perform a request when the reference has no matching URL', async () => {
    await expect(isManifestReferenceReachable({ reference_type: 'url' })).resolves.toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('accepts 405 only for agent endpoints', async () => {
    safeFetch.mockResolvedValue(new Response(null, { status: 405 }));

    await expect(isManifestReferenceReachable({
      reference_type: 'agent',
      agent_url: 'https://agent.example/mcp',
    })).resolves.toBe(true);
    await expect(isManifestReferenceReachable({
      reference_type: 'url',
      manifest_url: 'https://publisher.example/.well-known/brand.json',
    })).resolves.toBe(false);
  });

  it('treats SSRF rejection and network failures as unreachable', async () => {
    safeFetch.mockRejectedValue(new Error('URLs pointing to private networks are not allowed'));

    await expect(isManifestReferenceReachable({
      reference_type: 'url',
      manifest_url: 'http://127.0.0.1/admin',
    })).resolves.toBe(false);
  });
});
