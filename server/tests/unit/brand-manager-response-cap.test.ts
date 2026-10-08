import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const agentMock = vi.hoisted(() => vi.fn(function FakeAgent(this: { opts: unknown }, opts: unknown) {
  this.opts = opts;
}));
const resolve4Mock = vi.hoisted(() => vi.fn(async () => ['93.184.216.34']));
const resolve6Mock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: agentMock,
    fetch: fetchMock,
  };
});

vi.mock('dns/promises', () => ({
  default: {
    resolve4: resolve4Mock,
    resolve6: resolve6Mock,
  },
  resolve4: resolve4Mock,
  resolve6: resolve6Mock,
}));

import { BrandManager } from '../../src/brand-manager.js';
import { BRAND_JSON_MAX_RESPONSE_BYTES } from '../../src/services/brand-resolution-cache-policy.js';

const MIB = 1024 * 1024;

/** A valid House Portfolio brand.json padded with a long tagline to `bytes`. */
function brandJsonOfSize(bytes: number): Buffer {
  const doc = {
    $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
    version: '1.0',
    house: { domain: 'acme.com', name: 'Acme Corp' },
    brands: [{ id: 'acme', names: [{ en: 'Acme' }], keller_type: 'master', tagline: '' }],
  };
  const overhead = Buffer.byteLength(JSON.stringify(doc));
  doc.brands[0].tagline = 'x'.repeat(bytes - overhead);
  return Buffer.from(JSON.stringify(doc));
}

describe('brand.json live-read response cap', () => {
  let manager: BrandManager;

  beforeEach(() => {
    fetchMock.mockReset();
    resolve4Mock.mockResolvedValue(['93.184.216.34']);
    resolve6Mock.mockResolvedValue([]);
    manager = new BrandManager({ observeRelationshipDeclaration: async () => Date.now() });
  });

  it('caps live reads at 2 MiB', () => {
    expect(BRAND_JSON_MAX_RESPONSE_BYTES).toBe(2 * MIB);
  });

  it('accepts a 1 MiB body', async () => {
    const body = brandJsonOfSize(1 * MIB);
    expect(body.byteLength).toBe(1 * MIB);
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const result = await manager.validateDomain('acme.com', { skipCache: true });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a 3 MiB body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(brandJsonOfSize(3 * MIB), { status: 200 }));

    const result = await manager.validateDomain('acme.com', { skipCache: true });

    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/exceeded/i);
  });
});
