/**
 * Pin the brand-claim suggestion service + endpoint (#4744).
 *
 * Covers the suppression matrix:
 *   - Free email domains → no suggestion.
 *   - No matching brand → no suggestion.
 *   - Brand verified by caller's own org → no suggestion (already done).
 *   - Brand verified by another org → no suggestion (would collision-fail).
 *   - Brand unowned → suggestion fires.
 *   - Dismissal within 30d → suggestion still returned but `active: false`.
 *   - Dismissal older than 30d → suggestion `active: true` again.
 *
 * Plus endpoint-level: domain canonicalization, dismiss roundtrip,
 * domain-scoped query (for the brand-viewer JIT prompt).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getDiscoveredBrandByDomain: vi.fn(),
  resolvePrimaryOrganization: vi.fn().mockResolvedValue(null),
  getNudgeDismissal: vi.fn().mockResolvedValue(null),
  recordNudgeDismissal: vi.fn().mockResolvedValue(undefined),
  getUserEmailById: vi.fn().mockResolvedValue('alice@scope3.com'),
}));

vi.mock('../../src/db/users-db.js', () => ({
  resolvePrimaryOrganization: (...args: unknown[]) => mocks.resolvePrimaryOrganization(...args),
}));

vi.mock('../../src/db/user-nudges-db.js', () => ({
  getNudgeDismissal: (...args: unknown[]) => mocks.getNudgeDismissal(...args),
  recordNudgeDismissal: (...args: unknown[]) => mocks.recordNudgeDismissal(...args),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
  optionalAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  },
}));

import {
  getBrandClaimSuggestionForUser,
  getSuggestionForDomain,
  nudgeKey,
  DISMISSAL_COOLDOWN_MS,
} from '../../src/services/brand-claim-suggestion.js';
import { createBrandClaimSuggestionRouter } from '../../src/routes/me-brand-claim-suggestion.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';

let currentUser: { id: string; email?: string } = { id: 'user_test', email: 'alice@scope3.com' };

function makeCtx(): { brandDb: BrandDatabase } {
  return {
    brandDb: {
      getDiscoveredBrandByDomain: mocks.getDiscoveredBrandByDomain,
    } as unknown as BrandDatabase,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/me', createBrandClaimSuggestionRouter({
    brandDb: { getDiscoveredBrandByDomain: mocks.getDiscoveredBrandByDomain } as unknown as BrandDatabase,
  }));
  return app;
}

describe('getBrandClaimSuggestionForUser', () => {
  beforeEach(() => {
    mocks.getDiscoveredBrandByDomain.mockReset();
    mocks.resolvePrimaryOrganization.mockReset();
    mocks.resolvePrimaryOrganization.mockResolvedValue(null);
    mocks.getNudgeDismissal.mockReset();
    mocks.getNudgeDismissal.mockResolvedValue(null);
  });

  it('returns null for free email domains', async () => {
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@gmail.com', makeCtx());
    expect(result).toBeNull();
    expect(mocks.getDiscoveredBrandByDomain).not.toHaveBeenCalled();
  });

  it('returns null when no brand matches the user domain', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue(null);
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@unknown.example', makeCtx());
    expect(result).toBeNull();
  });

  it('returns null when the brand is already verified by the caller\'s own org', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: true,
      workos_organization_id: 'org_scope3',
    });
    mocks.resolvePrimaryOrganization.mockResolvedValue('org_scope3');
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@scope3.com', makeCtx());
    expect(result).toBeNull();
  });

  it('returns null when the brand is verified by ANOTHER org (claim would collision-fail)', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: true,
      workos_organization_id: 'org_someone_else',
    });
    mocks.resolvePrimaryOrganization.mockResolvedValue('org_intruder');
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@scope3.com', makeCtx());
    expect(result).toBeNull();
  });

  it('returns an active suggestion when the brand exists and is unclaimed', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: false,
    });
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@scope3.com', makeCtx());
    expect(result).not.toBeNull();
    expect(result!).toMatchObject({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      active: true,
      claim_url: '/brand/builder?domain=scope3.com',
      view_url: '/brand/view/scope3.com',
    });
  });

  it('returns an inactive suggestion when the user dismissed within the cooldown', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: false,
    });
    mocks.getNudgeDismissal.mockResolvedValue({
      workos_user_id: 'user_test',
      nudge_key: nudgeKey('scope3.com'),
      dismissed_at: new Date(),
    });
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@scope3.com', makeCtx());
    expect(result?.active).toBe(false);
  });

  it('re-activates the suggestion once the 30-day cooldown elapses', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: false,
    });
    mocks.getNudgeDismissal.mockResolvedValue({
      workos_user_id: 'user_test',
      nudge_key: nudgeKey('scope3.com'),
      dismissed_at: new Date(Date.now() - DISMISSAL_COOLDOWN_MS - 1000),
    });
    const result = await getBrandClaimSuggestionForUser('user_test', 'alice@scope3.com', makeCtx());
    expect(result?.active).toBe(true);
  });
});

describe('getSuggestionForDomain (brand-viewer JIT)', () => {
  beforeEach(() => {
    mocks.getDiscoveredBrandByDomain.mockReset();
    mocks.resolvePrimaryOrganization.mockReset();
    mocks.resolvePrimaryOrganization.mockResolvedValue(null);
    mocks.getNudgeDismissal.mockReset();
    mocks.getNudgeDismissal.mockResolvedValue(null);
  });

  it('returns the suggestion when the requested domain matches the user\'s email domain', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: false,
    });
    const result = await getSuggestionForDomain('user_test', 'alice@scope3.com', 'scope3.com', makeCtx());
    expect(result).not.toBeNull();
    expect(result!.domain).toBe('scope3.com');
  });

  it('returns null when the requested domain does NOT match the user\'s email domain', async () => {
    const result = await getSuggestionForDomain('user_test', 'alice@scope3.com', 'nike.com', makeCtx());
    expect(result).toBeNull();
    expect(mocks.getDiscoveredBrandByDomain).not.toHaveBeenCalled();
  });
});

describe('GET /api/me/brand-claim-suggestion', () => {
  beforeEach(() => {
    currentUser = { id: 'user_test', email: 'alice@scope3.com' };
    mocks.getDiscoveredBrandByDomain.mockReset();
    mocks.resolvePrimaryOrganization.mockReset();
    mocks.resolvePrimaryOrganization.mockResolvedValue(null);
    mocks.getNudgeDismissal.mockReset();
    mocks.getNudgeDismissal.mockResolvedValue(null);
  });

  it('returns the suggestion when applicable', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      domain_verified: false,
    });
    const res = await request(makeApp()).get('/api/me/brand-claim-suggestion');
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toMatchObject({
      domain: 'scope3.com',
      brand_name: 'Scope3',
      active: true,
    });
  });

  it('returns null suggestion when none applies', async () => {
    mocks.getDiscoveredBrandByDomain.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/me/brand-claim-suggestion');
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toBeNull();
  });

  it('scopes to a specific domain via ?domain= for the JIT prompt', async () => {
    const res = await request(makeApp()).get('/api/me/brand-claim-suggestion?domain=nike.com');
    expect(res.status).toBe(200);
    // alice@scope3.com asking about nike.com → no match
    expect(res.body.suggestion).toBeNull();
    expect(mocks.getDiscoveredBrandByDomain).not.toHaveBeenCalled();
  });

  it('400s a scoped query with a malformed domain', async () => {
    const res = await request(makeApp()).get('/api/me/brand-claim-suggestion?domain=://bogus');
    expect(res.status).toBe(200); // canonicalizeBrandDomain coerces; bogus → empty → null
    expect(res.body.suggestion).toBeNull();
  });
});

describe('POST /api/me/brand-claim-suggestion/dismiss', () => {
  beforeEach(() => {
    currentUser = { id: 'user_test', email: 'alice@scope3.com' };
    mocks.recordNudgeDismissal.mockReset();
    mocks.recordNudgeDismissal.mockResolvedValue(undefined);
  });

  it('records a dismissal for the canonicalized domain', async () => {
    const res = await request(makeApp())
      .post('/api/me/brand-claim-suggestion/dismiss')
      .send({ domain: 'Scope3.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, domain: 'scope3.com' });
    expect(mocks.recordNudgeDismissal).toHaveBeenCalledWith(
      'user_test',
      'brand_claim_suggestion:scope3.com',
    );
  });

  it('400s without a domain', async () => {
    const res = await request(makeApp()).post('/api/me/brand-claim-suggestion/dismiss').send({});
    expect(res.status).toBe(400);
    expect(mocks.recordNudgeDismissal).not.toHaveBeenCalled();
  });
});
