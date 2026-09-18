/**
 * Integration tests for POST /api/registry/agents/:encodedUrl/refresh.
 *
 * Human refresh requests are fenced until durable credential provenance is
 * supported. Static-admin refreshes retain the durable probe/compliance lifecycle;
 * legacy human queue rows must fail before recovering or publishing evidence.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
 *     npx vitest run server/tests/integration/registry-api-agent-refresh.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AAOAdminLookupUnavailableError } from '../../src/addie/admin-status-lookup.js';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AAO_UA_COMPLIANCE } from '../../src/config/user-agents.js';
import { HOSTED_FULL_COMPLIANCE_TIMEOUT_MS } from '../../src/services/hosted-compliance-version.js';
import { ComplianceRefreshRequestsDatabase } from '../../src/db/compliance-refresh-requests-db.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import type { ComplianceRefreshQueue } from '../../src/services/compliance-refresh-queue.js';
import { complianceRunProvenance } from '../../src/compliance/run-provenance.js';
import type { ComplianceResult, ComplyOptions } from '@adcp/sdk/testing';

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
const LEGACY_USER_CASES = (['manual', 'owner_test'] as const).flatMap(triggeredBy =>
  (['queued', 'running'] as const).flatMap(status =>
    [false, true].map(checkpointed => ({
      triggeredBy, status, checkpointed,
      slug: `legacy-${triggeredBy}-${status}-${checkpointed ? 'checkpoint' : 'fresh'}`,
    })),
  ),
);
const ALL_OWNED_URLS = [
  ...LEGACY_USER_CASES.map(({ slug }) => ownedAgentUrl(slug)),
  ownedAgentUrl('legacy-static-owner'),
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
];

// Toggle which user the auth middleware stamps onto the request. Tests
// flip this between owner / other / admin to exercise the auth branches.
let currentUserId: string | null = OWNER_USER_ID;
let currentAuthWorkosUserId: string | undefined;
let currentIsAdmin: boolean | undefined;
let currentRequestUser: { id: string; authWorkosUserId?: string; email: string; isAdmin?: boolean } | undefined;

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const stampUser = (req: { user?: unknown; isStaticAdminApiKey?: boolean }) => {
    if (currentUserId === null) return;
    currentRequestUser = {
      id: currentUserId, authWorkosUserId: currentAuthWorkosUserId,
      email: `${currentAuthWorkosUserId ?? currentUserId}@test.com`, isAdmin: currentIsAdmin,
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
    await server?.stop();
    await closeDatabase();
  }, 120_000);

  beforeEach(() => {
    currentUserId = OWNER_USER_ID;
    currentAuthWorkosUserId = undefined;
    currentIsAdmin = undefined;
    currentRequestUser = undefined;
    isAdminMock.mockReset();
    isAdminMock.mockImplementation(async (principal: { id: string; authWorkosUserId?: string }) => (principal.authWorkosUserId ?? principal.id) === ADMIN_USER_ID);
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

  const stopRefreshWorker = async () => {
    const queue = (server as unknown as { complianceRefreshQueue: ComplianceRefreshQueue }).complianceRefreshQueue;
    queue.stop();
    await vi.waitFor(() => {
      expect((queue as unknown as { processing: boolean }).processing).toBe(false);
    });
    return queue;
  };

  it.each(LEGACY_USER_CASES)(
    'terminally rejects legacy user $triggeredBy $status checkpointed=$checkpointed before any domain work',
    async ({ triggeredBy, status, checkpointed, slug }) => {
      const queue = await stopRefreshWorker();
      const operationId = randomUUID();
      const agentUrl = ownedAgentUrl(slug);
      const runId = randomUUID();
      const canonicalUserId = triggeredBy === 'manual' ? ADMIN_USER_ID : OWNER_USER_ID;
      const probe = checkpointed ? {
        online: true, tools_count: 4, response_time_ms: 120, inferred_type: 'governance',
        type_promoted: false, oauth_required: false, checked_at: new Date().toISOString(),
      } : null;
      const context = await new AgentContextDatabase().create({
        organization_id: TEST_ORG_ID, agent_url: agentUrl, created_by: OWNER_USER_ID,
      });
      await new AgentContextDatabase().saveAuthToken(context.id, 'legacy-test-bearer-do-not-use-in-prod', 'bearer');
      await pool.query(
        `INSERT INTO agent_compliance_refresh_requests
         (id, agent_url, owner_org_id, requester_type, requested_by_user_id, triggered_by,
          test_session_id, status, attempts, max_attempts, available_at,
          lease_owner, lease_token, lease_expires_at, probe_result_json, auth_available)
         VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, $8, 5, NOW(), $9, $10, $11, $12::jsonb, $13)`,
        [operationId, agentUrl, triggeredBy === 'owner_test' ? TEST_ORG_ID : null,
          canonicalUserId, triggeredBy, `legacy-refresh-${operationId}`, status,
          status === 'running' ? 1 : 0, status === 'running' ? 'expired-worker' : null,
          status === 'running' ? randomUUID() : null,
          status === 'running' ? new Date(Date.now() - 60_000) : null,
          probe ? JSON.stringify(probe) : null, checkpointed ? true : null],
      );
      if (checkpointed) {
        await pool.query(
          `INSERT INTO agent_compliance_runs
           (id, agent_url, lifecycle_stage, overall_status, triggered_by, dry_run, refresh_operation_id)
           VALUES ($1, $2, 'production', 'passing', $3, FALSE, $4)`,
          [runId, agentUrl, triggeredBy, operationId],
        );
      }
      const domainState = () => pool.query(
        `SELECT * FROM (
         SELECT 'runs' AS source, to_jsonb(t) AS value FROM agent_compliance_runs t WHERE agent_url = $1
         UNION ALL SELECT 'status', to_jsonb(t) FROM agent_compliance_status t WHERE agent_url = $1
         UNION ALL SELECT 'storyboards', to_jsonb(t) FROM agent_storyboard_status t WHERE agent_url = $1
         UNION ALL SELECT 'diagnostics', to_jsonb(t) FROM agent_compliance_step_diagnostics t WHERE agent_url = $1
         UNION ALL SELECT 'badges', to_jsonb(t) FROM agent_verification_badges t WHERE agent_url = $1
         UNION ALL SELECT 'health', to_jsonb(t) FROM agent_health_snapshot t WHERE agent_url = $1
         UNION ALL SELECT 'capabilities', to_jsonb(t) FROM agent_capabilities_snapshot t WHERE agent_url = $1
         UNION ALL SELECT 'credentials', to_jsonb(t) FROM agent_contexts t WHERE agent_url = $1) AS domain_state
         ORDER BY source, value::text`,
        [agentUrl],
      );
      const before = await domainState();
      const forbiddenCalls = [
        vi.spyOn(ComplianceDatabase.prototype, 'getRunForRefreshOperation'),
        vi.spyOn(ComplianceDatabase.prototype, 'resolveOwnerAuth'),
        vi.spyOn(ComplianceDatabase.prototype, 'recordComplianceRun'),
        vi.spyOn(ComplianceDatabase.prototype, 'upsertBadge'),
        vi.spyOn(ComplianceDatabase.prototype, 'revokeBadge'),
        vi.spyOn(ComplianceDatabase.prototype, 'revokeAllBadges'),
        vi.spyOn(AgentContextDatabase.prototype, 'getByOrgAndUrl'),
        vi.spyOn(AgentContextDatabase.prototype, 'getAuthInfoByOrgAndUrl'),
        vi.spyOn(AgentContextDatabase.prototype, 'getOAuthTokensByOrgAndUrl'),
        vi.spyOn(AgentContextDatabase.prototype, 'getOAuthClientCredentialsByOrgAndUrl'),
        vi.spyOn(AgentContextDatabase.prototype, 'findOwnerOrgWithSavedAuth'),
        vi.spyOn(ComplianceRefreshRequestsDatabase.prototype, 'recordProbeResult'),
        vi.spyOn(ComplianceRefreshRequestsDatabase.prototype, 'markSucceeded'),
        vi.spyOn(ComplianceRefreshRequestsDatabase.prototype, 'requeueAfterFailure'),
      ];
      try {
        expect(await queue.processQueue()).toEqual({ claimed: 1, succeeded: 0, failed: 1, lostLease: 0 });
        const failed = await pool.query('SELECT * FROM agent_compliance_refresh_requests WHERE id = $1', [operationId]);
        expect(failed.rows[0]).toMatchObject({
          status: 'failed', attempts: status === 'running' ? 2 : 1,
          last_error_code: 'authorization_provenance_missing',
          last_error: 'Refresh requester authorization provenance is unavailable',
          lease_owner: null, lease_token: null, lease_expires_at: null,
          result_json: null, probe_result_json: probe,
        });
        expect(failed.rows[0].completed_at).toBeInstanceOf(Date);
        expect(await queue.processQueue()).toEqual({ claimed: 0, succeeded: 0, failed: 0, lostLease: 0 });
        expect((await pool.query('SELECT attempts FROM agent_compliance_refresh_requests WHERE id = $1', [operationId])).rows[0].attempts)
          .toBe(status === 'running' ? 2 : 1);
        for (const spy of forbiddenCalls) expect(spy).not.toHaveBeenCalled();
        expect(isAdminMock).not.toHaveBeenCalled();
        expect(refreshSingleAgentMock).not.toHaveBeenCalled();
        expect(complyMock).not.toHaveBeenCalled();
        expect((await domainState()).rows).toEqual(before.rows);

        currentUserId = STATIC_ADMIN_USER_ID;
        const response = await request(app).get(`${url(agentUrl)}es/${operationId}`).send();
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          status: 'failed',
          error: {
            code: 'authorization_provenance_missing',
            message: 'Refresh requester authorization provenance is unavailable',
          },
        });
      } finally {
        for (const spy of forbiddenCalls) spy.mockRestore();
        await pool.query('DELETE FROM agent_compliance_runs WHERE id = $1', [runId]);
        await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = $1', [operationId]);
        await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
        queue.start();
      }
    },
  );

  it('preserves rejection of a legacy static-admin row carrying an owner context without a requester', async () => {
    const queue = await stopRefreshWorker();
    const operationId = randomUUID();
    const agentUrl = ownedAgentUrl('legacy-static-owner');
    try {
      await pool.query(
        `INSERT INTO agent_compliance_refresh_requests
         (id, agent_url, owner_org_id, requester_type, requested_by_user_id, triggered_by, test_session_id)
         VALUES ($1, $2, $3, 'static_admin', NULL, 'owner_test', $4)`,
        [operationId, agentUrl, TEST_ORG_ID, `legacy-refresh-${operationId}`],
      );
      expect(await queue.processQueue()).toEqual({ claimed: 1, succeeded: 0, failed: 1, lostLease: 0 });
      const failed = await pool.query('SELECT status, last_error_code FROM agent_compliance_refresh_requests WHERE id = $1', [operationId]);
      expect(failed.rows[0]).toEqual({ status: 'failed', last_error_code: 'authorization_revoked' });
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
    } finally {
      await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = $1', [operationId]);
      queue.start();
    }
  });

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
      provenance: { sdk_version: '14.0.0-rc.35', test_session_id: expect.any(String), agent_build_version: null },
    });
    expect(complyMock.mock.calls[0][1].test_session_id).toBe(res.body.provenance.test_session_id);
    const db = new ComplianceDatabase();
    expect(await db.getComplianceStatus(agentUrl)).toBeNull();
    expect(await db.getBadgesForAgent(agentUrl)).toEqual([]);
    expect((await db.getComplianceRun(agentUrl, res.body.run_id))?.provenance_json?.test_session_id)
      .toBe(res.body.provenance.test_session_id);
  });

  it('static admin can refresh and gets the snapshot back', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
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
    currentUserId = STATIC_ADMIN_USER_ID;
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

  it('fences administrator session refresh until durable credential provenance is supported', async () => {
    currentUserId = ADMIN_USER_ID;
    const agentUrl = ownedAgentUrl('admin');
    const res = await request(app).post(url(agentUrl)).send();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('refresh_authorization_provenance_required');
    expect(res.body.error).toBe(
      'Recheck & retest is temporarily paused platform-wide. Use Requeue comply to schedule the next run.',
    );
    expect(res.headers['retry-after']).toBe('60');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    const queued = await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl]);
    expect(queued.rows).toEqual([]);
  });

  it.each([
    { authenticated: ADMIN_USER_ID, canonical: OTHER_USER_ID, status: 503 },
    { authenticated: OTHER_USER_ID, canonical: ADMIN_USER_ID, status: 403 },
  ])('uses exact $authenticated admin authorization linked to $canonical before refresh admission', async ({ authenticated, canonical, status }) => {
    currentUserId = canonical;
    currentAuthWorkosUserId = authenticated;
    currentIsAdmin = true;
    const response = await request(app).post(url(OTHER_AGENT_URL)).send();
    expect(response.status).toBe(status);
    if (status === 503) expect(response.body.code).toBe('refresh_authorization_provenance_required');
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    const queued = await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [OTHER_AGENT_URL]);
    expect(queued.rows).toEqual([]);
    // The rate limiter can independently check its optional admin exemption;
    // the route must additionally resolve its immutable captured principal.
    const principals = isAdminMock.mock.calls.map(([principal]) => principal);
    expect(principals.every(principal => (principal.authWorkosUserId ?? principal.id) === authenticated)).toBe(true);
    const routePrincipal = principals.find(principal => Object.isFrozen(principal));
    expect(routePrincipal).toMatchObject({ id: authenticated });
  });

  it('fences linked owner refresh instead of persisting ambiguous credential provenance', async () => {
    currentUserId = OTHER_USER_ID;
    currentAuthWorkosUserId = OWNER_USER_ID;
    const agentUrl = ownedAgentUrl('linked-owner');
    const response = await request(app).post(url(agentUrl)).send();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('refresh_authorization_provenance_required');
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl])).rows).toEqual([]);
  });

  it('does not inherit canonical organization ownership on refresh', async () => {
    currentUserId = OWNER_USER_ID;
    currentAuthWorkosUserId = OTHER_USER_ID;
    const agentUrl = ownedAgentUrl('linked-owner');
    const response = await request(app).post(url(agentUrl)).send();
    expect(response.status).toBe(403);
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl])).rows).toEqual([]);
  });

  it('fences a confirmed unlinked owner without misreporting a separate platform-admin outage', async () => {
    isAdminMock.mockRejectedValue(new AAOAdminLookupUnavailableError());
    const agentUrl = ownedAgentUrl('owner-admin-outage');
    const response = await request(app).post(url(agentUrl)).send();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('refresh_authorization_provenance_required');
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl])).rows).toEqual([]);
    expect(isAdminMock.mock.calls.every(([principal]) => (principal.authWorkosUserId ?? principal.id) === OWNER_USER_ID)).toBe(true);
  });

  it('reports non-owner admin lookup unavailability without enqueuing or trusting isAdmin', async () => {
    currentUserId = ADMIN_USER_ID;
    currentAuthWorkosUserId = OTHER_USER_ID;
    currentIsAdmin = true;
    isAdminMock.mockRejectedValue(new AAOAdminLookupUnavailableError());
    const response = await request(app).post(url(OTHER_AGENT_URL)).send();
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('admin_authorization_unavailable');
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(refreshSingleAgentMock).not.toHaveBeenCalled();
    expect(complyMock).not.toHaveBeenCalled();
    expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [OTHER_AGENT_URL])).rows).toEqual([]);
  });

  it.each([
    { authenticated: ADMIN_USER_ID, canonical: OTHER_USER_ID, allowed: true },
    { authenticated: OTHER_USER_ID, canonical: ADMIN_USER_ID, allowed: false },
  ])('authorizes refresh status with exact $authenticated and immutable lookup provenance', async ({ authenticated, canonical, allowed }) => {
    const operationId = randomUUID();
    await pool.query(
      `INSERT INTO agent_compliance_refresh_requests
       (id, agent_url, requester_type, requested_by_user_id, triggered_by, test_session_id, status, result_json, completed_at)
       VALUES ($1, $2, 'user', $3, 'manual', $4, 'succeeded', '{"online":true}'::jsonb, NOW())`,
      [operationId, OTHER_AGENT_URL, OWNER_USER_ID, `test-status-${operationId}`],
    );
    currentUserId = canonical;
    currentAuthWorkosUserId = authenticated;
    currentIsAdmin = !allowed;
    isAdminMock.mockImplementationOnce(async (principal) => {
      await Promise.resolve();
      currentRequestUser!.id = authenticated;
      currentRequestUser!.authWorkosUserId = canonical;
      return principal.id === ADMIN_USER_ID;
    });
    try {
      const response = await request(app).get(`${url(OTHER_AGENT_URL)}es/${operationId}`).send();
      expect(response.status).toBe(allowed ? 200 : 404);
      if (allowed) expect(response.body.result).toEqual({ online: true });
      const principal = isAdminMock.mock.calls[0][0];
      expect(principal.id).toBe(authenticated);
      expect(Object.isFrozen(principal)).toBe(true);
    } finally {
      await pool.query('DELETE FROM agent_compliance_refresh_requests WHERE id = $1', [operationId]);
    }
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
    currentUserId = STATIC_ADMIN_USER_ID;
    refreshSingleAgentMock.mockRejectedValue(new Error('Probe timeout'));
    const res = await request(app).post(url(ownedAgentUrl('probe-fail'))).send();
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 'probe_failed',
      error: 'The agent capability probe failed',
    });
  });

  it('returns 409 when monitoring is paused', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    refreshSingleAgentMock.mockRejectedValue(new Error('Monitoring paused for this agent'));
    const res = await request(app).post(url(ownedAgentUrl('paused'))).send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Monitoring is paused/);
  });

  it('returns an immediate durable handle and polls a long-running refresh to completion', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
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
    currentUserId = STATIC_ADMIN_USER_ID;
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
    currentUserId = STATIC_ADMIN_USER_ID;
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
        const diagnostics = await request(app).get(`/api/registry/agents/${encodeURIComponent(agentUrl)}/compliance/diagnostics`);
        expect(diagnostics.body).toMatchObject({ completeness: 'timed_out', is_authoritative: false,
          diagnostics_visibility: 'owner_or_operator', provenance: { sdk_version: '14.0.0-rc.35', agent_build_version: null } });
      }
    } finally {
      revokeBadges.mockRestore();
      upsertBadge.mockRestore();
      markSucceeded.mockRestore();
      resolveOwnerAuth.mockRestore();
    }
  }, 30_000);

  it('retries failed badge persistence from the saved run without executing a second suite', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
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
    currentUserId = STATIC_ADMIN_USER_ID;
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
    currentUserId = STATIC_ADMIN_USER_ID;
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
  it('fences owner refresh before using an organization-saved bearer token', async () => {
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
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('refresh_authorization_provenance_required');
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
      expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl])).rows).toEqual([]);
    } finally {
      await pool.query('DELETE FROM agent_contexts WHERE id = $1', [context.id]);
    }
  });

  it('fences a canonicalized owner URL before resolving saved auth or probing', async () => {
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
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('refresh_authorization_provenance_required');
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
      expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl])).rows).toEqual([]);
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

  it('fences selected-organization owner refresh before using saved credentials', async () => {
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

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('refresh_authorization_provenance_required');
      expect(refreshSingleAgentMock).not.toHaveBeenCalled();
      expect(complyMock).not.toHaveBeenCalled();
      expect((await pool.query('SELECT id FROM agent_compliance_refresh_requests WHERE agent_url = $1', [agentUrl])).rows).toEqual([]);
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

  it('fans out badge issuance for a static-admin refresh with a passing specialism', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
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
    currentUserId = STATIC_ADMIN_USER_ID;
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
