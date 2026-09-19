/**
 * Integration tests for the owner-scope gate on
 * GET /api/registry/agents/:encodedUrl/compliance.
 *
 * Pins the verdict_source / membership_tier / subscription_status /
 * is_api_access_tier scoping and the public storyboard-status contract.
 * The owner-only keys MUST exist on every response
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
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { complianceResultToDbInput, type ComplianceResult } from '../../src/addie/services/compliance-testing.js';
import { runMigrations } from '../../src/db/migrate.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_registry_debug';
  process.env.WORKOS_CLIENT_ID ||= 'client_registry_debug';
});

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const OWNER_USER_ID = `user_verdict_owner_${RUN_SUFFIX}`;
const CROSS_ORG_USER_ID = `user_verdict_cross_${RUN_SUFFIX}`;
const STATIC_ADMIN_USER_ID = 'admin_api_key';
const OWNER_ORG_ID = `org_verdict_owner_${RUN_SUFFIX}`;
const CROSS_ORG_ID = `org_verdict_cross_${RUN_SUFFIX}`;
const AGENT_URL = `https://verdict-source-${RUN_SUFFIX}.example.com/mcp`;

// optAuth on the compliance endpoint stamps req.user only when the auth
// header parses successfully. Tests toggle currentUserId between owner,
// cross-org, and null (anonymous) to exercise each auth branch.
let currentUserId: string | null = null;
let complianceRunId: string;

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const stampUser = (req: { user?: unknown; isStaticAdminApiKey?: boolean }) => {
    if (currentUserId === null) return;
    req.user = { id: currentUserId, email: `${currentUserId}@test.com` };
    if (currentUserId === STATIC_ADMIN_USER_ID) {
      req.isStaticAdminApiKey = true;
    }
  };
  return {
    ...actual,
    requireAuth: (req: { user?: unknown; isStaticAdminApiKey?: boolean }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (currentUserId === null) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      stampUser(req);
      next();
    },
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
      `INSERT INTO organizations (workos_organization_id, name, membership_tier, subscription_status, created_at, updated_at)
       VALUES ($1, 'Cross Org', 'company_standard', 'active', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE
         SET membership_tier = EXCLUDED.membership_tier,
             subscription_status = EXCLUDED.subscription_status,
             updated_at = NOW()`,
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
    const runResult = await pool.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (
         agent_url, lifecycle_stage, overall_status, headline,
         tracks_json, tracks_passed, tracks_failed, tracks_skipped, tracks_partial,
         triggered_by, dry_run, tested_at, adcp_version, requested_compliance_target
       ) VALUES ($1, 'production', 'passing', 'all clear',
                 '[]'::jsonb, 0, 0, 0, 0, 'owner_test', false, NOW(), '3.1.20', '3.1')
       RETURNING id`,
      [AGENT_URL],
    );
    complianceRunId = runResult.rows[0].id;
    await pool.query(
      `INSERT INTO agent_compliance_status (
         agent_url, status, last_checked_at, last_passed_at,
         tracks_summary_json, headline, status_changed_at, updated_at,
         adcp_version, requested_compliance_target
       ) VALUES ($1, 'passing', NOW(), NOW(),
                 '{}'::jsonb, 'all clear', NOW(), NOW(), '3.1.20', '3.1')
       ON CONFLICT (agent_url) DO UPDATE
         SET status = EXCLUDED.status,
             last_checked_at = NOW(),
             last_passed_at = NOW(),
             headline = EXCLUDED.headline,
             adcp_version = EXCLUDED.adcp_version,
             requested_compliance_target = EXCLUDED.requested_compliance_target,
             updated_at = NOW()`,
      [AGENT_URL],
    );
    await pool.query(
      `INSERT INTO verification_profile_shadow_assessments (
         source_run_id, agent_url, lifecycle_stage, adcp_version, policy_version,
         current_public_status, proposed_spec_status, proposed_sandbox_status,
         sandbox_eligible, recommended_profile, run_complete,
         bundle_evidence_present, failing_bundle_count,
         incomplete_bundle_count, sandbox_unresolved_bundle_count,
         unattributed_failure_count,
         selected_storyboard_count, applicable_phase_count,
         controller_gap_phase_count, controller_gap_step_count,
         controller_cascade_step_count, observed_failure_count,
         sandbox_observable_failure_count, non_controller_gap_step_count,
         controller_missing_storyboard_count, other_missing_storyboard_count,
         mixed_controller_failure_phase_count,
         unattributed_flat_failure_count, unexplained_phase_failure_count,
         sandbox_unresolved_executed_bundle_count,
         sandbox_unresolved_missing_tools_bundle_count,
         sandbox_unresolved_unknown_bundle_count,
         source_tested_at, requested_compliance_target
       ) VALUES (
         $1, $2, 'production', '3.1.20', 'verification-profiles-v3',
         'passing', 'partial', 'passing',
         TRUE, 'sandbox', TRUE,
         TRUE, 0, 1, 0, 0,
         12, 10, 1, 1, 1, 0,
         0, 0, 1, 0, 0,
         0, 0, 0, 0, 0,
         NOW(), '3.1'
       )`,
      [complianceRunId, AGENT_URL],
    );
    await pool.query(
      `INSERT INTO agent_storyboard_status (
         agent_url, storyboard_id, status, last_tested_at, run_id,
         steps_passed, steps_total, failure_count, skipped_count,
         first_failed_step_id, first_failed_step_title, first_failed_step_task, first_failure_message,
         triggered_by
       ) VALUES (
         $1, 'debug_storyboard', 'failing', NOW(), $2, 1, 2, 1, 1,
         'debug_step', 'Debug step', 'get_products', 'debug failure', 'owner_test'
       )
       ON CONFLICT (agent_url, storyboard_id) DO UPDATE
         SET status = EXCLUDED.status,
             last_tested_at = EXCLUDED.last_tested_at,
             run_id = EXCLUDED.run_id,
             steps_passed = EXCLUDED.steps_passed,
             steps_total = EXCLUDED.steps_total,
             failure_count = EXCLUDED.failure_count,
             skipped_count = EXCLUDED.skipped_count,
             first_failed_step_id = EXCLUDED.first_failed_step_id,
             first_failed_step_title = EXCLUDED.first_failed_step_title,
             first_failed_step_task = EXCLUDED.first_failed_step_task,
             first_failure_message = EXCLUDED.first_failure_message,
             triggered_by = EXCLUDED.triggered_by`,
      [AGENT_URL, complianceRunId],
    );
    await pool.query(
      `INSERT INTO agent_compliance_step_diagnostics (
         run_id, agent_url, storyboard_id, phase_id, step_id, task,
         step_passed, duration_ms, request_url, request_jsonb,
         response_status, response_jsonb, error_text, failed_validations_jsonb
       ) VALUES (
         $1, $2, 'debug_storyboard', 'debug_phase', 'debug_step', 'get_products',
         false, 42, $2, '{"params":{"brief":"debug"}}'::jsonb,
         200, '{"ok":false}'::jsonb, 'debug failure',
         '[{"field":"products","message":"must not be empty"}]'::jsonb
       )`,
      [complianceRunId, AGENT_URL],
    );
    await pool.query(
      `INSERT INTO agent_outbound_requests (
         agent_url, request_type, user_agent, response_time_ms, success, error_message
       ) VALUES ($1, 'compliance', 'test-runner', 42, false, 'debug failure')`,
      [AGENT_URL],
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_outbound_requests WHERE agent_url = $1', [AGENT_URL]);
    await pool.query('DELETE FROM agent_compliance_step_diagnostics WHERE agent_url = $1', [AGENT_URL]);
    await pool.query('DELETE FROM agent_storyboard_status WHERE agent_url = $1', [AGENT_URL]);
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

  const expectPublicStoryboardStatus = (
    body: Record<string, unknown>,
    options: { includeDiagnostics?: boolean } = {},
  ) => {
    expect(body.storyboard_statuses).toEqual([
      expect.objectContaining({
        storyboard_id: 'debug_storyboard',
        status: 'failing',
        steps_passed: 1,
        steps_total: 2,
        first_failed_step_id: options.includeDiagnostics ? 'debug_step' : null,
        first_failed_step_title: options.includeDiagnostics ? 'Debug step' : null,
        first_failed_step_task: options.includeDiagnostics ? 'get_products' : null,
        first_failure_message: options.includeDiagnostics ? 'debug failure' : null,
        // The card endpoint never loads the separate diagnostics table. Owner
        // callers still see the denormalized first-failure fields above.
        first_failure_validations: [],
      }),
    ]);
    expect(body.storyboards_passing).toBe(0);
    expect(body.storyboards_total).toBe(1);
  };

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
    expect(res.body.grading_profile_comparisons).toEqual([]);
    expectPublicStoryboardStatus(res.body);
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
    expect(res.body.grading_profile_comparisons).toEqual([]);
    expectPublicStoryboardStatus(res.body);
  });

  it('owner caller: verdict_source + membership tier populated', async () => {
    currentUserId = OWNER_USER_ID;
    const res = await request(app).get(endpoint);
    expect(res.status).toBe(200);
    expect(res.body.verdict_source).toBe('owner_test');
    expect(res.body.membership_tier).toBe('company_standard');
    expect(res.body.subscription_status).toBe('active');
    expect(res.body.is_api_access_tier).toBe(true);
    expect(res.body.grading_profile_comparisons).toEqual([
      expect.objectContaining({
        scope: 'agent',
        availability: 'current',
        selected_profile: 'legacy',
        selection_enabled: false,
        source_run_id: complianceRunId,
        evaluator_policy_version: 'verification-profiles-v3',
        requested_compliance_target: '3.1',
          compliance_bundle_version: '3.1.20',
          stale: false,
          evidence: expect.objectContaining({ flat_failure_count: 0 }),
          profiles: {
          legacy: expect.objectContaining({ available: true, status: 'passing' }),
          spec: expect.objectContaining({ available: true, status: 'partial' }),
          sandbox: expect.objectContaining({ available: true, status: 'passing' }),
        },
      }),
    ]);
    // The card summary omits the expensive step-diagnostics join even for an
    // owner. The member-only /storyboard-status drill-down remains the source
    // for validation details.
    expectPublicStoryboardStatus(res.body, { includeDiagnostics: true });
  });

  it('static admin API key sees the same read-only agent-wide comparison', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const res = await request(app).get(endpoint);
    expect(res.status).toBe(200);
    expect(res.body.grading_profile_comparisons).toEqual([
      expect.objectContaining({
        scope: 'agent',
        availability: 'current',
        source_run_id: complianceRunId,
        selection_enabled: false,
      }),
    ]);
  });

  it('fails closed when the latest public heartbeat has no matching comparison', async () => {
    const newerRun = await pool.query<{ id: string }>(
      `INSERT INTO agent_compliance_runs (
         agent_url, lifecycle_stage, overall_status, headline, tracks_json,
         triggered_by, dry_run, tested_at, adcp_version, requested_compliance_target
       ) VALUES (
         $1, 'production', 'passing', 'newer heartbeat', '[]'::jsonb,
         'heartbeat', FALSE, NOW() + INTERVAL '1 minute', '3.1.20', '3.1'
       ) RETURNING id`,
      [AGENT_URL],
    );
    try {
      currentUserId = OWNER_USER_ID;
      const res = await request(app).get(endpoint);
      expect(res.status).toBe(200);
      expect(res.body.grading_profile_comparisons).toEqual([
        expect.objectContaining({
          availability: 'stale',
          source_run_id: complianceRunId,
          stale: true,
          unavailable_reason: expect.stringContaining('newer authoritative compliance run'),
          profiles: {
            legacy: expect.objectContaining({ available: false, status: null, observed_status: 'passing' }),
            spec: expect.objectContaining({ available: false, status: null, observed_status: 'partial' }),
            sandbox: expect.objectContaining({ available: false, status: null, observed_status: 'passing' }),
          },
        }),
      ]);
    } finally {
      await pool.query('DELETE FROM agent_compliance_runs WHERE id = $1', [newerRun.rows[0].id]);
    }
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

  it('static admin API key can read storyboard status without membership', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const res = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/storyboard-status`);
    expect(res.status).toBe(200);
    expect(res.body.storyboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storyboard_id: 'debug_storyboard',
        status: 'failing',
        steps_passed: 1,
        steps_total: 2,
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: 'debug_step',
        first_failed_step_title: 'Debug step',
        first_failed_step_task: 'get_products',
        first_failure_message: 'debug failure',
      }),
    ]));
  });

  it('owner caller can read storyboard status diagnostics', async () => {
    currentUserId = OWNER_USER_ID;
    const res = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/storyboard-status`);
    expect(res.status).toBe(200);
    expect(res.body.storyboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storyboard_id: 'debug_storyboard',
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: 'debug_step',
        first_failed_step_title: 'Debug step',
        first_failed_step_task: 'get_products',
        first_failure_message: 'debug failure',
      }),
    ]));
  });

  it('cross-org member sees storyboard status counts but not diagnostics', async () => {
    currentUserId = CROSS_ORG_USER_ID;
    const res = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/storyboard-status`);
    expect(res.status).toBe(200);
    expect(res.body.storyboards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storyboard_id: 'debug_storyboard',
        status: 'failing',
        steps_passed: 1,
        steps_total: 2,
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: null,
        first_failed_step_title: null,
        first_failed_step_task: null,
        first_failure_message: null,
      }),
    ]));
  });

  it('static admin API key can read bulk storyboard status through real Postgres SQL', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const res = await request(app)
      .post('/api/registry/agents/storyboard-status')
      .send({ agent_urls: [AGENT_URL] });

    expect(res.status).toBe(200);
    expect(res.body.agents[AGENT_URL]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storyboard_id: 'debug_storyboard',
        status: 'failing',
        steps_passed: 1,
        steps_total: 2,
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: 'debug_step',
        first_failure_message: 'debug failure',
      }),
    ]));
  });

  it('cross-org member sees bulk storyboard status counts but not diagnostics', async () => {
    currentUserId = CROSS_ORG_USER_ID;
    const res = await request(app)
      .post('/api/registry/agents/storyboard-status')
      .send({ agent_urls: [AGENT_URL] });

    expect(res.status).toBe(200);
    expect(res.body.agents[AGENT_URL]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storyboard_id: 'debug_storyboard',
        status: 'failing',
        steps_passed: 1,
        steps_total: 2,
        failure_count: 1,
        skipped_count: 1,
        first_failed_step_id: null,
        first_failed_step_title: null,
        first_failed_step_task: null,
        first_failure_message: null,
      }),
    ]));
  });

  it('keeps partial-run provenance and redacted failures visible only to the owner/operator', async () => {
    const db = new ComplianceDatabase();
    const partial = complianceResultToDbInput({
      completeness: 'timed_out', adcp_version: '3.1.20', overall_status: 'failing',
      agent_profile: { tools: [], adcp_build_version: 'build-immutable-42', library_version: 'seller-sdk-2' },
      summary: { headline: 'Partial', tracks_passed: 0, tracks_failed: 1, tracks_partial: 0, tracks_skipped: 0 },
      tracks: [{ track: 'core', status: 'fail', duration_ms: 1, scenarios: [{
        scenario: 'debug_storyboard/check', overall_passed: false, steps: [{
          step_id: 'debug_step', step: 'Read products', task: 'get_products', passed: false,
          error: 'Expected products array', observation_data: { api_key: 'fixture-secret-value', products: [] },
        }],
      }] }], observations: [], total_duration_ms: 1,
    } as unknown as ComplianceResult, AGENT_URL, 'production', 'owner_test');
    const { run } = await db.recordComplianceRun({ ...partial, dry_run: false });
    try {
      for (const user of [OWNER_USER_ID, STATIC_ADMIN_USER_ID]) {
        currentUserId = user;
        const response = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/diagnostics?run_id=${run.id}`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ run_id: run.id, completeness: 'timed_out', is_authoritative: false,
          provenance: { compliance_bundle_version: '3.1.20', sdk_version: '14.0.0-rc.40', agent_build_version: 'build-immutable-42', agent_library_version: 'seller-sdk-2' },
          diagnostics_visibility: 'owner_or_operator' });
        expect(response.body.diagnostics[0].error_text).toBe('Expected products array');
        expect(JSON.stringify(response.body)).not.toContain('fixture-secret-value');
      }
      for (const user of [null, CROSS_ORG_USER_ID]) {
        currentUserId = user;
        const card = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance`);
        expect(card.body.storyboard_statuses[0].first_failure_message).toBeNull();
        expect(card.body.status).toBe('passing');
        const history = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/history`);
        expect(history.body.runs.some((entry: { id: string }) => entry.id === run.id)).toBe(false);
        const debug = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/diagnostics?run_id=${run.id}`);
        expect(debug.status).toBe(user === null ? 401 : 403);
      }
    } finally {
      await pool.query('DELETE FROM agent_compliance_step_diagnostics WHERE run_id = $1', [run.id]);
      await pool.query('DELETE FROM agent_compliance_runs WHERE id = $1', [run.id]);
    }
  });

  it('keeps observation-only diagnostics useful to owners while redacting public failures and legacy headlines', async () => {
    const db = new ComplianceDatabase();
    const previous = (await pool.query('SELECT * FROM agent_compliance_runs WHERE id = $1', [complianceRunId])).rows[0];
    const observations = [{ category: 'setup', severity: 'error', message: 'Controller fixture setup unavailable', evidence: { api_key: 'fixture-private-key' } }];
    await pool.query('UPDATE agent_compliance_runs SET observations_json = $2, headline = $3, overall_status = $4 WHERE id = $1',
      [complianceRunId, JSON.stringify(observations), 'Failure: api_key=fixture-private-key', 'failing']);
    const { run } = await db.recordComplianceRun({ agent_url: AGENT_URL, lifecycle_stage: 'production',
      overall_status: 'failing', tracks_json: [], completeness: 'not_completed', is_authoritative: false,
      tracks_passed: 0, tracks_failed: 0, tracks_partial: 0, tracks_skipped: 0,
      observations_json: observations, dry_run: false });
    try {
      for (const user of [OWNER_USER_ID, STATIC_ADMIN_USER_ID]) {
        currentUserId = user;
        const card = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance`);
        expect(card.body.observations[0].message).toBe('Controller fixture setup unavailable');
        const debug = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/diagnostics?run_id=${run.id}`);
        expect(debug.body).toMatchObject({ run_id: run.id, completeness: 'not_completed', count: 0, diagnostics: [] });
        expect(debug.body.observations[0].message).toBe('Controller fixture setup unavailable');
        expect(JSON.stringify(debug.body)).not.toContain('fixture-private-key');
        expect(JSON.stringify(card.body)).not.toContain('fixture-private-key');
      }
      currentUserId = null;
      const card = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance`);
      expect(card.body.observations[0].message).not.toContain('Controller fixture');
      expect(JSON.stringify(card.body)).not.toContain('fixture-private-key');
      const history = await request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/history`);
      expect(JSON.stringify(history.body)).not.toContain('fixture-private-key');
    } finally {
      await pool.query('DELETE FROM agent_compliance_runs WHERE id = $1', [run.id]);
      await pool.query('UPDATE agent_compliance_runs SET observations_json = $2, headline = $3, overall_status = $4 WHERE id = $1',
        [complianceRunId, JSON.stringify(previous.observations_json), previous.headline, previous.overall_status]);
    }
  });

  it('static admin API key can read per-step diagnostics for any agent', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const res = await request(app)
      .get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/diagnostics`)
      .query({ run_id: complianceRunId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agent_url: AGENT_URL,
      run_id: complianceRunId,
      count: 1,
    });
    expect(res.body.diagnostics[0]).toMatchObject({
      storyboard_id: 'debug_storyboard',
      step_id: 'debug_step',
      task: 'get_products',
      error_text: 'debug failure',
    });
  });

  it('static admin API key can read outbound monitoring requests for any agent', async () => {
    currentUserId = STATIC_ADMIN_USER_ID;
    const res = await request(app)
      .get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/monitoring/requests`)
      .query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agent_url: AGENT_URL,
      count: 1,
      total: 1,
    });
    expect(res.body.requests[0]).toMatchObject({
      agent_url: AGENT_URL,
      request_type: 'compliance',
      user_agent: 'test-runner',
      success: false,
      error_message: 'debug failure',
    });
  });

  it('cross-org caller still cannot read owner diagnostics or monitoring requests', async () => {
    currentUserId = CROSS_ORG_USER_ID;
    const [diagnosticsRes, monitoringRes] = await Promise.all([
      request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/diagnostics`),
      request(app).get(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/monitoring/requests`),
    ]);
    expect(diagnosticsRes.status).toBe(403);
    expect(monitoringRes.status).toBe(403);
  });
});
