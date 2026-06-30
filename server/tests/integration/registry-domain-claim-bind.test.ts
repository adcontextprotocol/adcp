/**
 * Bind-on-verify domain claims (RFC #5749 gap #1).
 *
 * Ownership of a domain is established by binding an owner ON successful origin
 * verification, driven by an `adcp_claim` token the owner places in their origin
 * pointer — NOT by who triggers verification. These tests exercise the DB claim
 * methods through the verifier end-to-end:
 *   - a valid token binds the claim's org (and publishes the row)
 *   - a pointer with no/wrong token verifies but does not bind
 *   - a domain already locked to one owner cannot be re-claimed by another
 *
 * The squat-proofing in production is that a squatter cannot make the real
 * origin point at THEIR token; here we simulate the origin response via
 * `fetchImpl` and assert that only the exact pending token binds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'user_claim_test', email: 'claim@test.com', isAdmin: false };
    next();
  };
  return { ...actual, requireAuth: pass, requireAdmin: (_r: unknown, _s: unknown, n: () => void) => n() };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PropertyDatabase } from '../../src/db/property-db.js';
import { verifyHostedPropertyOrigin } from '../../src/services/hosted-property-origin-verifier.js';
import { aaoHostedAdagentsJsonUrl } from '../../src/config/aao.js';

const PUB = 'claim-bind.registry-baseline.example';
const DOMAIN_LIKE = 'claim-bind%.registry-baseline.example';
const ORG_A = 'org_claim_owner_a';
const ORG_B = 'org_claim_owner_b';

/** Origin pointer that targets AAO's hosted URL, optionally carrying a claim token. */
function pointerFetch(domain: string, token?: string) {
  const authoritative_location = token
    ? `${aaoHostedAdagentsJsonUrl(domain)}?adcp_claim=${token}`
    : aaoHostedAdagentsJsonUrl(domain);
  return vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify({ authoritative_location }) });
}

describe('bind-on-verify domain claims', () => {
  let pool: Pool;
  let propertyDb: PropertyDatabase;

  async function clearFixtures() {
    await pool.query('DELETE FROM hosted_properties WHERE publisher_domain LIKE $1', [DOMAIN_LIKE]);
  }

  async function seedOrgs() {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name) VALUES ($1, $2), ($3, $4)
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_A, 'Claim Owner A', ORG_B, 'Claim Owner B'],
    );
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    propertyDb = new PropertyDatabase();
    await seedOrgs();
  }, 60000);

  afterAll(async () => {
    await clearFixtures();
    await pool.query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [ORG_A, ORG_B]);
    await closeDatabase();
  }, 30000);

  beforeEach(async () => {
    await clearFixtures();
  });

  it('binds the claim org and publishes the row when the origin pointer carries the matching token', async () => {
    const { token } = await propertyDb.issueDomainClaim(PUB, ORG_A);
    expect(token).toBeTruthy();

    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, token!),
    });

    expect(outcome.verified).toBe(true);
    if (outcome.verified) expect(outcome.bound_org_id).toBe(ORG_A);

    const row = await propertyDb.getHostedPropertyByDomain(PUB);
    expect(row!.workos_organization_id).toBe(ORG_A);
    expect(row!.is_public).toBe(true);
    expect(row!.review_status).toBe('approved');
    expect(row!.origin_verified_at).toBeTruthy();
    // Token is consumed on bind.
    expect(row!.claim_token).toBeNull();
  });

  it('verifies but does NOT bind when the pointer carries no claim token', async () => {
    await propertyDb.issueDomainClaim(PUB, ORG_A);

    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB), // no token
    });

    expect(outcome.verified).toBe(true);
    if (outcome.verified) expect(outcome.bound_org_id).toBeUndefined();

    const row = await propertyDb.getHostedPropertyByDomain(PUB);
    // Origin endorses AAO hosting, but no token → no owner bound.
    expect(row!.workos_organization_id ?? null).toBeNull();
  });

  it('does NOT bind when the pointer token does not match the pending claim', async () => {
    await propertyDb.issueDomainClaim(PUB, ORG_A);

    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, 'a-token-that-was-never-issued'),
    });

    expect(outcome.verified).toBe(true);
    if (outcome.verified) expect(outcome.bound_org_id).toBeUndefined();

    const row = await propertyDb.getHostedPropertyByDomain(PUB);
    expect(row!.workos_organization_id ?? null).toBeNull();
  });

  it('refuses to issue a claim for a domain already verified and locked to another owner', async () => {
    // Lock the domain to ORG_A.
    const { token } = await propertyDb.issueDomainClaim(PUB, ORG_A);
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, token!),
    });
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.workos_organization_id).toBe(ORG_A);

    // ORG_B tries to claim — refused.
    const second = await propertyDb.issueDomainClaim(PUB, ORG_B);
    expect(second.token).toBeNull();
    expect(second.lockedToOrgId).toBe(ORG_A);

    // Owner is unchanged.
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.workos_organization_id).toBe(ORG_A);
  });

  it('never overwrites an existing different owner even if a stale token is presented', async () => {
    // Lock to ORG_A.
    const { token: tokenA } = await propertyDb.issueDomainClaim(PUB, ORG_A);
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, tokenA!),
    });

    // Directly attempt to bind ORG_B via the DB method with a fabricated token —
    // the guard requires a matching pending claim AND not-locked-to-another-owner.
    const bind = await propertyDb.bindOwnerFromVerifiedClaim(PUB, 'fabricated-token');
    expect(bind).toBeNull();
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.workos_organization_id).toBe(ORG_A);
  });

  it('lapses the lock when the origin pointer disappears, letting a NEW owner re-claim and re-bind', async () => {
    // ORG_A claims, verifies, and is locked.
    const { token: tokenA } = await propertyDb.issueDomainClaim(PUB, ORG_A);
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, tokenA!),
    });
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.origin_verified_at).toBeTruthy();

    // The domain changes hands / the pointer is removed: re-verification now
    // gets a 404. A permanent failure clears origin_verified_at (lapse).
    const lapse = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: vi.fn().mockResolvedValue({ status: 404, body: '' }),
    });
    expect(lapse.verified).toBe(false);
    const lapsed = await propertyDb.getHostedPropertyByDomain(PUB);
    expect(lapsed!.origin_verified_at).toBeNull(); // lock released

    // ORG_B can now claim (no longer refused — origin_verified_at is null)...
    const { token: tokenB } = await propertyDb.issueDomainClaim(PUB, ORG_B);
    expect(tokenB).toBeTruthy();
    // ...and re-bind, even though the stale workos_organization_id is still ORG_A.
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, tokenB!),
    });
    expect(outcome.verified).toBe(true);
    if (outcome.verified) expect(outcome.bound_org_id).toBe(ORG_B);
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.workos_organization_id).toBe(ORG_B);
  });

  it('lapses on NXDOMAIN — an expired domain ("Could not resolve hostname") is a permanent failure', async () => {
    const { token } = await propertyDb.issueDomainClaim(PUB, ORG_A);
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, token!),
    });
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.origin_verified_at).toBeTruthy();

    // Domain expired → DNS NXDOMAIN → safeFetch throws "Could not resolve hostname".
    const outcome = await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: vi.fn().mockRejectedValue(new Error(`Could not resolve hostname: ${PUB}`)),
    });
    expect(outcome.verified).toBe(false);
    if (!outcome.verified) expect(outcome.reason).toBe('unresolvable');
    // Permanent failure lapses the lock (vs a transient DNS blip, which would not).
    expect((await propertyDb.getHostedPropertyByDomain(PUB))!.origin_verified_at).toBeNull();
  });

  it('getHostedPropertiesDueForReverification returns verified rows past the TTL, not fresh or unverified ones', async () => {
    // Verified + locked, with origin_last_checked_at well in the past.
    const { token } = await propertyDb.issueDomainClaim(PUB, ORG_A);
    await verifyHostedPropertyOrigin({
      hosted: (await propertyDb.getHostedPropertyByDomain(PUB))!,
      fetchImpl: pointerFetch(PUB, token!),
    });
    await pool.query(
      `UPDATE hosted_properties SET origin_last_checked_at = NOW() - INTERVAL '2 days' WHERE publisher_domain = $1`,
      [PUB],
    );

    // A second, unverified community row — must never be a candidate.
    const UNVERIFIED = `claim-bind-unverified.registry-baseline.example`;
    await propertyDb.issueDomainClaim(UNVERIFIED, ORG_B);

    const due = await propertyDb.getHostedPropertiesDueForReverification(new Date(Date.now() - 24 * 60 * 60 * 1000), 50);
    const domains = due.map((r) => r.publisher_domain);
    expect(domains).toContain(PUB);
    expect(domains).not.toContain(UNVERIFIED); // origin_verified_at IS NULL → excluded
  });
});
