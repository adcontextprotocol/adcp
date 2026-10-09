import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
  validateDomain: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery, connect: mocks.connect }),
}));
vi.mock('../../src/services/brand-domain-resolver.js', () => ({
  getBrandPrimaryDomain: vi.fn().mockResolvedValue('acme.example'),
}));
vi.mock('../../src/brand-manager.js', () => ({
  BrandManager: class { validateDomain = mocks.validateDomain; },
}));

import { BrandIdentityError, domainServesOwnBrandJson, updateBrandIdentity } from '../../src/services/brand-identity.js';

const input = { workosOrganizationId: 'org_1', displayName: 'Acme', brandColor: '#112233' };

describe('updateBrandIdentity on a domain that publishes brand.json', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset();
    mocks.connect.mockReset();
  });

  it('refuses the inline edit and points at the authoritative file', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ source_type: 'brand_json' }] });
    const err = await updateBrandIdentity({ ...input, domainSelfPublishesBrandJson: async () => true }).catch((e) => e);
    expect(err).toBeInstanceOf(BrandIdentityError);
    expect(err).toMatchObject({ statusCode: 409, code: 'domain_publishes_brand_json' });
    expect(err.meta).toEqual({
      brandDomain: 'acme.example',
      brandJsonUrl: 'https://acme.example/.well-known/brand.json',
      builderUrl: 'https://brandjson.org/builder?domain=acme.example',
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('allows the edit when the domain points at the hosted copy', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ source_type: 'brand_json' }] });
    mocks.connect.mockRejectedValue(new Error('stop after the guard'));
    await expect(updateBrandIdentity({ ...input, domainSelfPublishesBrandJson: async () => false })).rejects.toThrow('stop after the guard');
  });

  it('skips the live check for community rows', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ source_type: 'community' }] });
    mocks.connect.mockRejectedValue(new Error('stop after the guard'));
    const check = vi.fn();
    await expect(updateBrandIdentity({ ...input, domainSelfPublishesBrandJson: check })).rejects.toThrow('stop after the guard');
    expect(check).not.toHaveBeenCalled();
  });
});

describe('domainServesOwnBrandJson', () => {
  // Each test sets its own implementation. (A beforeEach mockReset() makes an
  // async-throwing implementation's rejection escape the caller's .catch in
  // this vitest version.)

  it('is true for a full document the domain hosts', async () => {
    mocks.validateDomain.mockResolvedValue({ status_code: 200, raw_data: { house: { domain: 'acme.example' } } });
    expect(await domainServesOwnBrandJson('acme.example')).toBe(true);
  });

  it('is false for a pointer to the AgenticAdvertising.org-hosted copy', async () => {
    mocks.validateDomain.mockResolvedValue({ status_code: 200, raw_data: { authoritative_location: 'https://agenticadvertising.org/brands/acme.example/brand.json' } });
    expect(await domainServesOwnBrandJson('acme.example')).toBe(false);
  });

  it('is true for a pointer to another host (e.g. an agency)', async () => {
    mocks.validateDomain.mockResolvedValue({ status_code: 200, raw_data: { authoritative_location: 'https://agency.example/brands/acme.json' } });
    expect(await domainServesOwnBrandJson('acme.example')).toBe(true);
  });

  it('is false when the file is missing', async () => {
    mocks.validateDomain.mockResolvedValue({ status_code: 404 });
    expect(await domainServesOwnBrandJson('acme.example')).toBe(false);
  });

  it('is false when the fetch fails', async () => {
    mocks.validateDomain.mockImplementation(async () => { throw new Error('timeout'); });
    expect(await domainServesOwnBrandJson('acme.example')).toBe(false);
  });
});
