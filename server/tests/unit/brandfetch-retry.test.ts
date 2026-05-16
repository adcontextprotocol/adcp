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
});
