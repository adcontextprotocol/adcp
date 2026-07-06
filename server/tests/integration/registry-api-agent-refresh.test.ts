/**
 * Integration tests for POST /api/registry/agents/:encodedUrl/refresh.
 *
 * The endpoint lets an agent's owner (or an AAO admin) re-probe the agent
 * on demand and write fresh `agent_health_snapshot` / `agent_capabilities_snapshot`
 * rows. It replaces the prior pattern of either waiting for the 60-min
 * periodic crawl or hitting the (admin-only, full-fan-out) /api/crawler/run.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
 *     npx vitest run server/tests/integration/registry-api-agent-refresh.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AAO_UA_COMPLIANCE } from '../../src/config/user-agents.js';
import { HOSTED_FULL_COMPLIANCE_TIMEOUT_MS } from '../../src/services/hosted-compliance-version.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const OWNER_USER_ID = `user_test_refresh_owner_${RUN_SUFFIX}`;
const OTHER_USER_ID = `user_test_refresh_other_${RUN_SUFFIX}`;
const ADMIN_USER_ID = `user_test_refresh_admin_${RUN_SUFFIX}`;
const STATIC_ADMIN_USER_ID = 'admin_api_key';
const TEST_ORG_ID = `org_test_refresh_${RUN_SUFFIX}`;
// Each test that expects a 200 uses its own URL — the per-agent rate-limit
// closure inside the router is stateful across test cases, so reusing one
// URL would 429 the second hit. Unowned URL stays constant since no test
// expects it to succeed.
const ownedAgentUrl = (slug: string) => `https://refresh-${slug}-${RUN_SUFFIX}.example.com/mcp`;
const OTHER_AGENT_URL = `https://other-agent-${RUN_SUFFIX}.example.com/mcp`;
const ALL_OWNED_URLS = [
  ownedAgentUrl('owner'),
  ownedAgentUrl('admin'),
  ownedAgentUrl('probe-fail'),
  ownedAgentUrl('paused'),
  ownedAgentUrl('rate-limit'),
  ownedAgentUrl('saved-bearer'),
  ownedAgentUrl('canonical-saved-bearer'),
  ownedAgentUrl('badge-fanout'),
  ownedAgentUrl('static-admin'),
];

// Toggle which user the auth middleware stamps onto the request. Tests
// flip this between owner / other / admin to exercise the auth branches.
let currentUserId: string | null = OWNER_USER_ID;

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const stampUser = (req: { user?: unknown; isStaticAdminApiKey?: boolean }) => {
    if (currentUserId === null) return;
    req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
    if (currentUserId === STATIC_ADMIN_USER_ID) {
      req.isStaticAdminApiKey = true;
    }
  };
  const requireAuth = (req: { user?: unknown; isStaticAdminApiKey?: boolean }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (currentUserId === null) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    stampUser(req);
    next();
  };
  return {
    ...actual,
    requireAuth,
    optionalAuth: (req: { user?: unknown; isStaticAdminApiKey?: boolean }, _res: unknown, next: () => void) => {
      stampUser(req);
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

// Admin lookup used by the /refresh route. Default to non-admin; the
// admin test toggles it for one user id.
const isAdminMock = vi.fn(async (userId: string) => userId === ADMIN_USER_ID);
vi.mock('../../src/addie/admin-status-lookup.js', () => ({
  isWebUserAAOAdmin: (userId: string) => isAdminMock(userId),
}));

// Stub the actual probe — the test doesn't need real outbound capability
// discovery, only that the route plumbs the call through correctly. The
// type-promotion / snapshot-write logic is exercised separately by the
// crawler unit tests. We patch the prototype method directly inside the
// mock factory so any CrawlerService instance the HTTPServer constructs
// picks up the stub.
const refreshSingleAgentMock = vi.fn();
vi.mock('../../src/crawler.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/crawler.js')>('../../src/crawler.js');
  actual.CrawlerService.prototype.refreshSingleAgent = function (agentUrl: string, options?: unknown) {
    return refreshSingleAgentMock(agentUrl, options);
  };
  return actual;
});

const complyMock = vi.fn();
vi.mock('../../src/addie/services/compliance-testing.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/addie/services/compliance-testing.js')>('../../src/addie/services/compliance-testing.js');
  return {
    ...actual,
    comply: (agentUrl: string, options?: unknown) => complyMock(agentUrl, options),
  };
});

function makeComplianceResult(options: { specialisms?: string[]; storyboardId?: string } = {}) {
  const specialisms = options.specialisms ?? [];
  const storyboardId = options.storyboardId ?? 'media_buy_seller';
  return {
    overall_status: 'passing',
    total_duration_ms: 42,
    summary: {
      headline: 'All storyboards passing',
      tracks_passed: 1,
      tracks_failed: 0,
      tracks_skipped: 0,
      tracks_partial: 0,
      notices: [
        {
          severity: 'info',
          code: 'fixture_notice',
          message: 'Fixture notice',
        },
      ],
    },
    tracks: [{
      track: 'media-buy',
      status: 'pass',
      duration_ms: 42,
      scenarios: [{
        scenario: `${storyboardId}/capability_discovery`,
        overall_passed: true,
        steps: [{ step_id: 'get_adcp_capabilities', passed: true }],
      }],
    }],
    observations: [
      {
        category: 'best_practice',
        severity: 'suggestion',
        message: 'Fixture observation',
      },
    ],
    agent_profile: { specialisms },
  };
}

describe('POST /api/registry/agents/:encodedUrl/refresh (integration)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    await pool.query(
      `INSERT INTO organizations (
         workos_organization_id, name, membership_tier, subscription_status, created_at, updated_at
       )
       VALUES ($1, 'Test Refresh Org', 'company_standard', 'active', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE
         SET membership_tier = EXCLUDED.membership_tier,
             subscription_status = EXCLUDED.subscription_status,
             updated_at = NOW()`,
      [TEST_ORG_ID],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, email, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', NOW(), NOW())
       ON CONFLICT (workos_organization_id, workos_user_id) DO NOTHING`,
      [TEST_ORG_ID, OWNER_USER_ID, `${OWNER_USER_ID}@test.com`],
    );
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents, created_at, updated_at)
       VALUES ($1, 'Test Refresh Org', $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET agents = EXCLUDED.agents, updated_at = NOW()`,
      [
        TEST_ORG_ID,
        `test-refresh-${RUN_SUFFIX}`,
        JSON.stringify(ALL_OWNED_URLS.map(u => ({ url: u, name: 'Test agent' }))),
      ],
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    const allUrls = [...ALL_OWNED_URLS, OTHER_AGENT_URL];
    await pool.query('DELETE FROM agent_verification_badges WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_step_diagnostics WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_storyboard_status WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_status WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_runs WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_health_snapshot WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_capabilities_snapshot WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(() => {
    currentUserId = OWNER_USER_ID;
    isAdminMock.mockClear();
    refreshSingleAgentMock.mockReset();
    refreshSingleAgentMock.mockResolvedValue({
      online: true,
      tools_count: 4,
      response_time_ms: 120,
      inferred_type: 'governance',
      type_promoted: true,
      oauth_required: false,
      checked_at: new Date().toISOString(),
    });
    complyMock.mockReset();
    complyMock.mockResolvedValue(makeComplianceResult());
  });

  const url = (agentUrl: string) => `/api/registry/agents/${encodeURIComponent(agentUrl)}/refresh`;

  it('owner can refresh and gets the snapshot back', async () => {
    const agentUrl = ownedAgentUrl('owner');
    const res = await request(app).post(url(agentUrl)).send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      online: true,
      tools_count: 4,
      inferred_type: 'governance',
      type_promoted: true,
      compliance: {
        ran: true,
        run_id: expect.any(String),
        test_session_id: expect.stringMatching(/^owner-refresh-\d+-[0-9a-f-]{36}$/),
        overall_status: 'passing',
        storyboards_passing: 1,
        storyboards_total: 1,
        observations_count: 1,
        notices_count: 1,
      },
    });
    expect(refreshSingleAgentMock).toHaveBeenCalledWith(agentUrl, expect.any(Object));
    expect(complyMock).toHaveBeenCalledWith(
      agentUrl,
      expect.objectContaining({
        timeout_ms: HOSTED_FULL_COMPLIANCE_TIMEOUT_MS,
        userAgent: AAO_UA_COMPLIANCE,
        test_session_id: expect.stringMatching(/^owner-refresh-\d+-[0-9a-f-]{36}$/),
      }),
    );

    const latestRun = await pool.query(
      `SELECT triggered_by, triggered_org_id
       FROM agent_compliance_runs
       WHERE agent_url = $1
       ORDER BY tested_at DESC
       LIMIT 1`,
      [agentUrl],
    );
    expect(latestRun.rows[0]).toMatchObject({
      triggered_by: 'owner_test',
      triggered_org_id: TEST_ORG_ID,
    });
  });

  it('admin can refresh an agent they do not own', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('admin');
    const res = await request(app).post(url(agentUrl)).send();
    expect(res.status).toBe(200);
    expect(refreshSingleAgentMock).toHaveBeenCalledWith(agentUrl, expect.any(Object));
  });

  it('static admin API key can refresh and rerun compliance for an agent it does not own', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('static-admin');

    const res = await request(app).post(url(agentUrl)).send();

    expect(res.status).toBe(200);
    expect(res.body.compliance).toMatchObject({
      ran: true,
      overall_status: 'passing',
      storyboards_passing: 1,
      storyboards_total: 1,
    });
    expect(refreshSingleAgentMock).toHaveBeenCalledWith(agentUrl, expect.any(Object));
    expect(complyMock).toHaveBeenCalledWith(
      agentUrl,
      expect.objectContaining({
        timeout_ms: HOSTED_FULL_COMPLIANCE_TIMEOUT_MS,
        userAgent: AAO_UA_COMPLIANCE,
      }),
    );

    const latestRun = await pool.query(
      `SELECT triggered_by, triggered_org_id
       FROM agent_compliance_runs
       WHERE agent_url = $1
       ORDER BY tested_at DESC
       LIMIT 1`,
      [agentUrl],
    );
    expect(latestRun.rows[0]).toMatchObject({
      triggered_by: 'manual',
      triggered_org_id: null,
    });
  });

  it('non-owner non-admin gets 403', async () => {
    currentUserId = OTHER_USER_ID;
    const res = await request(app).post(url(OTHER_AGENT_URL)).send();
    expect(res.status).toBe(403);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
  });

  it('unauthenticated request gets 401', async () => {
    currentUserId = null;
    const res = await request(app).post(url(ownedAgentUrl('owner'))).send();
    expect(res.status).toBe(401);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed agent URL', async () => {
    const res = await request(app).post(url('not-a-valid-url')).send();
    expect(res.status).toBe(400);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a private-IP URL (SSRF guard)', async () => {
    const res = await request(app).post(url('http://169.254.169.254/mcp')).send();
    expect(res.status).toBe(400);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the probe throws', async () => {
    refreshSingleAgentMock.mockRejectedValue(new Error('Probe timeout'));
    const res = await request(app).post(url(ownedAgentUrl('probe-fail'))).send();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Probe timeout/);
  });

  it('returns 409 when monitoring is paused', async () => {
    refreshSingleAgentMock.mockRejectedValue(new Error('Monitoring paused for this agent'));
    const res = await request(app).post(url(ownedAgentUrl('paused'))).send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Monitoring paused/);
  });

  it('rate-limits a second refresh of the same agent within the window', async () => {
    const agentUrl = ownedAgentUrl('rate-limit');
    const first = await request(app).post(url(agentUrl)).send();
    expect(first.status).toBe(200);

    const second = await request(app).post(url(agentUrl)).send();
    expect(second.status).toBe(429);
    expect(second.body.retry_after).toBeGreaterThan(0);
  });

  // Regression: dashboard probe was constructing AdCPClient with no auth,
  // so any agent gated behind a static bearer reported "OAuth required"
  // even though evaluate_agent_quality (which resolves saved auth) worked
  // fine. The route now resolves owner-org auth and threads it to the
  // crawler so the probe sees the same credentials.
  it('threads the org-saved bearer token to the crawler', async () => {
    const agentUrl = ownedAgentUrl('saved-bearer');
    const { AgentContextDatabase } = await import('../../src/db/agent-context-db.js');
    const db = new AgentContextDatabase();
    const context = await db.create({
      organization_id: TEST_ORG_ID,
      agent_url: agentUrl,
      created_by: OWNER_USER_ID,
    });
    const FAKE_BEARER = 'fake-test-bearer-do-not-use-in-prod';
    await db.saveAuthToken(context.id, FAKE_BEARER, 'bearer');

    try {
      const res = await request(app).post(url(agentUrl)).send();
      expect(res.status).toBe(200);
      expect(refreshSingleAgentMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({
          auth: { type: 'bearer', token: FAKE_BEARER },
          ownerOrgId: TEST_ORG_ID,
        }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('canonicalizes the requested URL before owner auth lookup and probe', async () => {
    const agentUrl = ownedAgentUrl('canonical-saved-bearer');
    const requestedUrl = agentUrl
      .replace('https://', 'HTTPS://')
      .replace('.example.com', '.EXAMPLE.COM') + '/';
    const { AgentContextDatabase } = await import('../../src/db/agent-context-db.js');
    const db = new AgentContextDatabase();
    const context = await db.create({
      organization_id: TEST_ORG_ID,
      agent_url: agentUrl,
      created_by: OWNER_USER_ID,
    });
    const FAKE_BEARER = 'fake-canonical-bearer-do-not-use-in-prod';
    await db.saveAuthToken(context.id, FAKE_BEARER, 'bearer');

    try {
      const res = await request(app).post(url(requestedUrl)).send();
      expect(res.status).toBe(200);
      expect(refreshSingleAgentMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({
          auth: { type: 'bearer', token: FAKE_BEARER },
          ownerOrgId: TEST_ORG_ID,
        }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('fans out badge issuance for an owner refresh with a passing specialism', async () => {
    const agentUrl = ownedAgentUrl('badge-fanout');
    complyMock.mockResolvedValueOnce(makeComplianceResult({
      specialisms: ['sales-broadcast-tv'],
      storyboardId: 'sales_broadcast_tv',
    }));

    const res = await request(app).post(url(agentUrl)).send();

    expect(res.status).toBe(200);
    expect(res.body.compliance).toMatchObject({
      ran: true,
      storyboards_passing: 1,
      storyboards_total: 1,
    });

    const badges = await pool.query(
      `SELECT role, status, verified_specialisms, membership_org_id
       FROM agent_verification_badges
       WHERE agent_url = $1
       ORDER BY role`,
      [agentUrl],
    );
    expect(badges.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'media-buy',
        status: 'active',
        verified_specialisms: ['sales-broadcast-tv'],
        membership_org_id: TEST_ORG_ID,
      }),
    ]));
  });
});
