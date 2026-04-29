/**
 * Unit tests for the signed dev-session cookie.
 *
 * Pre-signing the cookie was the literal user key string ("admin"); anyone
 * who could write a cookie on the domain (XSS, sibling subdomain) could
 * pick a privileged dev user. These tests lock in the integrity check.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub the WorkOS module before auth.ts loads. auth.ts has a top-level
// `new WorkOS(process.env.WORKOS_API_KEY!)` that throws if the env var is
// unset — which it is in CI for repo-level `vitest run server/tests/unit/`
// (the repo-root config has no setupFile, only the server-level config
// does). We don't need a real WorkOS for the cookie-signing tests; the
// stub just lets the auth.ts module load.
vi.mock('@workos-inc/node', () => ({
  WorkOS: class { userManagement = {}; organizations = {}; },
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
