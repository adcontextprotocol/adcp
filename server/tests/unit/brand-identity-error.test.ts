import { describe, it, expect } from 'vitest';
import { BrandIdentityError } from '../../src/services/brand-identity.js';

describe('BrandIdentityError', () => {
  it('defaults to invalid_input code with empty meta', () => {
    const err = new BrandIdentityError(400, 'bad input');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('invalid_input');
    expect(err.meta).toEqual({});
    expect(err.message).toBe('bad input');
    expect(err.name).toBe('BrandIdentityError');
    expect(err).toBeInstanceOf(Error);
  });

  it('carries the cross_org_ownership code with brandDomain + currentOwnerOrgId meta', () => {
    const err = new BrandIdentityError(
      403,
      'This brand domain is managed by another organization.',
      'cross_org_ownership',
      { brandDomain: 'kyber1.com', currentOwnerOrgId: 'org_01OLDOWNER' },
    );
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('cross_org_ownership');
    expect(err.meta.brandDomain).toBe('kyber1.com');
    expect(err.meta.currentOwnerOrgId).toBe('org_01OLDOWNER');
  });

  it('discriminates the no_brand_domain code', () => {
    const err = new BrandIdentityError(400, 'No brand domain set.', 'no_brand_domain');
    expect(err.code).toBe('no_brand_domain');
  });

  it('discriminates the invalid_domain code', () => {
    const err = new BrandIdentityError(400, '"localhost" is not a valid brand domain.', 'invalid_domain');
    expect(err.code).toBe('invalid_domain');
  });
});
