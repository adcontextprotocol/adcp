/**
 * Unit tests for the signed dev-session cookie.
 *
 * Pre-signing the cookie was the literal user key string ("admin"); anyone
 * who could write a cookie on the domain (XSS, sibling subdomain) could
 * pick a privileged dev user. These tests lock in the integrity check.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
}));

import { encodeDevSessionCookie, getDevUser } from '../../src/middleware/auth.js';

describe('dev-session cookie signing', () => {
  it('round-trips a valid signed cookie back to the user record', () => {
    const cookie = encodeDevSessionCookie('admin');
    const req = { cookies: { 'dev-session': cookie } } as any;

    const user = getDevUser(req);
    expect(user?.id).toBe('user_dev_admin_001');
  });

  it('rejects a cookie that contains only the user key (legacy unsigned format)', () => {
    // Pre-signing format: literal "admin" string. Must not authenticate
    // anymore — that's the security regression this signing fixes.
    const req = { cookies: { 'dev-session': 'admin' } } as any;
    expect(getDevUser(req)).toBeNull();
  });

  it('rejects a cookie with the wrong signature', () => {
    const valid = encodeDevSessionCookie('admin');
    const tampered = valid.slice(0, -2) + 'XX';
    const req = { cookies: { 'dev-session': tampered } } as any;
    expect(getDevUser(req)).toBeNull();
  });

  it('rejects a cookie with a different user_key but the original signature', () => {
    // attacker tries: "admin" + "."+ sig("member")
    const memberCookie = encodeDevSessionCookie('member');
    const memberSig = memberCookie.split('.').pop();
    const forged = `admin.${memberSig}`;
    const req = { cookies: { 'dev-session': forged } } as any;
    expect(getDevUser(req)).toBeNull();
  });

  it('rejects an unknown user key even when the signature is valid', () => {
    const cookie = encodeDevSessionCookie('not-a-real-user');
    const req = { cookies: { 'dev-session': cookie } } as any;
    expect(getDevUser(req)).toBeNull();
  });

  it('rejects an empty/missing cookie', () => {
    expect(getDevUser({ cookies: {} } as any)).toBeNull();
    expect(getDevUser({ cookies: { 'dev-session': '' } } as any)).toBeNull();
    expect(getDevUser({} as any)).toBeNull();
    expect(getDevUser(undefined)).toBeNull();
  });
});
