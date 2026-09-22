import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_onboarding';
  process.env.WORKOS_CLIENT_ID = 'client_test_onboarding';
  process.env.WORKOS_COOKIE_PASSWORD = 'x'.repeat(32);
  process.env.WORKOS_WEBHOOK_SECRET = 'onboarding-restoration-test-secret';
  return {
    sessions: new Map<string, any>(),
    providerUsers: new Map<string, any>(),
    providerOrganizations: new Map<string, any>(),
    providerMemberships: new Map<string, any>(),
    getUser: vi.fn(),
    getOrganizationByExternalId: vi.fn(),
    createOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    listOrganizationMemberships: vi.fn(),
    createOrganizationMembership: vi.fn(),
    createApiKeyValidation: vi.fn(),
  };
});

function notFound(): Error {
  return Object.assign(new Error('not found'), { status: 404 });
}

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = {
      loadSealedSession: ({ sessionData }: any) => ({
        authenticate: async () => {
          const stored = mocks.sessions.get(sessionData);
          const user = stored.user || stored;
          return {
            authenticated: true,
            user,
            accessToken: `test-access:${user.id}`,
            impersonator: stored.impersonator,
          };
        },
      }),
      getUser: mocks.getUser,
      listOrganizationMemberships: mocks.listOrganizationMemberships,
      createOrganizationMembership: mocks.createOrganizationMembership,
    };
    organizations = {
      getOrganizationByExternalId: mocks.getOrganizationByExternalId,
      createOrganization: mocks.createOrganization,
      deleteOrganization: mocks.deleteOrganization,
    };
    apiKeys = { createValidation: mocks.createApiKeyValidation };
    webhooks = { constructEvent: vi.fn().mockResolvedValue({}) };
  },
}));

vi.mock('../../src/auth/workos-client.js', async (original) => {
  const actual = await original<typeof import('../../src/auth/workos-client.js')>();
  const { WorkOS } = await import('@workos-inc/node');
  const instance = new WorkOS();
  return {
    ...actual,
    getWorkos: () => instance,
    getAuthorizationEnforcementWorkos: () => instance,
  };
});

vi.mock('../../src/auth/workos-jwt.js', async (original) => ({
  ...await original<typeof import('../../src/auth/workos-jwt.js')>(),
  verifyWorkOSJWT: async (value: string) => ({
    sub: value === 'm2m.m2m.m2m' ? 'client_onboarding_test' : value.replace(/^test-access:/, ''),
    isM2M: value === 'm2m.m2m.m2m',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  }),
}));

vi.mock('../../src/middleware/csrf.js', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/middleware/rate-limit.js', async (original) => {
  const actual = await original<typeof import('../../src/middleware/rate-limit.js')>();
  const pass = (_req: any, _res: any, next: any) => next();
  return { ...actual, orgCreationRateLimiter: pass };
});

vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));

import { HTTPServer } from '../../src/http.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { invalidateSessionsForUsers } from '../../src/middleware/auth.js';
import { reconcilePendingOrganizationOnboarding } from '../../src/services/organization-bootstrap.js';
import { getAuthorizationEnforcementWorkos } from '../../src/auth/workos-client.js';
import { runOrganizationOnboardingReconciliationJob } from '../../src/addie/jobs/organization-onboarding-reconciliation.js';
import type { Pool } from 'pg';

const A = 'user_onboarding_primary';
const B = 'user_onboarding_exact';
let pool: Pool;
let app: HTTPServer['app'];
let sessionNumber = 0;
let providerOrgNumber = 0;

function cookie(id = B, impersonator?: { email: string; reason: string | null }): string {
  const key = `onboarding-session-${++sessionNumber}`;
  const provider = mocks.providerUsers.get(id);
  const user = {
    id,
    email: provider.email,
    emailVerified: provider.emailVerified,
    firstName: provider.firstName,
    lastName: provider.lastName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mocks.sessions.set(key, impersonator ? { user, impersonator } : user);
  return `wos-session=${key}`;
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    organization_name: 'Nova Onboarding',
    company_type: 'brand',
    revenue_tier: 'under_1m',
    marketing_opt_in: true,
    agreements_accepted: true,
    terms_version: '1.0',
    privacy_version: '1.0',
    ...overrides,
  };
}

function exactMembership(userId: string, organizationId: string, id = `om_${organizationId}`) {
  return {
    id,
    userId,
    organizationId,
    status: 'active',
    role: { slug: 'owner' },
  };
}

async function link(primary: string, sibling: string) {
  await pool.query('UPDATE identity_workos_users SET is_primary = false WHERE workos_user_id = $1', [sibling]);
  await pool.query(
    `UPDATE identity_workos_users SET identity_id =
       (SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1)
     WHERE workos_user_id = $2`,
    [primary, sibling],
  );
  await pool.query('UPDATE identity_workos_users SET is_primary = true WHERE workos_user_id = $1', [primary]);
  invalidateSessionsForUsers([primary, sibling]);
}

async function localAuthorityRows() {
  const [organizations, memberships, domains, audits, agreements, epochs, operations] = await Promise.all([
    pool.query("SELECT * FROM organizations WHERE workos_organization_id LIKE 'org_onboarding_%' ORDER BY workos_organization_id"),
    pool.query('SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_organization_id', [[A, B]]),
    pool.query("SELECT * FROM organization_domains WHERE workos_organization_id LIKE 'org_onboarding_%' ORDER BY id"),
    pool.query("SELECT * FROM registry_audit_log WHERE resource_id LIKE 'org_onboarding_%' ORDER BY created_at"),
    pool.query('SELECT * FROM user_agreement_acceptances WHERE workos_user_id = ANY($1) ORDER BY agreement_type', [[A, B]]),
    pool.query('SELECT * FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [[A, B]]),
    pool.query('SELECT * FROM organization_onboarding_operations WHERE authenticated_workos_user_id = ANY($1) ORDER BY created_at', [[A, B]]),
  ]);
  return {
    organizations: organizations.rows,
    memberships: memberships.rows,
    domains: domains.rows,
    audits: audits.rows,
    agreements: agreements.rows,
    epochs: epochs.rows,
    operations: operations.rows,
  };
}

async function cleanupTestRows() {
  await pool.query(
    `DELETE FROM addie_escalations
      WHERE dedup_key LIKE 'organization-onboarding-reconciliation:%'
        AND workos_user_id = ANY($1)`,
    [[A, B]],
  );
  await pool.query("DELETE FROM registry_audit_log WHERE resource_id LIKE 'org_onboarding_%'");
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query("DELETE FROM organizations WHERE workos_organization_id = 'org_existing_prospect'");
  await pool.query("DELETE FROM organizations WHERE workos_organization_id LIKE 'org_onboarding_%'");
  await pool.query('DELETE FROM user_agreement_acceptances WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM organization_onboarding_operations WHERE authenticated_workos_user_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM user_email_preferences WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[A, B]]);
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\/[^/]+@(127\.0\.0\.1|localhost):\d+\/adcp_test$/.test(connectionString)) {
    throw new Error('This suite requires an explicit loopback adcp_test database');
  }
  pool = initializeDatabase({ connectionString });
  await runMigrations();
  app = new HTTPServer({ backgroundServices: 'refresh-only' }).app;
}, 60_000);

beforeEach(async () => {
  vi.clearAllMocks();
  providerOrgNumber = 0;
  invalidateSessionsForUsers([A, B]);
  await cleanupTestRows();
  await pool.query(
    `INSERT INTO users (workos_user_id, email, email_verified, first_name, last_name)
     VALUES ($1, 'primary@unrelated.test', true, 'Primary', 'Person'),
            ($2, 'owner@nova-onboarding.test', true, 'Exact', 'Owner')`,
    [A, B],
  );

  mocks.providerOrganizations.clear();
  mocks.providerMemberships.clear();
  mocks.providerUsers.clear();
  mocks.providerUsers.set(A, {
    id: A, email: 'primary@unrelated.test', emailVerified: true,
    firstName: 'Primary', lastName: 'Person',
  });
  mocks.providerUsers.set(B, {
    id: B, email: 'owner@nova-onboarding.test', emailVerified: true,
    firstName: 'Exact', lastName: 'Owner',
  });
  mocks.getUser.mockImplementation(async (id: string) => {
    const user = mocks.providerUsers.get(id);
    if (!user) throw notFound();
    return { ...user };
  });
  mocks.getOrganizationByExternalId.mockImplementation(async (externalId: string) => {
    const org = mocks.providerOrganizations.get(externalId);
    if (!org) throw notFound();
    return { ...org };
  });
  mocks.createOrganization.mockImplementation(async (payload: any) => {
    const org = {
      id: `org_onboarding_${++providerOrgNumber}`,
      name: payload.name,
      externalId: payload.externalId,
    };
    mocks.providerOrganizations.set(payload.externalId, org);
    return { ...org };
  });
  mocks.deleteOrganization.mockImplementation(async (organizationId: string) => {
    for (const [externalId, org] of mocks.providerOrganizations) {
      if (org.id === organizationId) mocks.providerOrganizations.delete(externalId);
    }
    for (const [id, membership] of mocks.providerMemberships) {
      if (membership.organizationId === organizationId) mocks.providerMemberships.delete(id);
    }
  });
  mocks.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId, statuses }: any) => ({
    data: [...mocks.providerMemberships.values()].filter(row =>
      (!userId || row.userId === userId)
      && (!organizationId || row.organizationId === organizationId)
      && (!statuses || statuses.includes(row.status))),
  }));
  mocks.createOrganizationMembership.mockImplementation(async ({ userId, organizationId }: any) => {
    const membership = exactMembership(userId, organizationId);
    mocks.providerMemberships.set(membership.id, membership);
    return { ...membership };
  });
  mocks.createApiKeyValidation.mockResolvedValue({
    apiKey: {
      id: 'key_onboarding',
      owner: { type: 'organization', id: 'org_api_key_onboarding' },
      name: 'Onboarding automation',
      permissions: ['admin:*'],
    },
  });
});

afterAll(async () => {
  await cleanupTestRows();
  await closeDatabase();
});

describe('exact-credential organization onboarding restoration', () => {
  it('creates a corporate organization with exact owner, verified domain, consent, marketing, audit, and epoch atomically', async () => {
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'corporate-success-0001')
      .send(createBody({
        membership_tier: 'company_leader',
        corporate_domain: 'attacker-controlled.example',
      }));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      organization: { id: 'org_onboarding_1', name: 'Nova Onboarding' },
    });
    expect(response.body.operation_id).toEqual(expect.any(String));
    expect(mocks.createOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nova Onboarding',
        externalId: expect.stringMatching(/^adcp_onboarding_/),
        metadata: { onboarding_operation_id: response.body.operation_id },
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(mocks.createOrganizationMembership).toHaveBeenCalledWith({
      userId: B,
      organizationId: 'org_onboarding_1',
      roleSlug: 'owner',
    });

    const state = await localAuthorityRows();
    expect(state.organizations).toHaveLength(1);
    expect(state.organizations[0]).toMatchObject({
      workos_organization_id: 'org_onboarding_1',
      is_personal: false,
      company_type: 'brand',
      revenue_tier: 'under_1m',
      membership_tier: null,
    });
    expect(state.memberships).toHaveLength(1);
    expect(state.memberships[0]).toMatchObject({
      workos_user_id: B,
      workos_organization_id: 'org_onboarding_1',
      role: 'owner',
      workos_membership_id: 'om_org_onboarding_1',
    });
    expect(state.domains).toEqual([
      expect.objectContaining({
        domain: 'nova-onboarding.test', verified: true, is_primary: true,
        source: 'email_verification',
      }),
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({ workos_user_id: B, action: 'organization_created' }),
    ]);
    expect(state.audits[0].details).toMatchObject({
      authenticated_workos_user_id: B,
      canonical_workos_user_id: B,
      authority: 'exact_credential_first_owner',
      provider_identity_verified: true,
    });
    expect(state.agreements.map(row => row.agreement_type).sort()).toEqual([
      'privacy_policy', 'terms_of_service',
    ]);
    expect(state.epochs).toEqual([expect.objectContaining({ workos_user_id: B, epoch: '1' })]);
    expect(state.operations).toEqual([
      expect.objectContaining({ status: 'completed', authenticated_workos_user_id: B }),
    ]);
    expect((await pool.query(
      'SELECT marketing_opt_in FROM user_email_preferences WHERE workos_user_id = $1', [B],
    )).rows).toEqual([{ marketing_opt_in: true }]);
  });

  it('creates one personal workspace without assigning a corporate domain', async () => {
    const body = createBody({
      organization_name: "Exact Owner's Workspace",
      is_personal: true,
      company_type: undefined,
      revenue_tier: undefined,
      marketing_opt_in: false,
    });
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'personal-success-0001')
      .send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const state = await localAuthorityRows();
    expect(state.organizations[0]).toMatchObject({ is_personal: true, email_domain: null });
    expect(state.domains).toEqual([]);

    invalidateSessionsForUsers([B]);
    const duplicate = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'personal-second-0002')
      .send({ ...body, organization_name: 'Another Personal Workspace' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('Personal workspace exists');
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
  });

  it('binds a linked sibling onboarding owner to the exact credential, never the canonical user', async () => {
    await link(A, B);
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie(B))
      .set('Idempotency-Key', 'linked-exact-owner-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mocks.createOrganizationMembership).toHaveBeenCalledWith({
      userId: B,
      organizationId: 'org_onboarding_1',
      roleSlug: 'owner',
    });
    const state = await localAuthorityRows();
    expect(state.memberships.map(row => row.workos_user_id)).toEqual([B]);
    expect(state.audits.map(row => row.workos_user_id)).toEqual([B]);
    expect(state.audits[0].details).toMatchObject({
      authenticated_workos_user_id: B,
      canonical_workos_user_id: A,
    });
    expect(state.epochs).toEqual([expect.objectContaining({ workos_user_id: B, epoch: '1' })]);
  });

  it('enforces the organization limit across every credential linked to the identity', async () => {
    await link(A, B);
    for (let index = 0; index < 10; index++) {
      const orgId = `org_onboarding_limit_${index}`;
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, is_personal)
         VALUES ($1, $2, false)`,
        [orgId, `Limit Organization ${index}`],
      );
      await pool.query(
        `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, email, role)
         VALUES ($1, $2, 'primary@unrelated.test', 'owner')`,
        [A, orgId],
      );
    }
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie(B))
      .set('Idempotency-Key', 'linked-org-limit-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Organization limit reached');
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.createOrganizationMembership).not.toHaveBeenCalled();
  });

  it('keeps prospect adoption contained with a distinct actionable response while making no provider write', async () => {
    await pool.query(
      `INSERT INTO organizations
       (workos_organization_id, name, is_personal, email_domain, prospect_status)
       VALUES ('org_existing_prospect', 'Nova Prospect', false, 'nova-onboarding.test', 'prospect')
       ON CONFLICT (workos_organization_id) DO UPDATE SET prospect_status = 'prospect'`,
    );
    await pool.query(
      `INSERT INTO organization_domains
       (workos_organization_id, domain, verified, is_primary, source)
       VALUES ('org_existing_prospect', 'nova-onboarding.test', false, true, 'admin_discovery')
       ON CONFLICT (domain) DO UPDATE SET workos_organization_id = EXCLUDED.workos_organization_id`,
    );
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'prospect-contained-0001')
      .send(createBody());
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'organization_adoption_unavailable',
      existing_org_id: 'org_existing_prospect',
      existing_org_name: 'Nova Prospect',
    });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.createOrganizationMembership).not.toHaveBeenCalled();
    await pool.query("DELETE FROM organizations WHERE workos_organization_id = 'org_existing_prospect'");
  });

  it('requires current provider-verified corporate email and does not infer authority from the local email string', async () => {
    mocks.providerUsers.set(B, {
      ...mocks.providerUsers.get(B), emailVerified: false,
    });
    invalidateSessionsForUsers([B]);
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'unverified-domain-0001')
      .send(createBody());
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('verified_corporate_email_required');
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it('binds consent to the exact displayed legal versions before any provider write', async () => {
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'stale-legal-version-0001')
      .send(createBody({ terms_version: '0.9' }));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('agreement_acceptance_required');
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it('rejects impersonated first-owner and legal-consent actions', async () => {
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie(B, { email: 'admin@example.test', reason: 'support' }))
      .set('Idempotency-Key', 'impersonated-owner-0001')
      .send(createBody());
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('impersonation_not_allowed');
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it('rejects API-key and M2M credentials before provider or local authorization effects', async () => {
    const apiKeyResponse = await request(app).post('/api/organizations')
      .set('Authorization', 'Bearer sk_onboarding_automation')
      .set('Idempotency-Key', 'api-key-owner-0001')
      .send(createBody());
    expect(apiKeyResponse.status).toBe(401);
    expect(apiKeyResponse.body.error).toBe('invalid_credential');

    const m2mResponse = await request(app).post('/api/organizations')
      .set('Authorization', 'Bearer m2m.m2m.m2m')
      .set('Idempotency-Key', 'm2m-owner-0001')
      .send(createBody());
    expect(m2mResponse.status).toBe(401);
    expect(m2mResponse.body.error).toBe('Invalid bearer token');

    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.createOrganizationMembership).not.toHaveBeenCalled();
    expect((await localAuthorityRows()).operations).toEqual([]);
  });

  it('rejects malformed provider domains and canonicalizes IDNs to one ASCII ownership key', async () => {
    mocks.providerUsers.set(B, {
      ...mocks.providerUsers.get(B), email: 'owner@localhost', emailVerified: true,
    });
    await pool.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [B, 'owner@localhost']);
    invalidateSessionsForUsers([B]);
    const malformed = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'malformed-domain-0001')
      .send(createBody());
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('Corporate email required');
    expect(mocks.createOrganization).not.toHaveBeenCalled();

    mocks.providerUsers.set(B, {
      ...mocks.providerUsers.get(B), email: 'owner@hey.com', emailVerified: true,
    });
    await pool.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [B, 'owner@hey.com']);
    invalidateSessionsForUsers([B]);
    const sharedMailbox = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'shared-mailbox-domain-0001')
      .send(createBody());
    expect(sharedMailbox.status).toBe(400);
    expect(sharedMailbox.body.error).toBe('Corporate email required');
    expect(mocks.createOrganization).not.toHaveBeenCalled();

    mocks.providerUsers.set(B, {
      ...mocks.providerUsers.get(B), email: 'owner@b\u00fccher.example', emailVerified: true,
    });
    await pool.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [B, 'owner@b\u00fccher.example']);
    invalidateSessionsForUsers([B]);
    const idn = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'idn-domain-0001')
      .send(createBody());
    expect(idn.status, JSON.stringify(idn.body)).toBe(200);
    expect((await localAuthorityRows()).domains).toEqual([
      expect.objectContaining({ domain: 'xn--bcher-kva.example', verified: true }),
    ]);
  });

  it('compensates a provider organization when the exact identity binding is replaced mid-operation', async () => {
    const binding = (await pool.query<{ identity_id: string; is_primary: boolean }>(
      'SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1', [B],
    )).rows[0];
    mocks.createOrganization.mockImplementationOnce(async (payload: any) => {
      const org = { id: 'org_onboarding_1', name: payload.name, externalId: payload.externalId };
      mocks.providerOrganizations.set(payload.externalId, org);
      await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id = $1', [B]);
      await pool.query(
        `INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary)
         VALUES ($1, $2, $3)`,
        [B, binding.identity_id, binding.is_primary],
      );
      return org;
    });
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'binding-swap-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('onboarding_credential_changed');
    expect(mocks.deleteOrganization).toHaveBeenCalledWith('org_onboarding_1');
    const state = await localAuthorityRows();
    expect(state.organizations).toEqual([]);
    expect(state.memberships).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(state.agreements).toEqual([]);
    expect(state.epochs).toEqual([]);
    expect(state.operations).toEqual([expect.objectContaining({
      status: 'failed', terminal_outcome: { kind: 'credential_changed' },
    })]);

    invalidateSessionsForUsers([B]);
    const replay = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'binding-swap-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('onboarding_credential_changed');
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOrganization).toHaveBeenCalledTimes(1);
  });

  it('compensates when the provider email/domain changes after organization creation', async () => {
    let reads = 0;
    mocks.getUser.mockImplementation(async (id: string) => {
      const user = { ...mocks.providerUsers.get(id) };
      if (++reads >= 3) user.email = 'owner@changed-domain.test';
      return user;
    });
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'email-change-0001')
      .send(createBody());
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('onboarding_credential_changed');
    expect(mocks.deleteOrganization).toHaveBeenCalledWith('org_onboarding_1');
    const state = await localAuthorityRows();
    expect(state.organizations).toEqual([]);
    expect(state.memberships).toEqual([]);
    expect(state.domains).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(state.epochs).toEqual([]);
  });

  it('compensates when provider emailVerified changes before the local commit', async () => {
    let reads = 0;
    mocks.getUser.mockImplementation(async (id: string) => {
      const user = { ...mocks.providerUsers.get(id) };
      if (++reads >= 3) user.emailVerified = false;
      return user;
    });
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'verification-change-0001')
      .send(createBody());
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('onboarding_credential_changed');
    expect(mocks.deleteOrganization).toHaveBeenCalledWith('org_onboarding_1');
    const state = await localAuthorityRows();
    expect(state.organizations).toEqual([]);
    expect(state.memberships).toEqual([]);
    expect(state.domains).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(state.epochs).toEqual([]);
  });

  it('fences stale compensation after an expired lease is claimed by a successor', async () => {
    let reads = 0;
    mocks.getUser.mockImplementation(async (id: string) => {
      const user = { ...mocks.providerUsers.get(id) };
      if (++reads === 3) {
        await pool.query(
          `UPDATE organization_onboarding_operations
              SET lease_token = gen_random_uuid(), lease_expires_at = NOW() - INTERVAL '1 second'
            WHERE authenticated_workos_user_id = $1`,
          [B],
        );
        user.email = 'owner@changed-domain.test';
      }
      return user;
    });
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'expired-lease-fence-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('organization_onboarding_reconciliation_required');
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
    expect(mocks.providerOrganizations.size).toBe(1);
    expect((await localAuthorityRows()).organizations).toEqual([]);
  });

  it('fences duplicate and changed concurrent submissions, then replays the completed response', async () => {
    let releaseCreate!: () => void;
    const createBlocked = new Promise<void>(resolve => { releaseCreate = resolve; });
    let createStarted!: () => void;
    const started = new Promise<void>(resolve => { createStarted = resolve; });
    mocks.createOrganization.mockImplementationOnce(async (payload: any) => {
      createStarted();
      await createBlocked;
      const org = { id: 'org_onboarding_1', name: payload.name, externalId: payload.externalId };
      mocks.providerOrganizations.set(payload.externalId, org);
      return org;
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    const first = request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'concurrent-duplicate-0001')
      .send(body).then(response => response);
    await started;
    const changed = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'concurrent-changed-0001')
      .send({ ...body, organization_name: 'Changed While In Flight' });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe('organization_onboarding_in_progress');
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();

    const duplicate = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'concurrent-duplicate-0001')
      .send(body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('organization_onboarding_in_progress');
    releaseCreate();
    const completed = await first;
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    invalidateSessionsForUsers([B]);
    const replay = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'concurrent-duplicate-0001')
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.organization).toEqual(completed.body.organization);
    expect(replay.body.operation_id).toBe(completed.body.operation_id);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizationMembership).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent personal-workspace creation across linked credentials', async () => {
    await link(A, B);
    let releaseCreate!: () => void;
    const createBlocked = new Promise<void>(resolve => { releaseCreate = resolve; });
    let createStarted!: () => void;
    const started = new Promise<void>(resolve => { createStarted = resolve; });
    mocks.createOrganization.mockImplementationOnce(async (payload: any) => {
      createStarted();
      await createBlocked;
      const org = { id: 'org_onboarding_1', name: payload.name, externalId: payload.externalId };
      mocks.providerOrganizations.set(payload.externalId, org);
      return org;
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    const first = request(app).post('/api/organizations')
      .set('Cookie', cookie(B))
      .set('Idempotency-Key', 'linked-concurrent-b-0001')
      .send(body).then(response => response);
    await started;
    const sibling = await request(app).post('/api/organizations')
      .set('Cookie', cookie(A))
      .set('Idempotency-Key', 'linked-concurrent-a-0001')
      .send({ ...body, organization_name: "Primary's Workspace" });
    expect(sibling.status).toBe(409);
    expect(sibling.body.error).toBe('organization_onboarding_in_progress');
    releaseCreate();
    expect((await first).status).toBe(200);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizationMembership).toHaveBeenCalledTimes(1);
    expect((await localAuthorityRows()).memberships.map(row => row.workos_user_id)).toEqual([B]);
  });

  it('fails closed when a linked sibling credential is inside a concurrent membership mutation', async () => {
    await link(A, B);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE', [A]);
      const response = await request(app).post('/api/organizations')
        .set('Cookie', cookie(B))
        .set('Idempotency-Key', 'sibling-membership-race-0001')
        .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('authorization_unavailable');
      expect(mocks.createOrganization).not.toHaveBeenCalled();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('recovers an ambiguous provider organization create on retry by stable external ID', async () => {
    mocks.createOrganization.mockImplementationOnce(async (payload: any) => {
      const org = { id: 'org_onboarding_1', name: payload.name, externalId: payload.externalId };
      mocks.providerOrganizations.set(payload.externalId, org);
      throw Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' });
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    const first = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'org-timeout-retry-0001')
      .send(body);
    expect(first.status).toBe(503);
    expect(first.body.error).toBe('organization_onboarding_retryable');
    expect((await localAuthorityRows()).organizations).toEqual([]);

    const retry = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'org-timeout-retry-0001')
      .send(body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.organization.id).toBe('org_onboarding_1');
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizationMembership).toHaveBeenCalledTimes(1);
  });

  it('recovers when provider state was written and the database acknowledgement was lost', async () => {
    const originalQuery = pool.query.bind(pool);
    let injected = false;
    const querySpy = vi.spyOn(pool as any, 'query').mockImplementation(async (...args: any[]) => {
      const result = await (originalQuery as any)(...args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const values = Array.isArray(args[1]) ? args[1] : args[0]?.values;
      if (!injected && typeof sql === 'string'
          && sql.includes('workos_organization_id = COALESCE')
          && values?.[3] === 'org_onboarding_1') {
        injected = true;
        throw new Error('lost PostgreSQL acknowledgement after commit');
      }
      return result;
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    let first;
    try {
      first = await request(app).post('/api/organizations')
        .set('Cookie', cookie())
        .set('Idempotency-Key', 'db-ack-loss-0001')
        .send(body);
    } finally {
      querySpy.mockRestore();
    }
    expect(first.status).toBe(503);
    expect(first.body.error).toBe('organization_onboarding_retryable');
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
    expect((await localAuthorityRows()).operations[0]).toMatchObject({
      workos_organization_id: 'org_onboarding_1',
    });

    invalidateSessionsForUsers([B]);
    const retry = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'db-ack-loss-0001')
      .send(body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
  });

  it('retries transient finalization lock contention without compensating provider state', async () => {
    const blocker = await pool.connect();
    const originalCreateMembership = mocks.createOrganizationMembership.getMockImplementation();
    mocks.createOrganizationMembership.mockImplementationOnce(async (payload: any) => {
      const membership = await originalCreateMembership!(payload);
      await blocker.query('BEGIN');
      await blocker.query('SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE', [B]);
      return membership;
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    let first;
    try {
      first = await request(app).post('/api/organizations')
        .set('Cookie', cookie())
        .set('Idempotency-Key', 'finalize-lock-retry-0001')
        .send(body);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(first.status).toBe(503);
    expect(first.body.error).toBe('organization_onboarding_retryable');
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
    expect(mocks.providerOrganizations.size).toBe(1);
    expect((await localAuthorityRows()).organizations).toEqual([]);

    invalidateSessionsForUsers([B]);
    const retry = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'finalize-lock-retry-0001')
      .send(body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizationMembership).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
  });

  it('persists compensation intent before deletion and resumes an ambiguous acknowledgement', async () => {
    let reads = 0;
    mocks.getUser.mockImplementation(async (id: string) => {
      const user = { ...mocks.providerUsers.get(id) };
      if (++reads >= 3) user.email = 'owner@changed-domain.test';
      return user;
    });
    const originalQuery = pool.query.bind(pool);
    let injected = false;
    const querySpy = vi.spyOn(pool as any, 'query').mockImplementation(async (...args: any[]) => {
      const result = await (originalQuery as any)(...args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (!injected && typeof sql === 'string' && sql.includes("SET status = 'compensating'")) {
        injected = true;
        throw new Error('lost compensation-intent acknowledgement');
      }
      return result;
    });
    let response;
    try {
      response = await request(app).post('/api/organizations')
        .set('Cookie', cookie())
        .set('Idempotency-Key', 'compensation-ack-loss-0001')
        .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    } finally {
      querySpy.mockRestore();
    }
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('organization_onboarding_reconciliation_required');
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
    expect((await localAuthorityRows()).operations[0]).toMatchObject({
      status: 'compensating', terminal_outcome: { kind: 'credential_changed' },
    });

    await pool.query(
      `UPDATE organization_onboarding_operations
          SET lease_token = NULL, lease_expires_at = NULL
        WHERE authenticated_workos_user_id = $1`,
      [B],
    );
    const result = await reconcilePendingOrganizationOnboarding(
      getAuthorizationEnforcementWorkos(),
      1,
    );
    expect(result).toMatchObject({ attempted: 1, compensated: 1 });
    expect(mocks.deleteOrganization).toHaveBeenCalledWith('org_onboarding_1');
    expect((await localAuthorityRows()).operations[0]).toMatchObject({ status: 'failed' });
  });

  it('background reconciliation completes a retryable provider timeout without another client request', async () => {
    mocks.createOrganization.mockImplementationOnce(async (payload: any) => {
      const org = { id: 'org_onboarding_1', name: payload.name, externalId: payload.externalId };
      mocks.providerOrganizations.set(payload.externalId, org);
      throw Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' });
    });
    const response = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'worker-timeout-recovery-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('organization_onboarding_retryable');

    const result = await reconcilePendingOrganizationOnboarding(
      getAuthorizationEnforcementWorkos(),
      1,
    );
    expect(result).toMatchObject({ attempted: 1, completed: 1 });
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect((await localAuthorityRows()).organizations).toHaveLength(1);
  });

  it('revisits every manual row without starving behind deduplicated operator escalations', async () => {
    const divergentMembership = async ({ userId, organizationId }: any) => ({
      ...exactMembership(userId, organizationId), role: { slug: 'member' },
    });
    mocks.createOrganizationMembership
      .mockImplementationOnce(divergentMembership)
      .mockImplementationOnce(divergentMembership);
    const firstResponse = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'manual-escalation-0001')
      .send(createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined }));
    const secondResponse = await request(app).post('/api/organizations')
      .set('Cookie', cookie(A))
      .set('Idempotency-Key', 'manual-escalation-0002')
      .send(createBody({
        organization_name: 'Second Manual Workspace',
        is_personal: true,
        company_type: undefined,
        revenue_tier: undefined,
      }));
    for (const response of [firstResponse, secondResponse]) {
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('organization_onboarding_reconciliation_required');
    }
    const operations = (await localAuthorityRows()).operations;
    expect(operations).toHaveLength(2);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        authenticated_workos_user_id: A,
        status: 'manual_reconciliation',
        last_error_code: 'provider_state_diverged',
      }),
      expect.objectContaining({
        authenticated_workos_user_id: B,
        status: 'manual_reconciliation',
        last_error_code: 'provider_state_diverged',
      }),
    ]));

    const first = await runOrganizationOnboardingReconciliationJob(
      getAuthorizationEnforcementWorkos(),
      1,
      1,
    );
    const second = await runOrganizationOnboardingReconciliationJob(
      getAuthorizationEnforcementWorkos(),
      1,
      1,
    );
    const third = await runOrganizationOnboardingReconciliationJob(
      getAuthorizationEnforcementWorkos(),
      1,
      1,
    );
    expect(first).toMatchObject({ attempted: 0, manualScanned: 1, manualQueued: 1 });
    expect(second).toMatchObject({ attempted: 0, manualScanned: 1, manualQueued: 1 });
    expect(third).toMatchObject({ attempted: 0, manualScanned: 0, manualQueued: 0 });
    const escalations = await pool.query(
      `SELECT category, priority, status, dedup_key, workos_user_id
         FROM addie_escalations
        WHERE dedup_key = ANY($1)
        ORDER BY workos_user_id`,
      [operations.map(operation => `organization-onboarding-reconciliation:${operation.id}`)],
    );
    expect(escalations.rows).toHaveLength(2);
    expect(escalations.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'needs_human_action', priority: 'high', status: 'open', workos_user_id: A,
      }),
      expect.objectContaining({
        category: 'needs_human_action', priority: 'high', status: 'open', workos_user_id: B,
      }),
    ]));
  });

  it('compensates an ambiguous provider organization when exact provider identity changes before retry', async () => {
    mocks.createOrganization.mockImplementationOnce(async (payload: any) => {
      const org = { id: 'org_onboarding_1', name: payload.name, externalId: payload.externalId };
      mocks.providerOrganizations.set(payload.externalId, org);
      throw Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' });
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    const first = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'identity-change-retry-0001')
      .send(body);
    expect(first.status).toBe(503);
    expect(first.body.error).toBe('organization_onboarding_retryable');

    mocks.providerUsers.set(B, {
      ...mocks.providerUsers.get(B), email: 'owner@new-provider-domain.test', emailVerified: true,
    });
    await pool.query(
      'UPDATE users SET email = $2, email_verified = true WHERE workos_user_id = $1',
      [B, 'owner@new-provider-domain.test'],
    );
    invalidateSessionsForUsers([B]);
    const retry = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'identity-change-retry-0001')
      .send(body);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('onboarding_credential_changed');
    expect(mocks.deleteOrganization).toHaveBeenCalledWith('org_onboarding_1');
    const state = await localAuthorityRows();
    expect(state.organizations).toEqual([]);
    expect(state.memberships).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(state.epochs).toEqual([]);
    expect(state.operations).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('recovers an ambiguous owner-membership create without duplicating authority', async () => {
    mocks.createOrganizationMembership.mockImplementationOnce(async ({ userId, organizationId }: any) => {
      const membership = exactMembership(userId, organizationId);
      mocks.providerMemberships.set(membership.id, membership);
      throw Object.assign(new Error('timeout after membership write'), { code: 'ETIMEDOUT' });
    });
    const body = createBody({ is_personal: true, company_type: undefined, revenue_tier: undefined });
    const first = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'membership-timeout-0001')
      .send(body);
    expect(first.status).toBe(503);
    expect(first.body.error).toBe('organization_onboarding_retryable');
    expect((await localAuthorityRows()).memberships).toEqual([]);

    const retry = await request(app).post('/api/organizations')
      .set('Cookie', cookie())
      .set('Idempotency-Key', 'membership-timeout-0001')
      .send(body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganizationMembership).toHaveBeenCalledTimes(1);
    const state = await localAuthorityRows();
    expect(state.memberships).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.epochs).toHaveLength(1);
  });
});
