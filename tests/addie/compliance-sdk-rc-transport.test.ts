import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('../../server/src/utils/url-security.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/src/utils/url-security.js')>(
    '../../server/src/utils/url-security.js',
  );
  mocks.safeFetch.mockImplementation(actual.safeFetch);
  return {
    ...actual,
    safeFetch: mocks.safeFetch,
  };
});

import {
  comply,
  defaultComplianceTarget,
} from '../../server/src/addie/services/compliance-testing.js';

describe('hosted compliance SDK transport', () => {
  it('runs hosted compliance requests through the SSRF-safe fetch boundary', async () => {
    const result = await comply(
      'http://127.0.0.1:1/mcp',
      { allow_http: true, timeout_ms: 1_000 },
      defaultComplianceTarget(),
    );

    expect(result.overall_status).toBe('unreachable');
    expect(mocks.safeFetch).toHaveBeenCalled();
    expect(mocks.safeFetch.mock.calls.some(([url]) => String(url).startsWith('http://127.0.0.1:1'))).toBe(true);
  });
});
