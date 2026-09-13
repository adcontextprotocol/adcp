/**
 * Integration tests for POST /api/registry/agents/:encodedUrl/refresh.
 *
 * Human refresh requests persist and recheck exact credential provenance.
 * Static-admin and legacy unproven queue rows must fail before probing,
 * resolving secrets, recovering runs, or publishing evidence.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
 *     npx vitest run server/tests/integration/registry-api-agent-refresh.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AAO_UA_COMPLIANCE } from '../../src/config/user-agents.js';
import { HOSTED_FULL_COMPLIANCE_TIMEOUT_MS } from '../../src/services/hosted-compliance-version.js';
import {
  ComplianceRefreshRequestsDatabase,
  type ComplianceRefreshRequestStatus,
} from '../../src/db/compliance-refresh-requests-db.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { complianceRunProvenance } from '../../src/compliance/run-provenance.js';
import type { ComplianceResult, ComplyOptions } from '@adcp/sdk/testing';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';
import { isRefreshAdmin } from '../../src/services/compliance-refresh-authorization.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_registry_refresh';
  process.env.WORKOS_CLIENT_ID ??= 'client_test_registry_refresh';
});

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const OWNER_USER_ID = `user_test_refresh_owner_${RUN_SUFFIX}`;
const OTHER_USER_ID = `user_test_refresh_other_${RUN_SUFFIX}`;
const ADMIN_USER_ID = `user_test_refresh_admin_${RUN_SUFFIX}`;
const STATIC_ADMIN_USER_ID = 'admin_api_key';
const TEST_ORG_ID = `org_test_refresh_${RUN_SUFFIX}`;
const SECOND_ORG_ID = `org_test_refresh_second_${RUN_SUFFIX}`;
// Each test that expects a 200 uses its own URL — the per-agent rate-limit
// closure inside the router is stateful across test cases, so reusing one
// URL would 429 the second hit. Unowned URL stays constant since no test
// expects it to succeed.
const ownedAgentUrl = (slug: string) => `https://refresh-${slug}-${RUN_SUFFIX}.example.com/mcp`;
const OTHER_AGENT_URL = `https://other-agent-${RUN_SUFFIX}.example.com/mcp`;
const ALL_OWNED_URLS = [
  ownedAgentUrl('owner'),
  ownedAgentUrl('admin'),
  ownedAgentUrl('linked-owner'),
  ownedAgentUrl('owner-admin-outage'),
  ownedAgentUrl('probe-fail'),
  ownedAgentUrl('paused'),
  ownedAgentUrl('rate-limit'),
  ownedAgentUrl('saved-bearer'),
  ownedAgentUrl('canonical-saved-bearer'),
  ownedAgentUrl('badge-fanout'),
  ownedAgentUrl('static-admin'),
  ownedAgentUrl('applicable-oauth'),
  ownedAgentUrl('selected-org-refresh'),
  ownedAgentUrl('selected-org-challenge'),
  ownedAgentUrl('public-notices'),
  ownedAgentUrl('admin-auth-fallback'),
  ownedAgentUrl('async-refresh'),
  ownedAgentUrl('refresh-recovery'),
  ownedAgentUrl('refresh-recovery-timed_out'),
  ownedAgentUrl('badge-retry'),
  ownedAgentUrl('badge-retry-exhausted'),
  ownedAgentUrl('legacy-timeout'),
  ownedAgentUrl('targeted-complete'),
  ownedAgentUrl('targeted-timed_out'),
  ownedAgentUrl('linked-admin'),
  ownedAgentUrl('deleted-credential'),
  ownedAgentUrl('mismatched-credential'),
  ownedAgentUrl('break-glass-email-changed'),
  ownedAgentUrl('break-glass-email-current'),
  ownedAgentUrl('authorization-outage'),
  ownedAgentUrl('authorization-exhausted'),
  ownedAgentUrl('legacy-provenance'),
  ownedAgentUrl('admission-epoch-race'),
  ownedAgentUrl('comply-epoch-revoked'),
  ownedAgentUrl('comply-membership-revoked'),
  ownedAgentUrl('polling-credential-deleted'),
  ownedAgentUrl('polling-credential-mismatched'),
  ownedAgentUrl('polling-credential-outage'),
];

// Toggle which user the auth middleware stamps onto the request. Tests
// flip this between owner / other / admin to exercise the auth branches.
let currentUserId: string | null = OWNER_USER_ID;
let currentAuthWorkosUserId: string | undefined;
let currentIsAdmin: boolean | undefined;
let currentUserEmail: string | undefined;

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const stampUser = (req: { user?: unknown; isStaticAdminApiKey?: boolean }) => {
    if (currentUserId === null) return;
    const currentRequestUser = {
      id: currentUserId, authWorkosUserId: currentAuthWorkosUserId,
      email: currentUserEmail ?? `${currentAuthWorkosUserId ?? currentUserId}@test.com`,
      isAdmin: currentIsAdmin,
    };
    req.user = currentRequestUser;
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
const isAdminMock = vi.fn(async (principal: { id: string; authWorkosUserId?: string }) => (principal.authWorkosUserId ?? principal.id) === ADMIN_USER_ID);
vi.mock('../../src/addie/admin-status-lookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/admin-status-lookup.js')>()),
  isWebUserAAOAdmin: (userId: string) => isAdminMock({ id: userId }),
  isAuthenticatedUserAAOAdmin: (principal: { id: string; authWorkosUserId?: string }) => isAdminMock(principal),
}));

const { getWorkosUserMock } = vi.hoisted(() => ({
  getWorkosUserMock: vi.fn(),
}));
vi.mock('../../src/auth/workos-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/workos-client.js')>('../../src/auth/workos-client.js');
  return {
    ...actual,
    getAuthorizationEnforcementWorkos: () => ({
      userManagement: { getUser: getWorkosUserMock },
    }),
  };
});

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

const { testCapabilityDiscoveryMock } = vi.hoisted(() => ({
  testCapabilityDiscoveryMock: vi.fn(),
}));
vi.mock('@adcp/sdk/testing', async () => {
  const actual = await vi.importActual<typeof import('@adcp/sdk/testing')>('@adcp/sdk/testing');
  return {
    ...actual,
    testCapabilityDiscovery: (agentUrl: string, options?: unknown) =>
      testCapabilityDiscoveryMock(agentUrl, options),
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
    },
    notices: [
      {
        severity: 'info',
        code: 'fixture_notice',
        message: 'Fixture notice',
        capability_pointer: '/account/supported_billing/0',
        docs_url: 'https://example.com/adcp/fixture-notice',
        storyboard_ids: [storyboardId],
        future_runner_field: { remediation: 'Update the declared billing mode.' },
      },
    ],
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
    agent_profile: { specialisms, adcp_supported_versions: ['3.0'] },
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

    for (const userId of [OWNER_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]) {
      await pool.query(
        'INSERT INTO users (workos_user_id, email) VALUES ($1, $2)',
        [userId, `${userId}@test.com`],
      );
    }
    await pool.query(
      `INSERT INTO working_groups (name, slug, status)
       VALUES ('AAO administrators', 'aao-admin', 'active') ON CONFLICT (slug) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       SELECT id, $1, 'active' FROM working_groups WHERE slug = 'aao-admin'`,
      [ADMIN_USER_ID],
    );

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
    await pool.query(
      `INSERT INTO organizations (
         workos_organization_id, name, membership_tier, subscription_status, created_at, updated_at
       )
       VALUES ($1, 'Second Refresh Org', 'company_standard', 'active', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE
         SET membership_tier = EXCLUDED.membership_tier,
             subscription_status = EXCLUDED.subscription_status,
             updated_at = NOW()`,
      [SECOND_ORG_ID],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, email, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'admin', NOW(), NOW())
       ON CONFLICT (workos_organization_id, workos_user_id) DO NOTHING`,
      [SECOND_ORG_ID, OWNER_USER_ID, `${OWNER_USER_ID}@test.com`],
    );
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents, created_at, updated_at)
       VALUES ($1, 'Second Refresh Org', $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET agents = EXCLUDED.agents, updated_at = NOW()`,
      [
        SECOND_ORG_ID,
        `test-refresh-second-${RUN_SUFFIX}`,
        JSON.stringify([
          { url: ownedAgentUrl('selected-org-refresh'), name: 'Shared refresh agent' },
          { url: ownedAgentUrl('selected-org-challenge'), name: 'Shared challenge agent' },
        ]),
      ],
    );

    server = new HTTPServer({
      backgroundServices: 'refresh-only',
      refreshQueueIntervalMs: 25,
      refreshLegacyWaitMs: 10_000,
      refreshPollIntervalMs: 25,
    });
    await server.start(0);
    app = server.app;
  }, 120_000);

  afterAll(async () => {
    const allUrls = [...ALL_OWNED_URLS, OTHER_AGENT_URL];
    await pool.query('DELETE FROM agent_verification_badges WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_step_diagnostics WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_storyboard_status WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_status WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_runs WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_health_snapshot WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_capabilities_snapshot WHERE agent_url = ANY($1)', [allUrls]);
    await pool.query('DELETE FROM agent_contexts WHERE organization_id = ANY($1)', [[TEST_ORG_ID, SECOND_ORG_ID]]);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = ANY($1)', [[TEST_ORG_ID, SECOND_ORG_ID]]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [[TEST_ORG_ID, SECOND_ORG_ID]]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [[TEST_ORG_ID, SECOND_ORG_ID]]);
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [[OWNER_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[OWNER_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]]);
    await server?.stop();
    await closeDatabase();
  }, 120_000);

  beforeEach(async () => {
    currentUserId = OWNER_USER_ID;
    currentAuthWorkosUserId = undefined;
    currentIsAdmin = undefined;
    isAdminMock.mockReset();
    isAdminMock.mockImplementation(async (principal: { id: string; authWorkosUserId?: string }) => (principal.authWorkosUserId ?? principal.id) === ADMIN_USER_ID);
    currentUserEmail = undefined;
    currentIsAdmin = false;
    // Queue authorization must read exact persisted membership rather than
    // trusting presentation-layer isAdmin flags or canonical identities.
    await pool.query('DELETE FROM authorization_epochs WHERE workos_user_id = ANY($1)', [[OWNER_USER_ID, OTHER_USER_ID, ADMIN_USER_ID]]);
    getWorkosUserMock.mockReset();
    getWorkosUserMock.mockImplementation(async (id: string) => ({ id, email: `${id}@test.com` }));
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
    testCapabilityDiscoveryMock.mockReset();
    testCapabilityDiscoveryMock.mockResolvedValue({
      profile: {
        name: 'OAuth test agent',
        tools: [],
        supported_protocols: ['media_buy'],
        specialisms: [],
        adcp_supported_versions: ['3.0'],
      },
      steps: [{ step: 'Discover agent profile', passed: true, duration_ms: 1 }],
    });
  });

  const url = (agentUrl: string) => `/api/registry/agents/${encodeURIComponent(agentUrl)}/refresh`;
  const refreshDb = new ComplianceRefreshRequestsDatabase();
  const withLinkedCredential = async (canonicalId: string, credentialId: string, test: () => Promise<void>) => {
    const original = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1',
      [credentialId],
    );
    await pool.query(
      `UPDATE identity_workos_users SET identity_id = (
         SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
       ), is_primary = FALSE WHERE workos_user_id = $2`,
      [canonicalId, credentialId],
    );
    try {
      await test();
    } finally {
      await pool.query(
        'UPDATE identity_workos_users SET identity_id = $1, is_primary = TRUE WHERE workos_user_id = $2',
        [original.rows[0].identity_id, credentialId],
      );
    }
  };
  const waitForOperation = async (
    operationId: string,
    status: ComplianceRefreshRequestStatus,
    errorCode?: string,
  ) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const operation = await refreshDb.getById(operationId);
      if (operation?.status === status && (!errorCode || operation.last_error_code === errorCode)) {
        return operation;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Refresh did not reach ${status}${errorCode ? ` (${errorCode})` : ''}`);
  };

  it.each(['complete', 'timed_out'] as const)('reports targeted %s runs as audit-only with provenance and no diagnostics', async completeness => {
    const agentUrl = ownedAgentUrl(`targeted-${completeness}`);
    complyMock.mockImplementation(async (_url: string, options: ComplyOptions) => {
      const result = { ...makeComplianceResult(), completeness, adcp_version: '3.0.22' } as unknown as ComplianceResult;
      return { ...result, hosted_provenance: complianceRunProvenance(result, options) };
    });
    const res = await request(app).post(`/api/registry/agents/${encodeURIComponent(agentUrl)}/storyboard/media_buy_seller/run`).send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ completeness, is_authoritative: false, badge_eligible: false,
      badge_eligible_adcp_versions: [], diagnostics: [],
      provenance: { sdk_version: '14.0.0-rc.33', test_session_id: expect.any(String), agent_build_version: null },
    });
    expect(complyMock.mock.calls[0][1].test_session_id).toBe(res.body.provenance.test_session_id);
    const db = new ComplianceDatabase();
    expect(await db.getComplianceStatus(agentUrl)).toBeNull();
    expect(await db.getBadgesForAgent(agentUrl)).toEqual([]);
    expect((await db.getComplianceRun(agentUrl, res.body.run_id))?.provenance_json?.test_session_id)
      .toBe(res.body.provenance.test_session_id);
  });

  it('authenticated administrator can refresh and gets the snapshot back', async () => {
    currentUserId = ADMIN_USER_ID;
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
        test_session_id: expect.stringMatching(/^owner-refresh-[0-9a-f-]{36}$/),
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
        test_session_id: expect.stringMatching(/^owner-refresh-[0-9a-f-]{36}$/),
      }),
    );

    const latestRun = await pool.query(
      `SELECT triggered_by, triggered_org_id, notices_json
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
    expect(latestRun.rows[0].notices_json).toEqual([{
      severity: 'info',
      code: 'fixture_notice',
      message: 'Fixture notice',
      capability_pointer: '/account/supported_billing/0',
      docs_url: 'https://example.com/adcp/fixture-notice',
      storyboard_ids: ['media_buy_seller'],
      future_runner_field: { remediation: 'Update the declared billing mode.' },
    }]);

    const publicCompliance = await request(app)
      .get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/compliance`)
      .send();
    expect(publicCompliance.status).toBe(200);
    expect(publicCompliance.body.notices).toEqual([{
      severity: 'info',
      code: 'fixture_notice',
      message: 'Fixture notice',
      capability_pointer: '/account/supported_billing/0',
    }]);
    expect(publicCompliance.body.notices[0]).not.toHaveProperty('docs_url');
    expect(publicCompliance.body.notices[0]).not.toHaveProperty('storyboard_ids');
    expect(publicCompliance.body.notices[0]).not.toHaveProperty('future_runner_field');
  });

  it('public compliance bounds notice output while retaining the raw private record', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('public-notices');
    const refresh = await request(app).post(url(agentUrl)).send();
    expect(refresh.status).toBe(200);

    const rawNotices = [
      {
        severity: 'future_custom_severity',
        code: 'future_custom_code',
        message: '😀'.repeat(700),
        effective_version: 'v'.repeat(100),
        requirement: 'r'.repeat(700),
        capability_path: 'p'.repeat(700),
        capability_pointer: `/${'x'.repeat(1_100)}`,
        reference_url: 'javascript:alert(1)',
        experimental_context: { secret: 'private runner state' },
      },
      ...Array.from({ length: 54 }, (_, index) => ({
        severity: 'info',
        code: `bounded_notice_${index}`,
        message: `Notice ${index}`,
        ...(index === 0
          ? { reference_url: 'https://example.com/docs?version=4#notice' }
          : {}),
      })),
    ];
    await pool.query(
      `UPDATE agent_compliance_runs
       SET notices_json = $2::jsonb
       WHERE id = (
         SELECT id FROM agent_compliance_runs
         WHERE agent_url = $1
         ORDER BY tested_at DESC
         LIMIT 1
       )`,
      [agentUrl, JSON.stringify(rawNotices)],
    );

    currentUserId = null;
    const publicCompliance = await request(app)
      .get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/compliance`)
      .send();
    expect(publicCompliance.status).toBe(200);
    expect(publicCompliance.body.notices).toHaveLength(50);
    expect(publicCompliance.body.notices[0]).toMatchObject({
      severity: 'future_custom_severity',
      code: 'future_custom_code',
    });
    expect(publicCompliance.body.notices[0].message.length).toBeLessThanOrEqual(1_000);
    expect(publicCompliance.body.notices[0].effective_version.length).toBeLessThanOrEqual(64);
    expect(publicCompliance.body.notices[0].requirement.length).toBeLessThanOrEqual(500);
    expect(publicCompliance.body.notices[0].capability_path.length).toBeLessThanOrEqual(512);
    expect(publicCompliance.body.notices[0].capability_pointer.length).toBeLessThanOrEqual(1_024);
    expect(publicCompliance.body.notices[0]).not.toHaveProperty('reference_url');
    expect(publicCompliance.body.notices[0]).not.toHaveProperty('experimental_context');
    expect(publicCompliance.body.notices[1].reference_url).toBe(
      'https://example.com/docs?version=4#notice',
    );

    const stored = await pool.query<{ notices_json: unknown[] }>(
      `SELECT notices_json
       FROM agent_compliance_runs
       WHERE agent_url = $1
       ORDER BY tested_at DESC
       LIMIT 1`,
      [agentUrl],
    );
    expect(stored.rows[0].notices_json).toHaveLength(55);
    expect(stored.rows[0].notices_json[0]).toHaveProperty('experimental_context');
  });

  it.each([
    ['owner', OWNER_USER_ID],
    ['admin', ADMIN_USER_ID],
  ])('does not inherit a linked canonical %s credential at admission', async (_role, canonicalId) => {
    currentUserId = canonicalId;
    currentAuthWorkosUserId = OTHER_USER_ID;
    currentIsAdmin = true;

    await withLinkedCredential(canonicalId, OTHER_USER_ID, async () => {
      const res = await request(app).post(url(ownedAgentUrl('linked-owner'))).send();

      expect(res.status).toBe(403);
      expect(getWorkosUserMock).toHaveBeenCalledWith(OTHER_USER_ID);
      expect(getWorkosUserMock.mock.calls.every(([id]) => id === OTHER_USER_ID)).toBe(true);
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    [ADMIN_USER_ID, OTHER_USER_ID, false],
    [OTHER_USER_ID, ADMIN_USER_ID, true],
  ])('checks raw administrator membership with canonical %s and authenticated %s', async (canonicalId, credentialId, authorized) => {
    await withLinkedCredential(canonicalId, credentialId, async () => {
      await expect(isRefreshAdmin({ id: canonicalId, authWorkosUserId: credentialId }))
        .resolves.toBe(authorized);
      expect(getWorkosUserMock).toHaveBeenCalledWith(credentialId);
    });
  });

  it.each([
    ['owner', OWNER_USER_ID, 'owner_test'],
    ['admin', ADMIN_USER_ID, 'manual'],
  ])('retains the authenticated %s credential through admission, execution, and polling', async (role, authenticatedId, triggeredBy) => {
    const agentUrl = ownedAgentUrl(`linked-${role}`);
    currentUserId = OTHER_USER_ID;
    currentAuthWorkosUserId = authenticatedId;

    await withLinkedCredential(OTHER_USER_ID, authenticatedId, async () => {
      const accepted = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();
      expect(accepted.status).toBe(202);
      const operation = await waitForOperation(accepted.body.refresh_operation_id, 'succeeded');
      expect(operation).toMatchObject({
        requester_type: 'user',
        requested_by_user_id: authenticatedId,
        requested_by_auth_workos_user_id: authenticatedId,
        authorization_fingerprint: '',
        triggered_by: triggeredBy,
      });
      expect(getWorkosUserMock).toHaveBeenCalledWith(authenticatedId);
      expect(getWorkosUserMock.mock.calls.every(([id]) => id === authenticatedId)).toBe(true);
      expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
      expect(complyMock).toHaveBeenCalledOnce();

      for (const canonicalId of [OWNER_USER_ID, ADMIN_USER_ID]) {
        currentUserId = canonicalId;
        currentAuthWorkosUserId = OTHER_USER_ID;
        currentIsAdmin = true;
        const forbidden = await request(app).get(accepted.body.status_url).send();
        expect(forbidden.status).toBe(404);
      }

      currentUserId = OTHER_USER_ID;
      currentAuthWorkosUserId = authenticatedId;
      currentIsAdmin = false;
      const completed = await request(app).get(accepted.body.status_url).send();
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe('succeeded');
    });
  });

  it.each(['deleted', 'mismatched'])('rejects a %s authenticated WorkOS credential at execution before probing', async (state) => {
    const agentUrl = ownedAgentUrl(`${state}-credential`);
    currentUserId = OTHER_USER_ID;
    currentAuthWorkosUserId = OWNER_USER_ID;
    getWorkosUserMock.mockResolvedValueOnce({ id: OWNER_USER_ID, email: `${OWNER_USER_ID}@test.com` });
    if (state === 'deleted') {
      getWorkosUserMock.mockRejectedValue(Object.assign(new Error('WorkOS user no longer exists'), { status: 404 }));
    } else {
      getWorkosUserMock.mockResolvedValue({ id: OTHER_USER_ID, email: `${OWNER_USER_ID}@test.com` });
    }

    const res = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();

    expect(res.status).toBe(202);
    const operation = await waitForOperation(
      res.body.refresh_operation_id,
      'failed',
      'authorization_revoked',
    );
    expect(getWorkosUserMock.mock.calls).toEqual([[OWNER_USER_ID], [OWNER_USER_ID]]);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    expect(operation).toMatchObject({
      status: 'failed', attempts: 1, result_json: null, last_error_code: 'authorization_revoked',
    });
    const status = await request(app).get(res.body.status_url).send();
    expect(status.body).toMatchObject({
      status: 'failed', attempts: 1, result: null, error: { code: 'authorization_revoked' },
    });
  });

  it.each([
    ['deleted', 404, 403, 'authorization_revoked'],
    ['mismatched', null, 403, 'authorization_revoked'],
    ['outage', 503, 503, 'authorization_unavailable'],
  ])('preserves %s credential semantics when an administrator polls a manual refresh', async (state, workosStatus, httpStatus, code) => {
    const agentUrl = ownedAgentUrl(`polling-credential-${state}`);
    currentUserId = OTHER_USER_ID;
    currentAuthWorkosUserId = ADMIN_USER_ID;
    const accepted = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();
    expect(accepted.status).toBe(202);
    await waitForOperation(accepted.body.refresh_operation_id, 'succeeded');
    getWorkosUserMock.mockClear();
    if (state === 'mismatched') {
      getWorkosUserMock.mockResolvedValue({ id: OTHER_USER_ID, email: `${ADMIN_USER_ID}@test.com` });
    } else {
      getWorkosUserMock.mockRejectedValue(Object.assign(new Error('Private WorkOS failure detail'), { status: workosStatus }));
    }

    const status = await request(app).get(accepted.body.status_url).send();
    expect(status.status).toBe(httpStatus);
    expect(status.body.code).toBe(code);
    expect(status.headers['retry-after']).toBe(httpStatus === 503 ? '5' : undefined);
    expect(JSON.stringify(status.body)).not.toContain('Private WorkOS failure detail');
    expect(getWorkosUserMock).toHaveBeenCalledExactlyOnceWith(ADMIN_USER_ID);
  });

  it.each([
    ['changed', 'ordinary@test.com', 403],
    ['current', 'break-glass@test.com', 200],
  ])('uses the %s WorkOS email for break-glass despite stale local and session data', async (state, workosEmail, expectedStatus) => {
    const agentUrl = ownedAgentUrl(`break-glass-email-${state}`);
    const sessionEmail = 'break-glass@test.com';
    const localEmail = state === 'changed' ? sessionEmail : 'stale-local@test.com';
    currentUserId = ADMIN_USER_ID;
    currentAuthWorkosUserId = OTHER_USER_ID;
    currentUserEmail = sessionEmail;
    currentIsAdmin = true;
    vi.stubEnv('ADMIN_EMAILS', sessionEmail);
    getWorkosUserMock.mockResolvedValue({ id: OTHER_USER_ID, email: workosEmail });
    await pool.query(
      'UPDATE users SET email = $2 WHERE workos_user_id = $1',
      [OTHER_USER_ID, localEmail],
    );
    try {
      const res = await request(app).post(url(agentUrl)).send();

      expect(res.status).toBe(expectedStatus);
      expect(getWorkosUserMock).toHaveBeenCalledWith(OTHER_USER_ID);
      expect(getWorkosUserMock.mock.calls.every(([id]) => id === OTHER_USER_ID)).toBe(true);
      if (expectedStatus === 403) {
        expect(res.body.code).toBe('authorization_revoked');
        expect(refreshSingleAgentMock).not.toHaveBeenCalled();
        expect(complyMock).not.toHaveBeenCalled();
      } else {
        expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
        expect(complyMock).toHaveBeenCalledOnce();
      }
    } finally {
      await pool.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [OTHER_USER_ID, `${OTHER_USER_ID}@test.com`]);
      vi.unstubAllEnvs();
    }
  });

  it('retries unavailable WorkOS authorization without executing until the exact credential is verified', async () => {
    const agentUrl = ownedAgentUrl('authorization-outage');
    getWorkosUserMock
      .mockResolvedValueOnce({ id: OWNER_USER_ID, email: `${OWNER_USER_ID}@test.com` })
      .mockRejectedValueOnce(Object.assign(new Error('WorkOS unavailable'), { status: 503 }));

    const accepted = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();
    expect(accepted.status).toBe(202);
    const retrying = await waitForOperation(accepted.body.refresh_operation_id, 'queued', 'authorization_unavailable');
    expect(retrying.attempts).toBe(1);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    const pending = await request(app).get(accepted.body.status_url).send();
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ status: 'queued', attempts: 1, result: null });

    await pool.query('UPDATE agent_compliance_refresh_requests SET available_at = NOW() WHERE id = $1', [retrying.id]);
    const completed = await waitForOperation(retrying.id, 'succeeded');
    expect(completed.attempts).toBe(2);
    expect(getWorkosUserMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(getWorkosUserMock.mock.calls.every(([id]) => id === OWNER_USER_ID)).toBe(true);
    expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
    expect(complyMock).toHaveBeenCalledOnce();
  });

  it('preserves authorization unavailable after retry exhaustion in polling and repeated POST responses', async () => {
    const agentUrl = ownedAgentUrl('authorization-exhausted');
    getWorkosUserMock
      .mockResolvedValueOnce({ id: OWNER_USER_ID, email: `${OWNER_USER_ID}@test.com` })
      .mockRejectedValue(Object.assign(new Error('Internal WorkOS outage detail'), { status: 503 }));

    const accepted = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();
    expect(accepted.status).toBe(202);
    const retrying = await waitForOperation(
      accepted.body.refresh_operation_id,
      'queued',
      'authorization_unavailable',
    );
    await pool.query(
      'UPDATE agent_compliance_refresh_requests SET available_at = NOW() WHERE id = $1',
      [retrying.id],
    );
    await waitForOperation(retrying.id, 'failed', 'authorization_unavailable');

    const status = await request(app).get(accepted.body.status_url).send();
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      status: 'failed',
      attempts: 2,
      result: null,
      error: { code: 'authorization_unavailable' },
    });
    expect(JSON.stringify(status.body)).not.toContain('Internal WorkOS outage detail');

    const repeated = await request(app).post(url(agentUrl)).send();
    expect(repeated.status).toBe(503);
    expect(repeated.body.code).toBe('authorization_unavailable');
    expect(getWorkosUserMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(getWorkosUserMock.mock.calls.every(([id]) => id === OWNER_USER_ID)).toBe(true);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
  });

  it('preserves public missing-provenance rejection and permits a fresh valid resubmission', async () => {
    const agentUrl = ownedAgentUrl('legacy-provenance');
    const operationId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agent_compliance_refresh_requests
           (id, agent_url, owner_org_id, requester_type, requested_by_user_id,
            requested_by_auth_workos_user_id, authorization_fingerprint, triggered_by, test_session_id)
         VALUES ($1, $2, $3, 'user', $4, $4, '', 'owner_test', $5)`,
        [operationId, agentUrl, TEST_ORG_ID, OWNER_USER_ID, `owner-refresh-${operationId}`],
      );
      await client.query(
        `UPDATE agent_compliance_refresh_requests
         SET status = 'failed', last_error_code = 'authorization_provenance_missing', completed_at = NOW()
         WHERE id = $1`,
        [operationId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const rejected = await waitForOperation(operationId, 'failed', 'authorization_provenance_missing');
    // Actual pre-migration NULL conversion/rejection is covered by the
    // migration fixture; post-migration rows cannot contain NULL provenance.
    expect(rejected.requested_by_auth_workos_user_id).toBe(OWNER_USER_ID);
    expect(getWorkosUserMock).not.toHaveBeenCalled();
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    const status = await request(app)
      .get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/refreshes/${operationId}`)
      .send();
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      status: 'failed',
      error: { code: 'authorization_provenance_missing' },
    });

    const fresh = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();
    expect(fresh.status).toBe(202);
    expect(fresh.body.refresh_operation_id).not.toBe(operationId);
    expect(fresh.body.coalesced).toBe(false);
    const completed = await waitForOperation(fresh.body.refresh_operation_id, 'succeeded');
    expect(completed.requested_by_auth_workos_user_id).toBe(OWNER_USER_ID);
    expect(getWorkosUserMock).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(getWorkosUserMock.mock.calls.every(([id]) => id === OWNER_USER_ID)).toBe(true);
    expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
    expect(complyMock).toHaveBeenCalledOnce();
  });

  it('rejects an epoch change during admission before enqueueing or resolving saved credentials', async () => {
    const agentUrl = ownedAgentUrl('admission-epoch-race');
    const resolveOwnerAuth = vi.spyOn(ComplianceDatabase.prototype, 'resolveOwnerAuth');
    getWorkosUserMock.mockImplementationOnce(async (id: string) => {
      await bumpAuthorizationEpochs(pool, [id]);
      return { id, email: `${id}@test.com` };
    });
    try {
      const response = await request(app).post(url(agentUrl)).send();
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('authorization_revoked');
      expect(resolveOwnerAuth).not.toHaveBeenCalled();
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
      const queued = await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl]);
      expect(queued.rows).toEqual([]);
    } finally {
      resolveOwnerAuth.mockRestore();
    }
  });

  it.each(['epoch', 'membership'])('rejects %s revocation while comply is pending without canonical writes or success', async (revocation) => {
    const agentUrl = ownedAgentUrl(`comply-${revocation}-revoked`);
    let releaseCompliance!: (value: ReturnType<typeof makeComplianceResult>) => void;
    let complianceStarted!: () => void;
    const started = new Promise<void>(resolve => { complianceStarted = resolve; });
    complyMock.mockImplementationOnce(() => {
      complianceStarted();
      return new Promise(resolve => { releaseCompliance = resolve; });
    });
    const result = makeComplianceResult({ specialisms: ['sales-broadcast-tv'], storyboardId: 'sales_broadcast_tv' });
    try {
      const accepted = await request(app).post(url(agentUrl)).set('Prefer', 'respond-async').send();
      expect(accepted.status).toBe(202);
      await started;
      if (revocation === 'epoch') {
        await bumpAuthorizationEpochs(pool, [OWNER_USER_ID]);
      } else {
        await pool.query(
          'DELETE FROM organization_memberships WHERE workos_organization_id = $1 AND workos_user_id = $2',
          [TEST_ORG_ID, OWNER_USER_ID],
        );
      }
      releaseCompliance(result);
      const failed = await waitForOperation(accepted.body.refresh_operation_id, 'failed', 'authorization_revoked');
      expect(failed).toMatchObject({ attempts: 1, result_json: null });
      for (const table of ['agent_compliance_runs', 'agent_compliance_status', 'agent_storyboard_status', 'agent_verification_badges']) {
        const stored = await pool.query(`SELECT agent_url FROM ${table} WHERE agent_url = $1`, [agentUrl]);
        expect(stored.rows, table).toEqual([]);
      }
      currentUserId = ADMIN_USER_ID;
      const status = await request(app).get(accepted.body.status_url).send();
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        status: 'failed', attempts: 1, result: null, error: { code: 'authorization_revoked' },
      });
      expect(complyMock).toHaveBeenCalledOnce();
    } finally {
      releaseCompliance?.(result);
      if (revocation === 'membership') {
        await pool.query(
          `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, email, role)
           VALUES ($1, $2, $3, 'admin') ON CONFLICT (workos_organization_id, workos_user_id) DO NOTHING`,
          [TEST_ORG_ID, OWNER_USER_ID, `${OWNER_USER_ID}@test.com`],
        );
      }
    }
  });

  it.each(['rotated-key', ''])('rejects stale static administrator authorization after the key becomes %s', async (currentKey) => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('static-admin');
    vi.stubEnv('ADMIN_API_KEY', currentKey);
    try {
      // Middleware deliberately stamps the stale static principal. Queue
      // admission must still require revocable per-credential provenance.
      const res = await request(app).post(url(agentUrl)).send();
      expect(res.status).toBe(403);
      expect(getWorkosUserMock).not.toHaveBeenCalled();
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
      const queued = await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl]);
      expect(queued.rows).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
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
    currentUserId = ADMIN_USER_ID;
    refreshSingleAgentMock.mockRejectedValue(new Error('Probe timeout'));
    const res = await request(app).post(url(ownedAgentUrl('probe-fail'))).send();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 'probe_failed',
      error: 'The agent capability probe failed',
    });
  });

  it('returns 409 when monitoring is paused', async () => {
    currentUserId = ADMIN_USER_ID;
    refreshSingleAgentMock.mockRejectedValue(new Error('Monitoring paused for this agent'));
    const res = await request(app).post(url(ownedAgentUrl('paused'))).send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Monitoring is paused/);
  });

  it('returns an immediate durable handle and polls a long-running refresh to completion', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('async-refresh');
    let resolveCompliance!: (value: ReturnType<typeof makeComplianceResult>) => void;
    const deferredCompliance = new Promise<ReturnType<typeof makeComplianceResult>>((resolve) => {
      resolveCompliance = resolve;
    });
    complyMock.mockReturnValueOnce(deferredCompliance);

    const startedAt = Date.now();
    const accepted = await request(app)
      .post(url(agentUrl))
      .set('Prefer', 'respond-async')
      .send();

    expect(accepted.status).toBe(202);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(accepted.headers).toMatchObject({
      'cache-control': 'private, no-store',
      'preference-applied': 'respond-async',
      'retry-after': '5',
    });
    expect(accepted.body).toMatchObject({
      refresh_operation_id: expect.any(String),
      test_session_id: expect.stringMatching(/^owner-refresh-[0-9a-f-]{36}$/),
      status_url: expect.any(String),
    });

    currentUserId = OTHER_USER_ID;
    const forbidden = await request(app).get(accepted.body.status_url).send();
    expect(forbidden.status).toBe(404);

    currentUserId = STATIC_ADMIN_USER_ID;
    const waitForStatus = async (target: 'running' | 'succeeded') => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const status = await request(app).get(accepted.body.status_url).send();
        if (status.body.status === target) return status;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Refresh did not reach ${target}`);
    };

    const running = await waitForStatus('running');
    expect(running.headers['cache-control']).toBe('private, no-store');
    expect(running.body.test_session_id).toBe(accepted.body.test_session_id);
    resolveCompliance(makeComplianceResult());

    const completed = await waitForStatus('succeeded');
    expect(completed.body.result).toMatchObject({
      compliance: {
        ran: true,
        run_id: expect.any(String),
        test_session_id: accepted.body.test_session_id,
      },
    });
  }, 20_000);

  it('falls back to 202 at the legacy deadline without Prefer, then completes by polling', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('legacy-timeout');
    let resolveCompliance!: (value: ReturnType<typeof makeComplianceResult>) => void;
    const deferredCompliance = new Promise<ReturnType<typeof makeComplianceResult>>((resolve) => {
      resolveCompliance = resolve;
    });
    complyMock.mockReturnValueOnce(deferredCompliance);

    const startedAt = Date.now();
    const accepted = await request(app).post(url(agentUrl)).send();
    expect(accepted.status).toBe(202);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_900);
    expect(Date.now() - startedAt).toBeLessThan(13_000);
    expect(accepted.headers).not.toHaveProperty('preference-applied');
    expect(accepted.body).toMatchObject({
      refresh_operation_id: expect.any(String),
      status: expect.stringMatching(/^(queued|running)$/),
      status_url: expect.any(String),
    });

    resolveCompliance(makeComplianceResult());
    const deadline = Date.now() + 5_000;
    let completed: Awaited<ReturnType<typeof request>> | undefined;
    while (Date.now() < deadline) {
      const status = await request(app).get(accepted.body.status_url).send();
      if (status.body.status === 'succeeded') {
        completed = status;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(completed?.body).toMatchObject({
      status: 'succeeded',
      result: { compliance: { run_id: expect.any(String) } },
    });
  }, 20_000);

  it.each(['complete', 'timed_out'] as const)('recovers a persisted %s run without executing a second suite or publishing partial evidence', async completeness => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl(completeness === 'complete' ? 'refresh-recovery' : 'refresh-recovery-timed_out');
    complyMock.mockResolvedValueOnce({ ...makeComplianceResult(), completeness });
    const revokeBadges = vi.spyOn(ComplianceDatabase.prototype, 'revokeBadge');
    const upsertBadge = vi.spyOn(ComplianceDatabase.prototype, 'upsertBadge');
    refreshSingleAgentMock
      .mockResolvedValueOnce({
        online: true,
        tools_count: 4,
        response_time_ms: 120,
        inferred_type: 'governance',
        type_promoted: true,
        oauth_required: false,
        checked_at: new Date().toISOString(),
      })
      .mockRejectedValueOnce(new Error('second probe must not run'));
    const resolveOwnerAuth = vi.spyOn(ComplianceDatabase.prototype, 'resolveOwnerAuth')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('credential store unavailable during recovery'));
    const markSucceeded = vi.spyOn(ComplianceRefreshRequestsDatabase.prototype, 'markSucceeded')
      .mockResolvedValueOnce(false);
    try {
      const accepted = await request(app)
        .post(url(agentUrl))
        .set('Prefer', 'respond-async')
        .send();
      expect(accepted.status).toBe(202);

      const operationId = accepted.body.refresh_operation_id as string;
      const firstAttemptDeadline = Date.now() + 12_000;
      while (Date.now() < firstAttemptDeadline) {
        const storedRun = await pool.query(
          'SELECT id FROM agent_compliance_runs WHERE refresh_operation_id = $1',
          [operationId],
        );
        if (storedRun.rowCount === 1 && markSucceeded.mock.calls.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(markSucceeded).toHaveBeenCalledOnce();
      expect(complyMock).toHaveBeenCalledOnce();

      await pool.query(
        `UPDATE agent_compliance_refresh_requests
            SET lease_expires_at = NOW() - INTERVAL '1 second'
          WHERE id = $1`,
        [operationId],
      );

      const recoveryDeadline = Date.now() + 12_000;
      let operationStatus = '';
      while (Date.now() < recoveryDeadline) {
        const operation = await pool.query<{ status: string }>(
          'SELECT status FROM agent_compliance_refresh_requests WHERE id = $1',
          [operationId],
        );
        operationStatus = operation.rows[0]?.status ?? '';
        if (operationStatus === 'succeeded') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(operationStatus).toBe('succeeded');
      expect(complyMock).toHaveBeenCalledOnce();
      expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
      expect(resolveOwnerAuth).toHaveBeenCalledOnce();

      const completed = await request(app).get(accepted.body.status_url).send();
      expect(completed.body).toMatchObject({
        status: 'succeeded',
        result: {
          compliance: {
            ran: true,
            run_id: expect.any(String),
            test_session_id: accepted.body.test_session_id,
            completeness,
            is_authoritative: completeness === 'complete',
            badge_eligible: completeness === 'complete',
            badge_eligible_adcp_versions: completeness === 'complete' ? ['3.0'] : [],
          },
        },
      });
      if (completeness === 'timed_out') {
        expect(revokeBadges).not.toHaveBeenCalled();
        expect(upsertBadge).not.toHaveBeenCalled();
        const materialized = await pool.query('SELECT 1 FROM agent_compliance_status WHERE agent_url = $1', [agentUrl]);
        expect(materialized.rowCount).toBe(0);
        const history = await request(app).get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/compliance/history`);
        expect(history.body.runs).toEqual([]);
        currentUserId = OWNER_USER_ID;
        currentAuthWorkosUserId = undefined;
        const diagnostics = await request(app).get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/compliance/diagnostics`);
        expect(diagnostics.body).toMatchObject({ completeness: 'timed_out', is_authoritative: false,
          diagnostics_visibility: 'owner_or_operator', provenance: { sdk_version: '14.0.0-rc.33', agent_build_version: null } });
      }
    } finally {
      revokeBadges.mockRestore();
      upsertBadge.mockRestore();
      markSucceeded.mockRestore();
      resolveOwnerAuth.mockRestore();
    }
  }, 30_000);

  it('retries failed badge persistence from the saved run without executing a second suite', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('badge-retry');
    complyMock.mockResolvedValueOnce(makeComplianceResult({
      specialisms: ['sales-broadcast-tv'],
      storyboardId: 'sales_broadcast_tv',
    }));
    const upsertBadge = vi.spyOn(ComplianceDatabase.prototype, 'upsertBadge')
      .mockRejectedValueOnce(new Error('simulated badge persistence failure'));
    try {
      const accepted = await request(app)
        .post(url(agentUrl))
        .set('Prefer', 'respond-async')
        .send();
      expect(accepted.status).toBe(202);

      const deadline = Date.now() + 30_000;
      let completed: Awaited<ReturnType<typeof request>> | undefined;
      while (Date.now() < deadline) {
        const status = await request(app).get(accepted.body.status_url).send();
        if (status.body.status === 'succeeded') {
          completed = status;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      expect(completed?.body).toMatchObject({
        status: 'succeeded',
        attempts: 2,
        result: { compliance: { run_id: expect.any(String) } },
      });
      expect(complyMock).toHaveBeenCalledOnce();
      expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
      expect(upsertBadge).toHaveBeenCalledTimes(2);
    } finally {
      upsertBadge.mockRestore();
    }
  }, 40_000);

  it('surfaces an allowlisted badge failure after retry exhaustion', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('badge-retry-exhausted');
    complyMock.mockResolvedValueOnce(makeComplianceResult({
      specialisms: ['sales-broadcast-tv'],
      storyboardId: 'sales_broadcast_tv',
    }));
    const upsertBadge = vi.spyOn(ComplianceDatabase.prototype, 'upsertBadge')
      .mockRejectedValue(new Error('simulated persistent badge persistence failure'));
    try {
      const accepted = await request(app)
        .post(url(agentUrl))
        .set('Prefer', 'respond-async')
        .send();
      expect(accepted.status).toBe(202);

      const deadline = Date.now() + 30_000;
      let failed: Awaited<ReturnType<typeof request>> | undefined;
      while (Date.now() < deadline) {
        const status = await request(app).get(accepted.body.status_url).send();
        if (status.body.status === 'failed') {
          failed = status;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      expect(failed?.body).toMatchObject({
        status: 'failed',
        attempts: 2,
        error: {
          code: 'badge_update_failed',
          message: 'The compliance evidence was saved but badge state could not be updated',
        },
      });
      expect(complyMock).toHaveBeenCalledOnce();
      expect(refreshSingleAgentMock).toHaveBeenCalledOnce();
      expect(upsertBadge).toHaveBeenCalledTimes(2);
    } finally {
      upsertBadge.mockRestore();
    }
  }, 40_000);

  it('recovers the same operation handle when a completed response is retried', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('rate-limit');
    const first = await request(app).post(url(agentUrl)).send();
    expect(first.status).toBe(200);

    const second = await request(app).post(url(agentUrl)).send();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      refresh_operation_id: expect.any(String),
      test_session_id: first.body.compliance.test_session_id,
      coalesced: true,
      status_url: expect.any(String),
      compliance: { run_id: first.body.compliance.run_id },
    });
  });

  // Regression: dashboard probe was constructing AdCPClient with no auth,
  // so any agent gated behind a static bearer reported "OAuth required"
  // even though evaluate_agent_quality (which resolves saved auth) worked
  // fine. The route now resolves owner-org auth and threads it to the
  // crawler so the probe sees the same credentials.
  it('threads the organization-saved bearer token through the authorized refresh', async () => {
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
          authorization: expect.any(Object),
        }),
      );
      expect(complyMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({ auth: { type: 'bearer', token: FAKE_BEARER } }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('canonicalizes the requested URL before authorized saved-auth lookup and probing', async () => {
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
          authorization: expect.any(Object),
        }),
      );
      expect(complyMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({ auth: { type: 'bearer', token: FAKE_BEARER } }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('sends the saved OAuth access token as bearer auth for applicable-storyboards discovery', async () => {
    const agentUrl = ownedAgentUrl('applicable-oauth');
    const { AgentContextDatabase } = await import('../../src/db/agent-context-db.js');
    const db = new AgentContextDatabase();
    const context = await db.create({
      organization_id: TEST_ORG_ID,
      agent_url: agentUrl,
      created_by: OWNER_USER_ID,
    });
    const accessToken = 'fresh-oauth-access-token-do-not-use-in-prod';
    await db.saveOAuthTokens(context.id, {
      access_token: accessToken,
      refresh_token: 'refresh-token-do-not-use-in-prod',
    });

    try {
      const res = await request(app)
        .get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/applicable-storyboards`)
        .send();

      expect(res.status).toBe(200);
      expect(testCapabilityDiscoveryMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({
          auth: { type: 'bearer', token: accessToken },
          transport: expect.objectContaining({
            fetchFn: expect.any(Function),
          }),
        }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('uses selected-organization credentials after exact authorization checks', async () => {
    const agentUrl = ownedAgentUrl('selected-org-refresh');
    const { AgentContextDatabase } = await import('../../src/db/agent-context-db.js');
    const db = new AgentContextDatabase();
    const context = await db.create({
      organization_id: SECOND_ORG_ID,
      agent_url: agentUrl,
      created_by: OWNER_USER_ID,
    });
    const token = 'selected-org-bearer-do-not-use-in-prod';
    await db.saveAuthToken(context.id, token, 'bearer');

    try {
      const res = await request(app)
        .post(url(agentUrl))
        .send({ organization_id: SECOND_ORG_ID });

      expect(res.status).toBe(200);
      expect(refreshSingleAgentMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({
          auth: { type: 'bearer', token },
          ownerOrgId: SECOND_ORG_ID,
          authorization: expect.any(Object),
        }),
      );
      expect(complyMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({ auth: { type: 'bearer', token } }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('creates an OAuth challenge context in the selected org for a shared agent', async () => {
    const agentUrl = ownedAgentUrl('selected-org-challenge');
    testCapabilityDiscoveryMock.mockResolvedValueOnce({
      profile: {
        name: 'OAuth challenge agent',
        tools: [],
        supported_protocols: ['media_buy'],
        specialisms: [],
      },
      steps: [{
        step: 'Discover agent profile',
        passed: false,
        duration_ms: 1,
        error: 'Agent requires OAuth authorization',
      }],
    });

    const res = await request(app)
      .get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/applicable-storyboards`)
      .query({ org: SECOND_ORG_ID });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ needs_oauth: true });
    const stored = await pool.query(
      'SELECT organization_id FROM agent_contexts WHERE id = $1',
      [res.body.agent_context_id],
    );
    expect(stored.rows).toEqual([{ organization_id: SECOND_ORG_ID }]);
  });

  it('fans out badge issuance for an authenticated administrator refresh with a passing specialism', async () => {
    currentUserId = ADMIN_USER_ID;
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

  // Regression for #7070: admin-refresh must not probe or run comply() anonymously
  // when the agent owner has stored credentials. The route now falls back
  // to complianceDb.resolveOwnerAuth (the heartbeat pattern) so the
  // capability probe and compliance run use the owner's saved token.
  it('admin refresh falls back to stored owner auth for probe and compliance (#7070)', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('admin-auth-fallback');

    const { AgentContextDatabase } = await import('../../src/db/agent-context-db.js');
    const db = new AgentContextDatabase();
    const context = await db.create({
      organization_id: TEST_ORG_ID,
      agent_url: agentUrl,
      created_by: OWNER_USER_ID,
    });
    const STORED_BEARER = 'stored-owner-bearer-for-admin-fallback';
    await db.saveAuthToken(context.id, STORED_BEARER, 'bearer');

    complyMock.mockResolvedValueOnce(makeComplianceResult());

    try {
      const res = await request(app).post(url(agentUrl)).send();

      expect(res.status).toBe(200);
      expect(res.body.compliance).toMatchObject({
        ran: true,
        auth_available: true,
      });
      expect(refreshSingleAgentMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({
          auth: expect.objectContaining({ type: 'bearer', token: STORED_BEARER }),
        }),
      );
      expect(complyMock).toHaveBeenCalledWith(
        agentUrl,
        expect.objectContaining({
          auth: expect.objectContaining({ type: 'bearer', token: STORED_BEARER }),
        }),
      );
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });
});
