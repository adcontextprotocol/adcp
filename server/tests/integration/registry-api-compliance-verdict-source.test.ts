/**
 * Integration tests for the owner-scope gate on
 * GET /api/registry/agents/:encodedUrl/compliance.
 *
 * Pins the verdict_source / membership_tier / subscription_status /
 * is_api_access_tier scoping: those keys MUST exist on every response
 * (so non-owners can't detect ownership via Object.keys shape), but
 * carry null/false values for anonymous and cross-org callers. Only
 * an authenticated viewer whose org owns the agent sees populated
 * values.
 *
 * Unit-level coverage of `resolveOwnerMembership` already pins the is_owner
 * semantics (server/tests/unit/membership-tiers.test.ts, PR #4389). This
 * test layers the route in: it proves the same gate fires end-to-end
 * through the actual Express handler and DB queries, catching any
 * regression where a future refactor wires the gate to the wrong field
 * or skips it for an auth shape.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
 *     npx vitest run server/tests/integration/registry-api-compliance-verdict-source.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const OWNER_USER_ID = `user_verdict_owner_${RUN_SUFFIX}`;
const CROSS_ORG_USER_ID = `user_verdict_cross_${RUN_SUFFIX}`;
const OWNER_ORG_ID = `org_verdict_owner_${RUN_SUFFIX}`;
const CROSS_ORG_ID = `org_verdict_cross_${RUN_SUFFIX}`;
const AGENT_URL = `https://verdict-source-${RUN_SUFFIX}.example.com/mcp`;

// optAuth on the compliance endpoint stamps req.user only when the auth
// header parses successfully. Tests toggle currentUserId between owner,
// cross-org, and null (anonymous) to exercise each auth branch.
let currentUserId: string | null = null;

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  return {
    ...actual,
    requireAuth: (req: { user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (currentUserId === null) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
      next();
    },
    optionalAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      if (currentUserId !== null) {
        req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
      }
      next();
    },
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/middleware/csrf.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/csrf.js');
  return {
    ...actual,
    csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

describe('GET /api/registry/agents/:encodedUrl/compliance — owner-scope gate (integration)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    // Two orgs: OWNER_ORG holds the agent under member_profiles.agents (the
    // canonical ownership shape); CROSS_ORG holds a non-owner user. Using
    // an active API-access tier on the owner org so the populated branch
    // sets is_api_access_tier=true and exercises the full true path, not
    // just the is_owner=true / api_access=false combo.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, membership_tier, subscription_status, created_at, updated_at)
       VALUES ($1, 'Owner Org', 'company_standard', 'active', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE
         SET membership_tier = EXCLUDED.membership_tier,
             subscription_status = EXCLUDED.subscription_status,
             updated_at = NOW()`,
      [OWNER_ORG_ID],
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Cross Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [CROSS_ORG_ID],
    );

    await pool.query(
      `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, email, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', NOW(), NOW())
       ON CONFLICT (workos_organization_id, workos_user_id) DO NOTHING`,
      [OWNER_ORG_ID, OWNER_USER_ID, `${OWNER_USER_ID}@test.com`],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, email, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', NOW(), NOW())
       ON CONFLICT (workos_organization_id, workos_user_id) DO NOTHING`,
      [CROSS_ORG_ID, CROSS_ORG_USER_ID, `${CROSS_ORG_USER_ID}@test.com`],
    );

    // member_profiles.agents is what findOwnerOrgForUser looks up. Putting
    // the agent under OWNER_ORG only — CROSS_ORG has no agents, so the
    // cross-org caller resolves to no owning org.
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents, created_at, updated_at)
       VALUES ($1, 'Owner Org', $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE
         SET agents = EXCLUDED.agents, updated_at = NOW()`,
      [
        OWNER_ORG_ID,
        `owner-org-${RUN_SUFFIX}`,
        JSON.stringify([{ url: AGENT_URL, name: 'Test agent' }]),
      ],
    );

    // Insert a passing compliance run + materialized status with
    // triggered_by='owner_test' so getComplianceStatus returns
    // last_triggered_by='owner_test'. That's the field the route gates
    // behind is_owner — the test asserts owners see it and non-owners
    // see null.
    await pool.query(
      `INSERT INTO agent_compliance_runs (
         agent_url, lifecycle_stage, overall_status, headline,
         tracks_json, tracks_passed, tracks_failed, tracks_skipped, tracks_partial,
         triggered_by, dry_run, tested_at
       ) VALUES ($1, 'production', 'passing', 'all clear',
                 '[]'::jsonb, 0, 0, 0, 0, 'owner_test', false, NOW())`,
      [AGENT_URL],
    );
    await pool.query(
      `INSERT INTO agent_compliance_status (
         agent_url, status, last_checked_at, last_passed_at,
         tracks_summary_json, headline, status_changed_at, updated_at
       ) VALUES ($1, 'passing', NOW(), NOW(),
                 '{}'::jsonb, 'all clear', NOW(), NOW())
       ON CONFLICT (agent_url) DO UPDATE
         SET status = EXCLUDED.status,
             last_checked_at = NOW(),
             last_passed_at = NOW(),
             headline = EXCLUDED.headline,
             updated_at = NOW()`,
      [AGENT_URL],
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_compliance_runs WHERE agent_url = $1', [AGENT_URL]);
    await pool.query('DELETE FROM agent_compliance_status WHERE agent_url = $1', [AGENT_URL]);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [[OWNER_ORG_ID, CROSS_ORG_ID]]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [[OWNER_ORG_ID, CROSS_ORG_ID]]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[OWNER_ORG_ID, CROSS_ORG_ID]]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(() => {
    currentUserId = null;
  });

  const endpoint = `/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance`;

  const OWNER_ONLY_KEYS = [
    'verdict_source',
    'membership_tier',
    'membership_tier_label',
    'subscription_status',
    'is_api_access_tier',
  ] as const;

  it('anonymous caller: shape is intact, owner-only fields are null/false', async () => {
    currentUserId = null;
    const res = await request(app).get(endpoint);
    expect(res.status).toBe(200);
    // Defense-in-depth: every owner-only key is present so the response
    // shape doesn't leak ownership status. Values for an anonymous caller
    // are all null/false.
    for (const key of OWNER_ONLY_KEYS) {
      expect(res.body).toHaveProperty(key);
    }
    expect(res.body.verdict_source).toBeNull();
    expect(res.body.membership_tier).toBeNull();
    expect(res.body.membership_tier_label).toBeNull();
    expect(res.body.subscription_status).toBeNull();
    expect(res.body.is_api_access_tier).toBe(false);
  });

  it('cross-org caller: shape is intact, owner-only fields are null/false', async () => {
    currentUserId = CROSS_ORG_USER_ID;
    const res = await request(app).get(endpoint);
    expect(res.status).toBe(200);
    for (const key of OWNER_ONLY_KEYS) {
      expect(res.body).toHaveProperty(key);
    }
    expect(res.body.verdict_source).toBeNull();
    expect(res.body.membership_tier).toBeNull();
    expect(res.body.membership_tier_label).toBeNull();
    expect(res.body.subscription_status).toBeNull();
    expect(res.body.is_api_access_tier).toBe(false);
  });

  it('owner caller: verdict_source + membership tier populated', async () => {
    currentUserId = OWNER_USER_ID;
    const res = await request(app).get(endpoint);
    expect(res.status).toBe(200);
    expect(res.body.verdict_source).toBe('owner_test');
    expect(res.body.membership_tier).toBe('company_standard');
    expect(res.body.subscription_status).toBe('active');
    expect(res.body.is_api_access_tier).toBe(true);
  });

  it('owner of a free-tier org still sees verdict_source (is_owner is broader than is_api_access_tier)', async () => {
    // Drop the owner org's membership tier to null so is_api_access_tier
    // computes false. The verdict_source gate is on is_owner, which is
    // true regardless of tier — Explorer-tier owners (#4378 reasoning)
    // get the UX cue.
    await pool.query(
      `UPDATE organizations SET membership_tier = NULL, subscription_status = NULL WHERE workos_organization_id = $1`,
      [OWNER_ORG_ID],
    );
    try {
      currentUserId = OWNER_USER_ID;
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(200);
      expect(res.body.verdict_source).toBe('owner_test');
      expect(res.body.is_api_access_tier).toBe(false);
      expect(res.body.membership_tier).toBeNull();
    } finally {
      // Restore for the next test if vitest re-orders.
      await pool.query(
        `UPDATE organizations SET membership_tier = 'company_standard', subscription_status = 'active' WHERE workos_organization_id = $1`,
        [OWNER_ORG_ID],
      );
    }
  });
});
