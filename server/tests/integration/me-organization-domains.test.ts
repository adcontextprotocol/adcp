/**
 * Integration tests for the member-facing /api/me/organization/domains
 * surface. Covers list + set-primary. After Stage 2 of #4159,
 * `organization_domains.is_primary` is the single source of truth for
 * both brand identity and org-membership inference, so a single PUT
 * unambiguously sets the primary (Media.net escalation #321).
 *
 * Auth in dev mode reads from the local organization_memberships seed
 * (resolveUserOrgMembership dev bypass), so we seed memberships rather
 * than mocking WorkOS.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Set DEV_USER_* env vars BEFORE auth.ts module-evaluates them — auth.ts
// caches DEV_MODE_ENABLED at module load. vi.hoisted runs before all imports
// in the file, so this beats ESM hoisting.
vi.hoisted(() => {
  process.env.DEV_USER_EMAIL = process.env.DEV_USER_EMAIL || 'admin@test.local';
  process.env.DEV_USER_ID = process.env.DEV_USER_ID || 'user_dev_admin_001';
});

// Replace `requireAuth` with a test stub that reads the user id from
// x-test-user. The real requireAuth reads a signed WorkOS session cookie
// (or static admin key); forging either just to exercise route logic is
// noise. The auth surface itself is covered elsewhere.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    requireAuth: (req: any, _res: any, next: any) => {
      const userId = req.headers['x-test-user'];
      if (typeof userId === 'string') req.user = { id: userId };
      return next();
    },
  };
});

import express from 'express';
import request from 'supertest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createMeOrganizationDomainsRouter,
  _resetVerifyCooldown,
} from '../../src/routes/me-organization-domains.js';
import type { Pool } from 'pg';

const TEST_ORG = 'org_me_domains_test';
const OTHER_ORG = 'org_me_domains_other';
const OWNER_USER = 'user_dev_admin_001';
const MEMBER_USER = 'user_dev_member_001';

async function cleanup(pool: Pool) {
  await pool.query(
    'DELETE FROM organization_domains WHERE workos_organization_id = ANY($1)',
    [[TEST_ORG, OTHER_ORG]],
  );
  await pool.query(
    'DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)',
    [[TEST_ORG, OTHER_ORG]],
  );
  await pool.query(
    'DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)',
    [[TEST_ORG, OTHER_ORG]],
  );
  await pool.query('DELETE FROM brands WHERE domain LIKE $1', ['me-domains-%.test']);
  await pool.query(
    'DELETE FROM organizations WHERE workos_organization_id = ANY($1)',
    [[TEST_ORG, OTHER_ORG]],
  );
}

async function seedOrgWithDomains(pool: Pool, domains: Array<{ domain: string; verified: boolean; is_primary: boolean; source?: string }>) {
  await pool.query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
     VALUES ($1, $2, false, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [TEST_ORG, 'Me Domains Test Co'],
  );
  for (const d of domains) {
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET verified = EXCLUDED.verified, is_primary = EXCLUDED.is_primary, source = EXCLUDED.source`,
      [TEST_ORG, d.domain, d.verified, d.is_primary, d.source ?? 'workos'],
    );
  }
}

async function seedProfile(pool: Pool) {
  await pool.query(
    `INSERT INTO member_profiles (workos_organization_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (workos_organization_id) DO NOTHING`,
    [TEST_ORG, 'me-domains-test', 'Me Domains Test Co'],
  );
}

async function seedMembership(pool: Pool, userId: string, role: 'owner' | 'admin' | 'member') {
  await pool.query(
    `INSERT INTO organization_memberships (
       workos_user_id, workos_organization_id, workos_membership_id,
       email, first_name, last_name, role, seat_type, provisioning_source,
       synced_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Test', 'User', $5, 'contributor', 'manual', NOW(), NOW(), NOW())
     ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, TEST_ORG, `om_${userId}_${TEST_ORG}`, `${userId}@test.local`, role],
  );
}

function buildApp(invalidateMemberContextCache: () => void, workos: any = null) {
  const app = express();
  app.use(express.json());
  // requireAuth is replaced via vi.mock above; it reads x-test-user from
  // the request headers and populates req.user.
  const router = createMeOrganizationDomainsRouter({
    workos,
    invalidateMemberContextCache,
  });
  app.use('/api/me/organization/domains', router);
  return app;
}

// Minimal WorkOS SDK stand-in for the add/verify routes. Each test seeds
// the in-memory state and points the methods at it. Mirrors the real SDK
// shapes used in the route (organizations.getOrganization,
// organizationDomains.{create,verify,delete}OrganizationDomain).
type FakeDomain = {
  id: string;
  domain: string;
  state: string;
  verificationToken: string | null;
  verificationPrefix: string | null;
  verificationStrategy: string | null;
};

function makeFakeWorkos(initial: FakeDomain[] = []) {
  const state = { domains: initial.slice() };
  const errors: { create?: any; verify?: any } = {};
  return {
    state,
    setCreateError(err: any) { errors.create = err; },
    setVerifyError(err: any) { errors.verify = err; },
    organizations: {
      async getOrganization(_orgId: string) {
        return { domains: state.domains };
      },
    },
    organizationDomains: {
      async createOrganizationDomain({ domain }: { organizationId: string; domain: string }) {
        if (errors.create) throw errors.create;
        const created: FakeDomain = {
          id: 'org_domain_' + Math.random().toString(36).slice(2, 10),
          domain,
          state: 'pending',
          verificationToken: 'token_' + Math.random().toString(36).slice(2, 10),
          verificationPrefix: '_workos',
          verificationStrategy: 'dns',
        };
        state.domains.push(created);
        return created;
      },
      async verifyOrganizationDomain(id: string) {
        if (errors.verify) throw errors.verify;
        const found = state.domains.find(d => d.id === id);
        if (!found) throw Object.assign(new Error('not found'), { status: 404 });
        found.state = 'verified';
        return found;
      },
      async deleteOrganizationDomain(id: string) {
        const idx = state.domains.findIndex(d => d.id === id);
        if (idx >= 0) state.domains.splice(idx, 1);
      },
    },
  };
}

describe('GET /api/me/organization/domains + PUT /:domain/primary', () => {
  let pool: Pool;
  let cacheInvalidations: number;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    cacheInvalidations = 0;
    app = buildApp(() => { cacheInvalidations += 1; });
  });

  it('lists verified domains with is_primary and is_brand_primary flags', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-2.test', verified: true, is_primary: false },
      { domain: 'me-domains-pending.test', verified: false, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .get('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(200);
    expect(res.body.primary_brand_domain).toBe('me-domains-1.test');
    expect(res.body.domains).toHaveLength(3);
    const byDomain = Object.fromEntries(res.body.domains.map((d: any) => [d.domain, d]));
    expect(byDomain['me-domains-1.test']).toMatchObject({ is_primary: true, verified: true, is_brand_primary: true, claimable: true });
    expect(byDomain['me-domains-2.test']).toMatchObject({ is_primary: false, verified: true, is_brand_primary: false, claimable: true });
    expect(byDomain['me-domains-pending.test']).toMatchObject({ verified: false });
  });

  it('PUT primary moves organization_domains.is_primary and updates organizations.email_domain', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-2.test', verified: true, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-2.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, primary_domain: 'me-domains-2.test' });
    expect(cacheInvalidations).toBe(1);

    const od = await pool.query<{ domain: string; is_primary: boolean }>(
      `SELECT domain, is_primary FROM organization_domains WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    const od_by = Object.fromEntries(od.rows.map((r) => [r.domain, r.is_primary]));
    expect(od_by['me-domains-2.test']).toBe(true);
    expect(od_by['me-domains-1.test']).toBe(false);

    const org = await pool.query<{ email_domain: string }>(
      `SELECT email_domain FROM organizations WHERE workos_organization_id = $1`,
      [TEST_ORG],
    );
    expect(org.rows[0].email_domain).toBe('me-domains-2.test');
  });

  it('rejects PUT primary from a non-owner/admin member', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-2.test', verified: true, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, MEMBER_USER, 'member');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-2.test/primary?org=' + TEST_ORG)
      .set('x-test-user', MEMBER_USER);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized');

    // No write happened.
    const od = await pool.query<{ domain: string; is_primary: boolean }>(
      `SELECT domain, is_primary FROM organization_domains WHERE workos_organization_id = $1 AND is_primary = true`,
      [TEST_ORG],
    );
    expect(od.rows[0].domain).toBe('me-domains-1.test');
  });

  it('rejects PUT primary on an unverified domain', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
      { domain: 'me-domains-pending.test', verified: false, is_primary: false },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-pending.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('domain_not_verified');
  });

  it('refuses PUT primary for source != workos (admin-imported / manual rows)', async () => {
    // After Stage 2 of #4159, is_primary drives both org-membership
    // inference and brand identity. We hold the bar at WorkOS DNS proof:
    // an admin-imported verified=true row shouldn't be promotable via
    // member self-service — that would let an admin escalate brand
    // identity by importing a row.
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true, source: 'workos' },
      { domain: 'me-domains-imported.test', verified: true, is_primary: false, source: 'import' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/me-domains-imported.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('domain_not_workos_verified');

    // is_primary unchanged — the original WorkOS-verified domain stays primary.
    const od = await pool.query<{ domain: string; is_primary: boolean }>(
      `SELECT domain, is_primary FROM organization_domains WHERE workos_organization_id = $1 AND is_primary = true`,
      [TEST_ORG],
    );
    expect(od.rows[0].domain).toBe('me-domains-1.test');
  });

  it('returns 404 for a domain not on this org', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-1.test', verified: true, is_primary: true },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const res = await request(app)
      .put('/api/me/organization/domains/some-other.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/me/organization/domains (issue + verify challenge)', () => {
  let pool: Pool;
  let cacheInvalidations: number;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup(pool);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup(pool);
    cacheInvalidations = 0;
    _resetVerifyCooldown();
  });

  it('issues a WorkOS DNS challenge and writes a pending source=workos row', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos();
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'me-domains-new.test' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      domain: 'me-domains-new.test',
      already_verified: false,
      verification_prefix: '_workos',
      verification_strategy: 'dns',
    });
    expect(typeof res.body.verification_token).toBe('string');
    expect(res.body.verification_token.length).toBeGreaterThan(0);

    const row = await pool.query<{ source: string; verified: boolean }>(
      `SELECT source, verified FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
      [TEST_ORG, 'me-domains-new.test'],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].source).toBe('workos');
    expect(row.rows[0].verified).toBe(false);
  });

  it('rejects POST add from a non-owner/admin member', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, MEMBER_USER, 'member');

    const app = buildApp(() => { cacheInvalidations += 1; }, makeFakeWorkos());

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', MEMBER_USER)
      .send({ domain: 'me-domains-new.test' });

    expect(res.status).toBe(403);
  });

  it('rejects malformed / public-suffix domains', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const app = buildApp(() => { cacheInvalidations += 1; }, makeFakeWorkos());

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'gmail.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_domain');
  });

  it('surfaces the existing token when a pending challenge already exists (idempotent)', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos([
      {
        id: 'org_domain_existing',
        domain: 'me-domains-new.test',
        state: 'pending',
        verificationToken: 'preexisting-token',
        verificationPrefix: '_workos',
        verificationStrategy: 'dns',
      },
    ]);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'me-domains-new.test' });

    expect(res.status).toBe(200);
    expect(res.body.verification_token).toBe('preexisting-token');
    expect(res.body.already_verified).toBe(false);

    // Local row mirrors pending state at source=workos.
    const row = await pool.query<{ source: string; verified: boolean }>(
      `SELECT source, verified FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
      [TEST_ORG, 'me-domains-new.test'],
    );
    expect(row.rows[0].source).toBe('workos');
    expect(row.rows[0].verified).toBe(false);
  });

  it('returns 409 when WorkOS reports the domain belongs to another org', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos();
    const collisionErr: any = new Error('Domain already used');
    collisionErr.status = 422;
    collisionErr.response = { data: { code: 'organization_domain_already_used', message: 'already used' } };
    fakeWorkos.setCreateError(collisionErr);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'me-domains-collide.test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('domain_already_claimed');
  });

  it('verify flips local row to verified=true and invalidates cache', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-new.test', verified: false, is_primary: false, source: 'workos' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos([
      {
        id: 'org_domain_new',
        domain: 'me-domains-new.test',
        state: 'pending',
        verificationToken: 'token123',
        verificationPrefix: '_workos',
        verificationStrategy: 'dns',
      },
    ]);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains/me-domains-new.test/verify?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, newly_verified: true, state: 'verified' });
    expect(cacheInvalidations).toBe(1);

    const row = await pool.query<{ verified: boolean; source: string }>(
      `SELECT verified, source FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
      [TEST_ORG, 'me-domains-new.test'],
    );
    expect(row.rows[0].verified).toBe(true);
    expect(row.rows[0].source).toBe('workos');
  });

  it('verify returns still_pending when WorkOS finds no TXT record', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-new.test', verified: false, is_primary: false, source: 'workos' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos([
      {
        id: 'org_domain_new',
        domain: 'me-domains-new.test',
        state: 'pending',
        verificationToken: 'token123',
        verificationPrefix: '_workos',
        verificationStrategy: 'dns',
      },
    ]);
    const pendingErr: any = new Error('not yet propagated');
    pendingErr.status = 422;
    fakeWorkos.setVerifyError(pendingErr);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains/me-domains-new.test/verify?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('still_pending');

    const row = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
      [TEST_ORG, 'me-domains-new.test'],
    );
    expect(row.rows[0].verified).toBe(false);
  });

  it('verify returns 404 when no WorkOS challenge exists', async () => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const app = buildApp(() => { cacheInvalidations += 1; }, makeFakeWorkos());

    const res = await request(app)
      .post('/api/me/organization/domains/me-domains-never-issued.test/verify?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_challenge');
  });

  it('rejects verify from a non-owner/admin member', async () => {
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-new.test', verified: false, is_primary: false, source: 'workos' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, MEMBER_USER, 'member');

    const app = buildApp(() => { cacheInvalidations += 1; }, makeFakeWorkos());

    const res = await request(app)
      .post('/api/me/organization/domains/me-domains-new.test/verify?org=' + TEST_ORG)
      .set('x-test-user', MEMBER_USER);

    expect(res.status).toBe(403);
  });

  it('after verify, PUT /:domain/primary accepts the WorkOS-verified row', async () => {
    // End-to-end seam: this is the original "why does this need admin?" path —
    // a member-issued and member-verified domain should be promotable to
    // primary without admin intervention.
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-existing.test', verified: true, is_primary: true, source: 'workos' },
      { domain: 'me-domains-new.test', verified: false, is_primary: false, source: 'workos' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos([
      {
        id: 'org_domain_new',
        domain: 'me-domains-new.test',
        state: 'pending',
        verificationToken: 'token123',
        verificationPrefix: '_workos',
        verificationStrategy: 'dns',
      },
    ]);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const verifyRes = await request(app)
      .post('/api/me/organization/domains/me-domains-new.test/verify?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);
    expect(verifyRes.status).toBe(200);

    const primaryRes = await request(app)
      .put('/api/me/organization/domains/me-domains-new.test/primary?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);
    expect(primaryRes.status).toBe(200);
    expect(primaryRes.body.primary_domain).toBe('me-domains-new.test');
  });

  it('refuses to overwrite a local row owned by another org (cross-tenant safety)', async () => {
    // Threat model: Org B has a local-only row for `me-domains-shared.test`
    // (e.g. admin-imported, source='import'). WorkOS doesn't know about it.
    // Org A's owner POSTs the same domain. Without the pre-check, the
    // ownership-transfer-on-conflict semantic of upsertWorkosDomain would
    // silently move the row to Org A. We expect 409, with Org B's row
    // untouched. The transfer-on-conflict primitive is reserved for the
    // verify path, where WorkOS confirms DNS proof.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [OTHER_ORG, 'Other Org'],
    );
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source, created_at, updated_at)
       VALUES ($1, $2, true, true, 'import', NOW(), NOW())
       ON CONFLICT (domain) DO UPDATE SET verified = EXCLUDED.verified, is_primary = EXCLUDED.is_primary, source = EXCLUDED.source`,
      [OTHER_ORG, 'me-domains-shared.test'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const app = buildApp(() => { cacheInvalidations += 1; }, makeFakeWorkos());

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'me-domains-shared.test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('domain_already_claimed');

    // Other org's row is untouched.
    const row = await pool.query<{ workos_organization_id: string; source: string; is_primary: boolean }>(
      `SELECT workos_organization_id, source, is_primary FROM organization_domains WHERE domain = $1`,
      ['me-domains-shared.test'],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].workos_organization_id).toBe(OTHER_ORG);
    expect(row.rows[0].source).toBe('import');
    expect(row.rows[0].is_primary).toBe(true);
  });

  it('detects WorkOS collision via the message-regex fallback (no code field)', async () => {
    // WorkOS sometimes returns 422 with a plain-English message and no
    // structured `code`. The route falls back to a regex match on the
    // message body. Without this test the regex can silently rot.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos();
    const collisionErr: any = new Error('Domain already used');
    collisionErr.status = 422;
    collisionErr.response = { data: { message: 'Domain belongs to another organization' } };
    fakeWorkos.setCreateError(collisionErr);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'me-domains-collide.test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('domain_already_claimed');
  });

  it('deletes and recreates a broken pending WorkOS entry (no verification token)', async () => {
    // Broken state on WorkOS: a domain is attached but verificationToken /
    // verificationPrefix are null. Returning the broken state would echo
    // nulls back to the user forever. The route deletes the broken entry
    // and falls through to a fresh create.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG, 'Me Domains Test Co'],
    );
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos([
      {
        id: 'org_domain_broken',
        domain: 'me-domains-broken.test',
        state: 'pending',
        verificationToken: null,
        verificationPrefix: null,
        verificationStrategy: null,
      },
    ]);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const res = await request(app)
      .post('/api/me/organization/domains?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER)
      .send({ domain: 'me-domains-broken.test' });

    expect(res.status).toBe(200);
    expect(typeof res.body.verification_token).toBe('string');
    expect(res.body.verification_token.length).toBeGreaterThan(0);
    expect(res.body.verification_prefix).toBe('_workos');
    // Broken entry was deleted and a fresh one replaced it.
    expect(fakeWorkos.state.domains).toHaveLength(1);
    expect(fakeWorkos.state.domains[0].id).not.toBe('org_domain_broken');
  });

  it('rate-limits verify retries with a 60s cooldown', async () => {
    // Agentic loops poll on still_pending. The cooldown stops them from
    // burning WorkOS quota. A successful verify clears the cooldown so a
    // follow-up "verify, then set primary" sequence doesn't have to wait.
    await seedOrgWithDomains(pool, [
      { domain: 'me-domains-new.test', verified: false, is_primary: false, source: 'workos' },
    ]);
    await seedProfile(pool);
    await seedMembership(pool, OWNER_USER, 'owner');

    const fakeWorkos = makeFakeWorkos([
      {
        id: 'org_domain_new',
        domain: 'me-domains-new.test',
        state: 'pending',
        verificationToken: 'token123',
        verificationPrefix: '_workos',
        verificationStrategy: 'dns',
      },
    ]);
    const pendingErr: any = new Error('not yet propagated');
    pendingErr.status = 422;
    fakeWorkos.setVerifyError(pendingErr);
    const app = buildApp(() => { cacheInvalidations += 1; }, fakeWorkos);

    const first = await request(app)
      .post('/api/me/organization/domains/me-domains-new.test/verify?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);
    expect(first.status).toBe(400);
    expect(first.body.error).toBe('still_pending');

    // Immediate retry — within the cooldown window. Should 429 without
    // calling WorkOS again.
    const second = await request(app)
      .post('/api/me/organization/domains/me-domains-new.test/verify?org=' + TEST_ORG)
      .set('x-test-user', OWNER_USER);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('still_pending');
    expect(typeof second.body.retry_after_seconds).toBe('number');
  });
});
