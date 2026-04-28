import { describe, it, expect } from 'vitest';
import { canonicalizeBrandDomain, assertValidBrandDomain } from '../../src/services/identifier-normalization.js';

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
