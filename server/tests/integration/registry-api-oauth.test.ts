/**
 * Integration tests for the registry-api OAuth credential-save endpoints.
 * Exercises the HTTP contract end-to-end against a real Postgres, closing
 * gaps the resolver/parser unit tests don't cover: SSRF validation, ownership
 * gating, error-response shape, rate-limit wiring, and the full save →
 * auth-status → test-exchange flow.
 *
 * Run locally against a Postgres reachable at DATABASE_URL (default
 * matches the other integration tests at port 53198):
 *
 *   DATABASE_URL=postgresql://adcp:localdev@localhost:53198/adcp_test \
 *     npx vitest run server/tests/integration/registry-api-oauth.test.ts
 *
 * Closes #2806 for the OAuth credential-save surface. The same harness
 * pattern extends cleanly to the four Test-your-agent storyboard endpoints
 * and /auth-status in follow-ups.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const TEST_USER_ID = 'user_test_oauth_integration';
const TEST_ORG_ID = 'org_test_oauth_integration';
const TEST_AGENT_URL = 'https://agent.example.com';
const OTHER_AGENT_URL = 'https://another-agent.example.com';

// Bypass WorkOS auth — stamp every request with a fixed test user. Keep
// every other export from the real module so the HTTPServer doesn't
// crash on missing helpers (optionalAuth, requireRole, etc.).
vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: TEST_USER_ID, email: 'oauth-int@test.com' };
    next();
  };
  return {
    ...actual,
    requireAuth: pass,
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

// CSRF middleware looks for a cookie + matching header on writes. In
// production the frontend's `/csrf.js` monkey-patches fetch to attach the
// header; supertest doesn't run that. Short-circuit the middleware so
// write-endpoint tests don't need a cookie-jar dance.
vi.mock('../../src/middleware/csrf.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/csrf.js');
  return {
    ...actual,
    csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

// Stop Stripe init from hitting the network on startup.
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

// Intercept the SDK's outbound token exchange so the /test endpoint doesn't
// hit a real authorization server. Default to a clean success; individual
// tests can re-mock per-case.
const exchangeMock = vi.fn();
vi.mock('@adcp/client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@adcp/client');
  return {
    ...actual,
    exchangeClientCredentials: (...args: unknown[]) => exchangeMock(...args),
  };
});

// BASE_URL must parse as a valid URL at HTTPServer construction time (MCP
// router runs `new URL(...)` during setup). The vitest setup file at
// `server/tests/setup/revenue-tracking-env.ts` forces a known-good value.

describe('registry-api OAuth credential endpoints (integration)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    // Seed: org, member_profile with this agent in its agents[] list, and
    // the membership row linking our test user to the org. The three
    // together satisfy `resolveAgentOwnerOrg`'s ownership join.
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Test OAuth Integration Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [TEST_ORG_ID],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_organization_id, workos_user_id, email, role, created_at, updated_at)
       VALUES ($1, $2, 'oauth-int@test.com', 'admin', NOW(), NOW())
       ON CONFLICT (workos_organization_id, workos_user_id) DO NOTHING`,
      [TEST_ORG_ID, TEST_USER_ID],
    );
    await pool.query(
      `INSERT INTO member_profiles (workos_organization_id, display_name, slug, agents, created_at, updated_at)
       VALUES ($1, 'Test OAuth Integration Org', 'test-oauth-integration', $2::jsonb, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO UPDATE SET agents = EXCLUDED.agents, updated_at = NOW()`,
      [TEST_ORG_ID, JSON.stringify([{ url: TEST_AGENT_URL, name: 'Test agent' }])],
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    // Tear down in FK order.
    await pool.query('DELETE FROM agent_contexts WHERE organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [TEST_ORG_ID]);
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clear saved credentials between tests so each case starts from a
    // known state. Also reset the SDK-exchange mock.
    await pool.query('DELETE FROM agent_contexts WHERE organization_id = $1', [TEST_ORG_ID]);
    exchangeMock.mockReset();
  });

  // ── PUT /connect ────────────────────────────────────────────────

  describe('PUT /api/registry/agents/:encodedUrl/connect', () => {
    const url = `/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/connect`;

    it('saves a bearer token and returns agent_context_id', async () => {
      const res = await request(app).put(url).send({ auth_token: 'test-bearer-123', auth_type: 'bearer' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ connected: true, has_auth: true });
      expect(res.body.agent_context_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('creates a context without an auth_token (for OAuth-flow prep)', async () => {
      const res = await request(app).put(url).send({});
      expect(res.status).toBe(200);
      expect(res.body.has_auth).toBe(false);
      expect(res.body.agent_context_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns 403 for an agent the user does not own', async () => {
      const res = await request(app)
        .put(`/api/registry/agents/${encodeURIComponent(OTHER_AGENT_URL)}/connect`)
        .send({ auth_token: 'test-bearer-123', auth_type: 'bearer' });
      expect(res.status).toBe(403);
    });

    it('returns 400 when auth_type is outside the enum', async () => {
      const res = await request(app).put(url).send({ auth_token: 'x', auth_type: 'bogus' });
      expect(res.status).toBe(400);
    });
  });

  // ── PUT /oauth-client-credentials ───────────────────────────────

  describe('PUT /api/registry/agents/:encodedUrl/oauth-client-credentials', () => {
    const url = `/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/oauth-client-credentials`;
    const validBody = {
      token_endpoint: 'https://auth.example.com/oauth/token',
      client_id: 'client_abc',
      client_secret: 'literal-secret-value',
    };

    it('saves a valid minimal config and returns 200', async () => {
      const res = await request(app).put(url).send(validBody);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        connected: true,
        has_auth: true,
        auth_type: 'oauth_client_credentials',
      });
    });

    it('persists the full config including optional fields', async () => {
      await request(app)
        .put(url)
        .send({ ...validBody, scope: 'adcp', resource: TEST_AGENT_URL, auth_method: 'body' })
        .expect(200);

      const r = await pool.query(
        `SELECT oauth_cc_scope, oauth_cc_resource, oauth_cc_auth_method
         FROM agent_contexts WHERE organization_id = $1 AND agent_url = $2`,
        [TEST_ORG_ID, TEST_AGENT_URL],
      );
      expect(r.rows[0]).toMatchObject({
        oauth_cc_scope: 'adcp',
        oauth_cc_resource: TEST_AGENT_URL,
        oauth_cc_auth_method: 'body',
      });
    });

    it('returns 400 when token_endpoint is a cloud-metadata host (SSRF guard)', async () => {
      const res = await request(app)
        .put(url)
        .send({ ...validBody, token_endpoint: 'http://169.254.169.254/latest/meta-data/' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/token_endpoint/i);
    });

    it('returns 400 when client_secret uses an unauthorized $ENV: reference', async () => {
      const res = await request(app)
        .put(url)
        .send({ ...validBody, client_secret: '$ENV:DATABASE_URL' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/\$ENV/);
    });

    it('returns 400 when a required field is missing', async () => {
      const { client_id: _, ...missing } = validBody;
      const res = await request(app).put(url).send(missing);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/client_id/);
    });

    it('returns 403 for an agent the user does not own', async () => {
      const res = await request(app)
        .put(`/api/registry/agents/${encodeURIComponent(OTHER_AGENT_URL)}/oauth-client-credentials`)
        .send(validBody);
      expect(res.status).toBe(403);
    });
  });

  // ── POST /oauth-client-credentials/test ─────────────────────────

  describe('POST /api/registry/agents/:encodedUrl/oauth-client-credentials/test', () => {
    const testUrl = `/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/oauth-client-credentials/test`;
    const saveUrl = `/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/oauth-client-credentials`;
    const validBody = {
      token_endpoint: 'https://auth.example.com/oauth/token',
      client_id: 'client_abc',
      client_secret: 'literal-secret-value',
    };

    it('returns 404 when no credentials are saved for this agent', async () => {
      const res = await request(app).post(testUrl).send({});
      expect(res.status).toBe(404);
    });

    it('returns { ok: true, latency_ms } on a successful exchange', async () => {
      await request(app).put(saveUrl).send(validBody).expect(200);
      exchangeMock.mockResolvedValueOnce({ access_token: 'new-access', token_type: 'Bearer' });

      const res = await request(app).post(testUrl).send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.latency_ms).toBe('number');
    });

    it('returns { ok: false, error: { kind: "oauth", ... } } when the AS rejects the client', async () => {
      await request(app).put(saveUrl).send(validBody).expect(200);

      const { ClientCredentialsExchangeError } = await vi.importActual<{
        ClientCredentialsExchangeError: new (
          m: string, k: 'oauth' | 'malformed' | 'network',
          oe?: string, oed?: string, hs?: number,
        ) => Error;
      }>('@adcp/client');
      exchangeMock.mockRejectedValueOnce(
        new ClientCredentialsExchangeError(
          'Client authentication failed', 'oauth', 'invalid_client',
          'Client credentials did not match any registered client', 401,
        ),
      );

      const res = await request(app).post(testUrl).send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatchObject({
        kind: 'oauth',
        oauth_error: 'invalid_client',
        http_status: 401,
      });
    });

    it('returns 403 when the user does not own the agent', async () => {
      const res = await request(app)
        .post(`/api/registry/agents/${encodeURIComponent(OTHER_AGENT_URL)}/oauth-client-credentials/test`)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  // ── GET /auth-status ────────────────────────────────────────────

  describe('GET /api/registry/agents/:encodedUrl/auth-status', () => {
    const statusUrl = `/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/auth-status`;

    it('reports has_auth: false when nothing is saved', async () => {
      const res = await request(app).get(statusUrl);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ has_auth: false, has_oauth_client_credentials: false });
    });

    it('reports the static auth type after saving a bearer', async () => {
      await request(app)
        .put(`/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/connect`)
        .send({ auth_token: 'test-bearer', auth_type: 'bearer' })
        .expect(200);

      const res = await request(app).get(statusUrl).expect(200);
      expect(res.body).toMatchObject({ has_auth: true, auth_type: 'bearer' });
    });

    it('reports oauth_client_credentials after saving cc config', async () => {
      await request(app)
        .put(`/api/registry/agents/${encodeURIComponent(TEST_AGENT_URL)}/oauth-client-credentials`)
        .send({
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'c',
          client_secret: 's',
        })
        .expect(200);

      const res = await request(app).get(statusUrl).expect(200);
      expect(res.body).toMatchObject({
        has_auth: true,
        has_oauth_client_credentials: true,
        auth_type: 'oauth_client_credentials',
      });
    });
  });
});
