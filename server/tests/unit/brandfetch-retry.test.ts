import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const ORIGINAL_API_KEY = process.env.BRANDFETCH_API_KEY;

beforeEach(() => {
  process.env.BRANDFETCH_API_KEY = 'test-key';
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.BRANDFETCH_API_KEY;
  } else {
    process.env.BRANDFETCH_API_KEY = ORIGINAL_API_KEY;
  }
});

async function loadFresh() {
  const mod = await import('../../src/services/brandfetch.js');
  mod.clearCache();
  return mod;
}

function bufferOf(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

function successPayload(domain: string) {
  return bufferOf({ id: 'x', name: 'Acme', domain, claimed: true, verified: true });
}

function brandPayload(domain: string, overrides: Record<string, unknown> = {}) {
  return bufferOf({ id: 'x', name: 'Acme', domain, claimed: true, verified: true, ...overrides });
}

function contextPayload() {
  return bufferOf({
    meta: {
      domain: 'acme.com',
      canonical_name: 'Acme',
      resolved_at: '2026-05-25T08:48:36.843440+00:00',
    },
    identity: {
      tagline: 'Built for useful tests.',
      description: 'Acme is a fictional brand used for integration tests.',
      tags: ['B2B', 'Testing'],
    },
    positioning: {
      value_proposition: 'Reliable fictional products for test suites.',
      target_audience: [{ segment: 'Developers', description: 'Teams testing integrations.' }],
      products_and_services: [{ name: 'Fixtures', type: 'product', description: 'Reusable test assets.' }],
    },
    brand: {
      voice: {
        summary: 'Clear and pragmatic.',
        attributes: ['clear', 'direct'],
        avoid: ['hype'],
      },
      style: {
        summary: 'Simple, structured, and restrained.',
        attributes: ['minimal', 'legible'],
      },
    },
  });
}

describe('fetchBrandData retry behavior', () => {
  it('retries on 504 then succeeds', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 504, data: Buffer.from('Gateway timeout') })
      .mockResolvedValueOnce({ status: 200, data: successPayload('acme.com') });

    const promise = fetchBrandData('acme.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.manifest?.name).toBe('Acme');
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 and 503', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 502, data: Buffer.from('Bad gateway') })
      .mockResolvedValueOnce({ status: 503, data: Buffer.from('Service unavailable') })
      .mockResolvedValueOnce({ status: 200, data: successPayload('acme.com') });

    const promise = fetchBrandData('acme.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 (rate limit)', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 429, data: Buffer.from('Too many requests') })
      .mockResolvedValueOnce({ status: 200, data: successPayload('acme.com') });

    const promise = fetchBrandData('acme.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('retries on network timeout (ECONNABORTED)', async () => {
    const { fetchBrandData } = await loadFresh();

    const timeoutError = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    }) as AxiosError;
    mockedAxios.isAxiosError.mockImplementation((err: unknown): err is AxiosError =>
      typeof err === 'object' && err !== null && (err as { isAxiosError?: boolean }).isAxiosError === true
    );

    mockedAxios.get
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({ status: 200, data: successPayload('acme.com') });

    const promise = fetchBrandData('acme.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('summarizes Axios errors without logging request config or authorization headers', async () => {
    const { summarizeBrandfetchError } = await loadFresh();

    const axiosError = Object.assign(new Error('socket hang up'), {
      name: 'AxiosError',
      isAxiosError: true,
      code: 'ECONNRESET',
      response: { status: 503 },
      config: { headers: { Authorization: 'Bearer secret-brandfetch-key' } },
    }) as AxiosError & { isAxiosError: true };
    mockedAxios.isAxiosError.mockImplementation((err: unknown): err is AxiosError =>
      typeof err === 'object' && err !== null && (err as { isAxiosError?: boolean }).isAxiosError === true
    );

    const summary = summarizeBrandfetchError(axiosError);

    expect(summary).toEqual({
      name: 'AxiosError',
      message: 'socket hang up',
      code: 'ECONNRESET',
      status: 503,
    });
    expect(summary).not.toHaveProperty('config');
    expect(JSON.stringify(summary)).not.toContain('secret-brandfetch-key');
    expect(JSON.stringify(summary)).not.toContain('Authorization');
  });

  it('returns failure (no retry) on 404', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get.mockResolvedValueOnce({ status: 404, data: Buffer.from('Not found') });

    const result = await fetchBrandData('missing.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns failure (no retry) on non-retryable 4xx like 401', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get.mockResolvedValueOnce({ status: 401, data: Buffer.from('Unauthorized') });

    const result = await fetchBrandData('acme.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns failure after exhausting retries on persistent 504', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get.mockResolvedValue({ status: 504, data: Buffer.from('Gateway timeout') });

    const promise = fetchBrandData('366.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('504');
    // Initial attempt + 2 retries = 3 calls
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it('merges Brand Context API data when requested', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: successPayload('acme.com') })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const result = await fetchBrandData('https://acme.com/about', { includeContext: true });

    expect(result.success).toBe(true);
    expect(result.highQuality).toBe(false);
    expect(result.context?.identity?.description).toBe('Acme is a fictional brand used for integration tests.');
    expect(result.context?.brand?.voice?.summary).toBe('Clear and pragmatic.');
    expect((result.manifest as Record<string, unknown> | undefined)?.brand_context).toBeUndefined();
    expect(result.manifest?.tone).toBeUndefined();
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      1,
      'https://api.brandfetch.io/v2/brands/domain/acme.com',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) })
    );
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://api.brandfetch.io/v2/context/acme.com',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) })
    );
  });

  it('recovers a cached Brand API miss with Brand Context API data when context is later requested', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 404, data: Buffer.from('Not found') })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const firstResult = await fetchBrandData('acme.com');
    const secondResult = await fetchBrandData('acme.com', { includeContext: true });

    expect(firstResult.success).toBe(false);
    expect(firstResult.error).toContain('not found');
    expect(secondResult.success).toBe(true);
    expect(secondResult.manifest?.name).toBe('Acme');
    expect(secondResult.context?.identity?.tagline).toBe('Built for useful tests.');
    expect((secondResult.manifest as Record<string, unknown> | undefined)?.brand_context).toBeUndefined();
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://api.brandfetch.io/v2/context/acme.com',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) })
    );
  });

  it('keeps Brand API data successful when Brand Context API fails', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({
        status: 200,
        data: brandPayload('acme.com', { description: 'Primary Brand API description.' }),
      })
      .mockResolvedValueOnce({ status: 400, data: Buffer.from('Bad request') });

    const result = await fetchBrandData('acme.com', { includeContext: true });

    expect(result.success).toBe(true);
    expect(result.manifest?.description).toBe('Primary Brand API description.');
    expect(result.context).toBeUndefined();
    expect(result.contextError).toBe('Brandfetch context API error: 400');
  });

  it('retries transient Brand Context API failures', async () => {
    const { fetchBrandContext } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 429, data: Buffer.from('Too many requests') })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const promise = fetchBrandContext('acme.com');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.context?.brand?.voice?.summary).toBe('Clear and pragmatic.');
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('preserves Brand API description over Brand Context description', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({
        status: 200,
        data: brandPayload('acme.com', { description: 'Primary Brand API description.' }),
      })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const result = await fetchBrandData('acme.com', { includeContext: true });

    expect(result.manifest?.description).toBe('Primary Brand API description.');
    expect(result.context?.identity?.description).toBe('Acme is a fictional brand used for integration tests.');
    expect((result.manifest as Record<string, unknown> | undefined)?.brand_context).toBeUndefined();
  });

  it('keeps low-score and NSFW Brand API results low quality even with narrative context', async () => {
    const { fetchBrandData, clearCache } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({
        status: 200,
        data: brandPayload('low-score.com', {
          domain: 'low-score.com',
          description: 'A low-score brand with text.',
          qualityScore: 0.1,
        }),
      })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const lowScore = await fetchBrandData('low-score.com', { includeContext: true });
    expect(lowScore.success).toBe(true);
    expect(lowScore.highQuality).toBe(false);

    clearCache();
    mockedAxios.get
      .mockResolvedValueOnce({
        status: 200,
        data: brandPayload('nsfw.com', {
          domain: 'nsfw.com',
          description: 'A flagged brand with text.',
          isNsfw: true,
        }),
      })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const nsfw = await fetchBrandData('nsfw.com', { includeContext: true });
    expect(nsfw.success).toBe(true);
    expect(nsfw.highQuality).toBe(false);
  });

  it('does not promote weak Brand API results using Brand Context API narrative data', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({
        status: 200,
        data: brandPayload('weak.com', { domain: 'weak.com' }),
      })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const result = await fetchBrandData('weak.com', { includeContext: true });

    expect(result.success).toBe(true);
    expect(result.highQuality).toBe(false);
    expect(result.context?.identity?.description).toBe('Acme is a fictional brand used for integration tests.');
  });

  it('uses Brand Context API as a fallback when the Brand API has no asset record', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 404, data: Buffer.from('Not found') })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() });

    const result = await fetchBrandData('acme.com', { includeContext: true });

    expect(result.success).toBe(true);
    expect(result.manifest?.name).toBe('Acme');
    expect(result.manifest?.description).toBeUndefined();
    expect(result.context?.positioning?.value_proposition).toBe('Reliable fictional products for test suites.');
    expect((result.manifest as Record<string, unknown> | undefined)?.brand_context).toBeUndefined();
  });

  it('does not serve context-only fallback results from the Brand API cache to no-context callers', async () => {
    const { fetchBrandData } = await loadFresh();

    mockedAxios.get
      .mockResolvedValueOnce({ status: 404, data: Buffer.from('Not found') })
      .mockResolvedValueOnce({ status: 200, data: contextPayload() })
      .mockResolvedValueOnce({ status: 404, data: Buffer.from('Not found') });

    const contextOnly = await fetchBrandData('acme.com', { includeContext: true });
    const noContext = await fetchBrandData('acme.com');

    expect(contextOnly.success).toBe(true);
    expect(contextOnly.raw).toBeUndefined();
    expect(noContext.success).toBe(false);
    expect(noContext.error).toContain('not found');
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });
});
