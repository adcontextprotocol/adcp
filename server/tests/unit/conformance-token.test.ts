import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  issueConformanceToken,
  verifyConformanceToken,
} from '../../src/conformance/token.js';

const TEST_SECRET = 'test-conformance-secret-do-not-use-in-prod';

describe('conformance token', () => {
  beforeEach(() => {
    process.env.CONFORMANCE_JWT_SECRET = TEST_SECRET;
  });

  it('issues a verifiable token bound to the org', () => {
    const issued = issueConformanceToken('org_abc');
    expect(issued.token).toBeTruthy();
    expect(issued.ttlSeconds).toBe(3600);
    expect(issued.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const claims = verifyConformanceToken(issued.token);
    expect(claims.sub).toBe('org_abc');
    expect(claims.scope).toBe('conformance');
    expect(claims.exp).toBe(issued.expiresAt);
  });

  it('rejects tokens signed with a different secret', () => {
    const wrongSecretToken = jwt.sign(
      { scope: 'conformance' },
      'a-different-secret',
      { algorithm: 'HS256', subject: 'org_abc', expiresIn: '1h' },
    );
    expect(() => verifyConformanceToken(wrongSecretToken)).toThrow();
  });

  it('rejects tokens with the wrong scope', () => {
    const wrongScopeToken = jwt.sign(
      { scope: 'something-else' },
      TEST_SECRET,
      { algorithm: 'HS256', subject: 'org_abc', expiresIn: '1h' },
    );
    expect(() => verifyConformanceToken(wrongScopeToken)).toThrow(/scope/);
  });

  it('rejects expired tokens', () => {
    const expiredToken = jwt.sign(
      { scope: 'conformance' },
      TEST_SECRET,
      { algorithm: 'HS256', subject: 'org_abc', expiresIn: '-1s' },
    );
    expect(() => verifyConformanceToken(expiredToken)).toThrow();
  });

  it('rejects tokens missing sub', () => {
    const noSubToken = jwt.sign(
      { scope: 'conformance' },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    expect(() => verifyConformanceToken(noSubToken)).toThrow(/sub/);
  });

  it('refuses to issue a token without an orgId', () => {
    expect(() => issueConformanceToken('')).toThrow();
  });

  it('throws a clear error when the secret is not configured', () => {
    delete process.env.CONFORMANCE_JWT_SECRET;
    expect(() => issueConformanceToken('org_abc')).toThrow(/CONFORMANCE_JWT_SECRET/);
  });
});
