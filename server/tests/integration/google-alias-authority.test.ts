import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { detectGoogleAliasAccount } from '../../src/services/google-alias-detection.js';

const provider = vi.hoisted(() => ({
  listUsers: vi.fn(), listOrganizationMemberships: vi.fn(),
  createOrganizationMembership: vi.fn(), updateUser: vi.fn(), deleteUser: vi.fn(),
  fetch: vi.fn(),
}));
vi.hoisted(() => {
  vi.stubEnv('WORKOS_API_KEY', 'sk_test_alias_authority');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_test_alias_authority');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'alias-authority-test-cookie-password-32-characters');
});
vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS { userManagement = provider; },
}));
vi.mock('../../src/middleware/auth.js', () => ({
  DEV_USERS: {},
  isDevModeEnabled: () => false,
  // Supply a verified credential at the session boundary, then use the same
  // persisted primary-identity routing as production authentication. A binding
  // introduced by detection must change the API-key authorization outcome.
  requireAuth: async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { getPool } = await import('../../src/db/client.js');
    const credentialId = req.header('x-test-credential');
    const result = await getPool().query(
      `SELECT canonical.workos_user_id, u.email
         FROM identity_workos_users credential
         JOIN identity_workos_users canonical
           ON canonical.identity_id = credential.identity_id AND canonical.is_primary
         JOIN users u ON u.workos_user_id = canonical.workos_user_id
        WHERE credential.workos_user_id = $1`, [credentialId],
    );
    if (!result.rows[0]) { res.sendStatus(401); return; }
    req.user = {
      id: result.rows[0].workos_user_id, authWorkosUserId: credentialId,
      email: result.rows[0].email, emailVerified: true,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    next();
  },
}));
const { createApiKeysRouter } = await import('../../src/routes/api-keys.js');

const USER_IDS = ['user_alias_authority_gmail', 'user_alias_authority_googlemail'];
const EMAILS = ['alias.authority.test@gmail.com', 'alias.authority.test@googlemail.com'];
const ORG_IDS = ['org_alias_authority_member', 'org_alias_authority_owner'];
const GROUP_SLUG = 'alias-authority-private-committee';
const PERSONAL_ORG_ID = 'org_alias_authority_personal';
const ALL_ORG_IDS = [...ORG_IDS, PERSONAL_ORG_ID];
const API_KEY_ORGS = [PERSONAL_ORG_ID, ORG_IDS[1]];

interface ProviderMembership {
  userId: string;
  organizationId: string;
  status: string;
  role: { slug: string };
}
interface ProviderApiKey {
  id: string;
  organization_id: string;
  name: string;
  permissions: string[];
}

describe('Google aliases never union credential authority', () => {
  let pool: Pool;
  let credentials: { id: string; email: string }[];
  let memberships: ProviderMembership[];
  let apiKeys: ProviderApiKey[];
  const app = express();
  app.use(express.json());
  app.use('/api/me/api-keys', createApiKeysRouter());

  async function cleanup() {
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM working_groups WHERE slug = $1', [GROUP_SLUG]);
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [ALL_ORG_IDS]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    vi.stubGlobal('fetch', provider.fetch);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    for (let index = 0; index < 2; index++) {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified)
         VALUES ($1, $2, 'Alex', 'Reeves', TRUE)`, [USER_IDS[index], EMAILS[index]],
      );
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, subscription_status)
         VALUES ($1, 'Pinnacle Agency', $2)`, [ORG_IDS[index], index ? 'active' : null],
      );
      await pool.query(
        `INSERT INTO organization_memberships
           (workos_user_id, workos_organization_id, email, role, seat_type,
            workos_membership_id, provisioning_source)
         VALUES ($1, $2, $3, $4, $5, $6, 'invited')`,
        [USER_IDS[index], ORG_IDS[index], EMAILS[index], index ? 'owner' : 'member',
          index ? 'contributor' : 'community_only', `om_alias_authority_${index}`],
      );
    }
    await pool.query(
      `INSERT INTO organizations
         (workos_organization_id, name, is_personal, membership_tier,
          stripe_customer_id, stripe_subscription_id, subscription_status,
          subscription_price_lookup_key, subscription_metadata)
       VALUES ($1, 'Alex Reeves', TRUE, 'individual_professional',
          'cus_alias_personal', 'sub_alias_personal', 'active',
          'aao_membership_individual', $2)`,
      [PERSONAL_ORG_ID, JSON.stringify({ workos_user_id: USER_IDS[0] })],
    );
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, email, role, workos_membership_id, provisioning_source)
       VALUES ($1, $2, $3, 'owner', 'om_alias_personal', 'webhook')`,
      [USER_IDS[0], PERSONAL_ORG_ID, EMAILS[0]],
    );
    await pool.query(
      `INSERT INTO subscription_line_items
         (workos_organization_id, stripe_subscription_id, stripe_subscription_item_id,
          price_id, product_id, product_name, quantity, amount, billing_interval, metadata)
       VALUES ($1, 'sub_alias_personal', 'si_alias_personal',
          'price_alias_individual', 'prod_alias_individual', 'Individual membership',
          1, 25000, 'year', $2)`,
      [PERSONAL_ORG_ID, JSON.stringify({ workos_user_id: USER_IDS[0] })],
    );
    credentials = USER_IDS.map((id, i) => ({ id, email: EMAILS[i] }));
    memberships = [
      ...USER_IDS.map((userId, i) => ({ userId, organizationId: ORG_IDS[i], status: 'active', role: { slug: i ? 'owner' : 'member' } })),
      { userId: USER_IDS[0], organizationId: PERSONAL_ORG_ID, status: 'active', role: { slug: 'owner' } },
    ];
    apiKeys = API_KEY_ORGS.map((organization_id, i) => ({
      id: `key_alias_${i}`, organization_id, name: `Credential ${i} organization key`, permissions: ['admin:read'],
    }));
    provider.listUsers.mockImplementation(async ({ email }) => ({
      data: structuredClone(credentials.filter((row) => row.email === email)),
    }));
    provider.listOrganizationMemberships.mockImplementation(async ({ userId, organizationId }) => ({
      data: structuredClone(memberships.filter((row) => row.userId === userId && (!organizationId || row.organizationId === organizationId))),
    }));
    provider.createOrganizationMembership.mockImplementation(async ({ userId, organizationId }) => {
      memberships.push({ userId, organizationId, status: 'active', role: { slug: 'member' } });
    });
    provider.updateUser.mockImplementation(async ({ userId, email }) => {
      credentials = credentials.map((row) => row.id === userId ? { ...row, email } : row);
    });
    provider.deleteUser.mockImplementation(async (userId: string) => {
      credentials = credentials.filter((row) => row.id !== userId);
      memberships = memberships.filter((row) => row.userId !== userId);
    });
    // API keys are owned by WorkOS, not a local SQL table. These are the actual
    // records returned to the production inventory route; mutations operate on
    // the same store, so a forbidden write cannot hide behind detached fixtures.
    provider.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname.split('/');
      if (path[1] !== 'organizations' || path[3] !== 'api_keys') throw new Error('Unexpected provider path');
      const organizationId = path[2];
      if (options.method === 'DELETE') {
        apiKeys = apiKeys.filter((key) => key.organization_id !== organizationId || key.id !== path[4]);
        return new Response(null, { status: 204 });
      }
      if (options.method === 'POST') {
        const body = JSON.parse(String(options.body));
        apiKeys.push({ id: 'key_created', organization_id: organizationId, name: body.name, permissions: body.permissions ?? [] });
      }
      return new Response(JSON.stringify({ data: apiKeys.filter((key) => key.organization_id === organizationId) }), { status: 200 });
    });
    const group = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug, is_private)
       VALUES ('Private committee', $1, TRUE) RETURNING id`,
      [GROUP_SLUG],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)`,
      [group.rows[0].id, USER_IDS[1]],
    );
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, added_by_user_id)
       VALUES ($1, $2, $2)`, [group.rows[0].id, USER_IDS[1]],
    );
    const adminMembership = await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, added_by_user_id)
       SELECT id, $1, $1 FROM working_groups WHERE slug = 'aao-admin'`, [USER_IDS[1]],
    );
    expect(adminMembership.rowCount).toBe(1);
  });

  async function snapshot() {
    const results = await Promise.all([
      pool.query('SELECT * FROM users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
      pool.query('SELECT * FROM identity_workos_users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
      pool.query('SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id, workos_organization_id', [USER_IDS]),
      pool.query('SELECT * FROM organizations WHERE workos_organization_id = ANY($1) ORDER BY workos_organization_id', [ALL_ORG_IDS]),
      pool.query('SELECT * FROM subscription_line_items WHERE workos_organization_id = ANY($1) ORDER BY workos_organization_id', [ALL_ORG_IDS]),
      pool.query('SELECT * FROM working_groups WHERE slug = $1', [GROUP_SLUG]),
      pool.query('SELECT * FROM working_group_leaders WHERE user_id = ANY($1) ORDER BY user_id', [USER_IDS]),
      pool.query('SELECT * FROM working_group_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id, working_group_id', [USER_IDS]),
      pool.query('SELECT * FROM user_email_aliases WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
    ]);
    const inventories = [];
    for (let i = 0; i < USER_IDS.length; i++) {
      const own = await request(app).get(`/api/me/api-keys?org=${API_KEY_ORGS[i]}`).set('x-test-credential', USER_IDS[i]).expect(200);
      expect(own.body.data).toHaveLength(1);
      expect(own.body.data[0].organization_id).toBe(API_KEY_ORGS[i]);
      inventories.push(own.body.data);
      const fetchCount = provider.fetch.mock.calls.length;
      await request(app).get(`/api/me/api-keys?org=${API_KEY_ORGS[1 - i]}`).set('x-test-credential', USER_IDS[i]).expect(403);
      expect(provider.fetch).toHaveBeenCalledTimes(fetchCount);
    }
    expect(results[4].rows).toHaveLength(1);
    expect(results[4].rows[0]).toMatchObject({
      workos_organization_id: PERSONAL_ORG_ID, stripe_subscription_id: 'sub_alias_personal',
      metadata: { workos_user_id: USER_IDS[0] },
    });
    expect(results[3].rows.find((row) => row.workos_organization_id === PERSONAL_ORG_ID)).toMatchObject({
      is_personal: true, stripe_customer_id: 'cus_alias_personal', stripe_subscription_id: 'sub_alias_personal',
      subscription_metadata: { workos_user_id: USER_IDS[0] },
    });
    expect(results[2].rows.filter((row) => row.workos_organization_id === PERSONAL_ORG_ID))
      .toEqual([expect.objectContaining({ workos_user_id: USER_IDS[0], role: 'owner' })]);
    return {
      local: results.map((result) => result.rows), apiKeys: inventories,
      memberships: structuredClone(memberships), credentials: structuredClone(credentials),
    };
  }

  it.each([0, 1])('preserves all authority and routing when credential %i signs in, including retries', async (index) => {
    const before = await snapshot();

    for (let retry = 0; retry < 2; retry++) {
      expect(await detectGoogleAliasAccount({ id: USER_IDS[index], email: EMAILS[index] }, provider))
        .toBe(EMAILS[1 - index]);
    }

    expect(await snapshot()).toEqual(before);
    expect(provider.createOrganizationMembership).not.toHaveBeenCalled();
    expect(provider.updateUser).not.toHaveBeenCalled();
    expect(provider.deleteUser).not.toHaveBeenCalled();
    expect(provider.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    expect(provider.listUsers).not.toHaveBeenCalled();
    // The same join used by authentication still routes each sign-in to itself.
    const routing = await pool.query(
      `SELECT credential.workos_user_id, primary_credential.workos_user_id AS canonical_user_id,
              EXISTS (
                SELECT 1 FROM working_group_memberships membership
                JOIN working_groups group_row ON group_row.id = membership.working_group_id
                WHERE membership.workos_user_id = primary_credential.workos_user_id
                  AND group_row.slug = 'aao-admin' AND membership.status = 'active'
              ) AS is_platform_admin
         FROM identity_workos_users credential
         JOIN identity_workos_users primary_credential
           ON primary_credential.identity_id = credential.identity_id AND primary_credential.is_primary
        WHERE credential.workos_user_id = ANY($1) ORDER BY credential.workos_user_id`,
      [USER_IDS],
    );
    expect(routing.rows).toEqual(USER_IDS.map((id, i) => ({
      workos_user_id: id, canonical_user_id: id, is_platform_admin: i === 1,
    })));
    const audit = await pool.query(
      `SELECT action, workos_user_id, resource_id, details FROM registry_audit_log WHERE workos_user_id = $1`,
      [USER_IDS[index]],
    );
    expect(audit.rows).toEqual(Array.from({ length: 2 }, () => ({
      action: 'google_alias_detected', workos_user_id: USER_IDS[index], resource_id: USER_IDS[1 - index],
      details: { outcome: 'support_review_required' },
    })));
  });
});
