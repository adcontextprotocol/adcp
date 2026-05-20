import { describe, it, expect } from 'vitest';
import { normalizeBasicAuthForStorage, buildAuthOption } from '../../../src/addie/mcp/member-tools.js';

describe('normalizeBasicAuthForStorage', () => {
  it('encodes raw "user:password" to base64 for storage', () => {
    const result = normalizeBasicAuthForStorage('user:pass');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stored).toBe(Buffer.from('user:pass', 'utf8').toString('base64'));
  });

  it('accepts already-base64-encoded user:password and stores it as-is', () => {
    const encoded = Buffer.from('testuser:fixture-only', 'utf8').toString('base64');
    const result = normalizeBasicAuthForStorage(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stored).toBe(encoded);
  });

  it('preserves colons in the password when normalizing raw input', () => {
    // HTTP Basic splits on the first colon; passwords may contain further colons.
    const result = normalizeBasicAuthForStorage('user:pass:with:colons');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decoded = Buffer.from(result.stored, 'base64').toString('utf8');
      expect(decoded).toBe('user:pass:with:colons');
    }
  });

  it('rejects a value that is neither raw user:password nor base64 of one', () => {
    // No colon in the input and the base64 decoding produces no colon either.
    expect(normalizeBasicAuthForStorage('nopairhere').ok).toBe(false);
  });
});

describe('buildAuthOption (basic auth)', () => {
  it('decodes a properly base64-encoded basic credential', () => {
    const stored = Buffer.from('testuser:fixture-only', 'utf8').toString('base64');
    const option = buildAuthOption({
      authToken: stored,
      authType: 'basic',
      source: 'saved',
      resolvedUrl: 'https://example.com',
    });
    expect(option).toEqual({ type: 'basic', username: 'testuser', password: 'fixture-only' });
  });

  // NB: fixtures here use non-credential-looking values
  // (`testuser:fixture-only`, `user:pass`) so secret scanners recognize them
  // as test data rather than leaked credentials.
  it('returns undefined for a malformed basic credential (does not silently re-classify as bearer)', () => {
    // Raw "user:pass" mistakenly stored without base64 encoding (the pre-fix
    // failure mode). Old behavior: silently fell through to {type:'bearer'},
    // sending "Authorization: Bearer user:pass" on the wire and producing a
    // misleading "agent didn't declare capabilities" diagnostic. New behavior:
    // return undefined so the request goes out unauthenticated and the
    // auth-failure branch in recommend_storyboards diagnoses correctly.
    const option = buildAuthOption({
      authToken: 'user:pass',
      authType: 'basic',
      source: 'saved',
      resolvedUrl: 'https://example.com',
    });
    expect(option).toBeUndefined();
  });

  it('splits on the first colon so passwords may contain colons', () => {
    const stored = Buffer.from('user:pass:with:colons', 'utf8').toString('base64');
    const option = buildAuthOption({
      authToken: stored,
      authType: 'basic',
      source: 'saved',
      resolvedUrl: 'https://example.com',
    });
    expect(option).toEqual({ type: 'basic', username: 'user', password: 'pass:with:colons' });
  });

  it('returns bearer envelope for bearer-typed tokens', () => {
    const option = buildAuthOption({
      authToken: 'abc.def.ghi',
      authType: 'bearer',
      source: 'saved',
      resolvedUrl: 'https://example.com',
    });
    expect(option).toEqual({ type: 'bearer', token: 'abc.def.ghi' });
  });
});
