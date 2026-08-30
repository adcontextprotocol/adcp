/**
 * Regression tests for #7070: admin-refresh must not overwrite
 * authenticated compliance results with anonymous failures.
 *
 * The refresh endpoint at POST /api/registry/agents/{url}/refresh
 * now falls back to heartbeat-style owner auth resolution
 * (`complianceDb.resolveOwnerAuth`) when the caller is an admin
 * without their own org credentials. This prevents anonymous
 * comply() results from replacing valid credential-aware heartbeat
 * verdicts.
 *
 * These tests exercise the decision logic that determines which
 * auth is used for the compliance phase of a refresh. The building
 * blocks (resolveOwnerAuth, adaptAuthForSdk) have dedicated tests
 * in compliance-db-resolve-owner-auth.test.ts and
 * sdk-auth-adapter.test.ts respectively.
 */

import { describe, expect, it } from 'vitest';

/**
 * The auth fallback decision from registry-api.ts:7565-7576.
 * Extracted here for testability without the full route setup.
 *
 * The actual code in registry-api.ts:
 *
 *   let complianceAuth = resolvedAuth;
 *   if (!complianceAuth && canRunCompliance && !ownerOrgId) {
 *     const ownerAuth = await complianceDb.resolveOwnerAuth(agentUrl);
 *     if (ownerAuth) {
 *       complianceAuth = await adaptAuthForSdk(ownerAuth, ...);
 *     }
 *   }
 */
interface AuthDecisionInput {
  resolvedAuth: unknown | undefined;
  canRunCompliance: boolean;
  ownerOrgId: string | null;
  storedOwnerAuth: unknown | undefined;
}

function shouldFallbackToOwnerAuth(input: AuthDecisionInput): boolean {
  return !input.resolvedAuth && input.canRunCompliance && !input.ownerOrgId;
}

function resolveComplianceAuth(input: AuthDecisionInput): unknown | undefined {
  if (input.resolvedAuth) return input.resolvedAuth;
  if (shouldFallbackToOwnerAuth(input) && input.storedOwnerAuth) {
    return input.storedOwnerAuth;
  }
  return undefined;
}

describe('admin refresh compliance auth fallback (#7070)', () => {
  const ownerAuth = { type: 'bearer', token: 'owner-token' };
  const callerAuth = { type: 'bearer', token: 'caller-token' };

  it('owner refresh uses caller-resolved auth directly', () => {
    const auth = resolveComplianceAuth({
      resolvedAuth: callerAuth,
      canRunCompliance: true,
      ownerOrgId: 'org_owner',
      storedOwnerAuth: ownerAuth,
    });
    expect(auth).toBe(callerAuth);
  });

  it('admin refresh without credentials falls back to stored owner auth', () => {
    const auth = resolveComplianceAuth({
      resolvedAuth: undefined,
      canRunCompliance: true,
      ownerOrgId: null,
      storedOwnerAuth: ownerAuth,
    });
    expect(auth).toBe(ownerAuth);
  });

  it('admin refresh for public agent (no stored auth) runs anonymously', () => {
    const auth = resolveComplianceAuth({
      resolvedAuth: undefined,
      canRunCompliance: true,
      ownerOrgId: null,
      storedOwnerAuth: undefined,
    });
    expect(auth).toBeUndefined();
  });

  it('non-compliance-eligible caller does not trigger fallback', () => {
    const auth = resolveComplianceAuth({
      resolvedAuth: undefined,
      canRunCompliance: false,
      ownerOrgId: null,
      storedOwnerAuth: ownerAuth,
    });
    expect(auth).toBeUndefined();
  });

  it('auth_available flag reflects resolved auth state', () => {
    expect(!!resolveComplianceAuth({
      resolvedAuth: undefined,
      canRunCompliance: true,
      ownerOrgId: null,
      storedOwnerAuth: ownerAuth,
    })).toBe(true);

    expect(!!resolveComplianceAuth({
      resolvedAuth: undefined,
      canRunCompliance: true,
      ownerOrgId: null,
      storedOwnerAuth: undefined,
    })).toBe(false);

    expect(!!resolveComplianceAuth({
      resolvedAuth: callerAuth,
      canRunCompliance: true,
      ownerOrgId: 'org_owner',
      storedOwnerAuth: undefined,
    })).toBe(true);
  });
});
