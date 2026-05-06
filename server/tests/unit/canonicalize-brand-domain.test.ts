import { describe, it, expect } from 'vitest';
import { canonicalizeBrandDomain, assertValidBrandDomain, assertClaimableBrandDomain } from '../../src/services/identifier-normalization.js';

describe('canonicalizeBrandDomain', () => {
  it('strips https:// protocol', () => {
    expect(canonicalizeBrandDomain('https://example.com')).toBe('example.com');
  });

  it('strips www. prefix', () => {
    expect(canonicalizeBrandDomain('www.kyber1.com')).toBe('kyber1.com');
  });

  it('strips m. mobile prefix', () => {
    expect(canonicalizeBrandDomain('m.example.com')).toBe('example.com');
  });

  it('lowercases the result', () => {
    expect(canonicalizeBrandDomain('Example.COM')).toBe('example.com');
  });

  it('strips trailing slash and dot', () => {
    expect(canonicalizeBrandDomain('example.com/')).toBe('example.com');
    expect(canonicalizeBrandDomain('example.com.')).toBe('example.com');
  });

  it('strips path, query, and fragment', () => {
    expect(canonicalizeBrandDomain('example.com/about?foo=bar#baz')).toBe('example.com');
  });

  it('handles a fully composed messy URL', () => {
    expect(canonicalizeBrandDomain('HTTPS://www.Kyber1.COM/dashboard?ref=foo')).toBe('kyber1.com');
  });

  it('passes through clean apex unchanged', () => {
    expect(canonicalizeBrandDomain('kyber1.com')).toBe('kyber1.com');
  });

  it('preserves non-www subdomains', () => {
    expect(canonicalizeBrandDomain('app.kyber1.com')).toBe('app.kyber1.com');
  });
});

describe('assertValidBrandDomain', () => {
  it('accepts a typical apex domain', () => {
    expect(() => assertValidBrandDomain('kyber1.com')).not.toThrow();
  });

  it('accepts a multi-label subdomain', () => {
    expect(() => assertValidBrandDomain('app.kyber1.com')).not.toThrow();
  });

  it('rejects a single-label hostname', () => {
    expect(() => assertValidBrandDomain('localhost')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => assertValidBrandDomain('')).toThrow();
  });

  it('rejects whitespace and arbitrary text', () => {
    expect(() => assertValidBrandDomain('not a domain')).toThrow();
  });

  it('rejects a name longer than 253 chars', () => {
    const long = 'a'.repeat(250) + '.com';
    expect(() => assertValidBrandDomain(long)).toThrow();
  });
});

describe('assertClaimableBrandDomain', () => {
  it('accepts a legitimate brand domain', () => {
    expect(() => assertClaimableBrandDomain('kyber1.com')).not.toThrow();
  });

  it('rejects shared hosting platforms', () => {
    expect(() => assertClaimableBrandDomain('vercel.app')).toThrow();
    expect(() => assertClaimableBrandDomain('netlify.app')).toThrow();
    expect(() => assertClaimableBrandDomain('github.io')).toThrow();
  });

  it('rejects Google free-email domains', () => {
    expect(() => assertClaimableBrandDomain('gmail.com')).toThrow();
    expect(() => assertClaimableBrandDomain('googlemail.com')).toThrow();
  });

  it('rejects Microsoft free-email domains', () => {
    expect(() => assertClaimableBrandDomain('outlook.com')).toThrow();
    expect(() => assertClaimableBrandDomain('hotmail.com')).toThrow();
    expect(() => assertClaimableBrandDomain('live.com')).toThrow();
  });

  it('rejects Apple free-email domains', () => {
    expect(() => assertClaimableBrandDomain('icloud.com')).toThrow();
    expect(() => assertClaimableBrandDomain('me.com')).toThrow();
    expect(() => assertClaimableBrandDomain('mac.com')).toThrow();
  });

  it('rejects Proton free-email domains', () => {
    expect(() => assertClaimableBrandDomain('proton.me')).toThrow();
    expect(() => assertClaimableBrandDomain('protonmail.com')).toThrow();
    expect(() => assertClaimableBrandDomain('pm.me')).toThrow();
  });

  it('rejects other high-volume free-email providers', () => {
    expect(() => assertClaimableBrandDomain('yahoo.com')).toThrow();
    expect(() => assertClaimableBrandDomain('aol.com')).toThrow();
    expect(() => assertClaimableBrandDomain('tutanota.com')).toThrow();
    expect(() => assertClaimableBrandDomain('qq.com')).toThrow();
    expect(() => assertClaimableBrandDomain('163.com')).toThrow();
    expect(() => assertClaimableBrandDomain('tutanota.de')).toThrow();
  });

  it('rejects common eTLDs', () => {
    expect(() => assertClaimableBrandDomain('co.uk')).toThrow();
    expect(() => assertClaimableBrandDomain('com.au')).toThrow();
  });
});
