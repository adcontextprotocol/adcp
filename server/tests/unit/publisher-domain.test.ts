import { describe, it, expect } from 'vitest';
import { canonicalizePublisherDomain } from '../../src/services/publisher-domain.js';

describe('canonicalizePublisherDomain', () => {
  it('lowercases mixed-case input', () => {
    expect(canonicalizePublisherDomain('CNN.com')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('Site.Example')).toBe('site.example');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalizePublisherDomain('  cnn.com  ')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('\tcnn.com\n')).toBe('cnn.com');
  });

  it('strips trailing dot (DNS-canonical form)', () => {
    expect(canonicalizePublisherDomain('cnn.com.')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('Site.Example.')).toBe('site.example');
    // Multiple trailing dots collapsed.
    expect(canonicalizePublisherDomain('cnn.com..')).toBe('cnn.com');
  });

  it('strips trailing slashes', () => {
    expect(canonicalizePublisherDomain('cnn.com/')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('cnn.com//')).toBe('cnn.com');
  });

  it('strips http(s):// scheme prefix', () => {
    expect(canonicalizePublisherDomain('https://cnn.com')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('HTTP://CNN.com')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('https://cnn.com/')).toBe('cnn.com');
  });

  it('produces the same canonical form for equivalent representations', () => {
    // The whole point of this helper — writer, validator, and adagents-manager
    // MUST agree on whether two strings refer to the same publisher.
    const canonical = canonicalizePublisherDomain('cnn.com');
    expect(canonicalizePublisherDomain('CNN.com')).toBe(canonical);
    expect(canonicalizePublisherDomain('cnn.com.')).toBe(canonical);
    expect(canonicalizePublisherDomain('  cnn.com  ')).toBe(canonical);
    expect(canonicalizePublisherDomain('https://cnn.com/')).toBe(canonical);
    expect(canonicalizePublisherDomain('HTTPS://CNN.com.')).toBe(canonical);
  });

  it('passes through ASCII-only domains unchanged when already canonical', () => {
    expect(canonicalizePublisherDomain('cnn.com')).toBe('cnn.com');
    expect(canonicalizePublisherDomain('news.example.com')).toBe('news.example.com');
    expect(canonicalizePublisherDomain('a.b.c.d')).toBe('a.b.c.d');
  });

  it('does NOT do IDN/punycode conversion (schema pattern rejects non-ASCII today)', () => {
    // Documented non-behavior. If the schema later admits IDN, this
    // helper needs an IDN-to-ASCII pass to keep writer/runtime in
    // agreement on münchen.example vs xn--mnchen-3ya.example.
    const idn = 'münchen.example';
    // Just confirms the helper doesn't crash; whether it returns the
    // input or the lowercased input is implementation detail until IDN
    // is supported.
    expect(canonicalizePublisherDomain(idn)).toBe(idn);
  });
});
