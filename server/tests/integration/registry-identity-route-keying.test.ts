/**
 * Per-agent identity READ routes key the requested URL (#7830 follow-up).
 *
 * #7830 folded the trailing slash into the registry identity key, so the
 * agent stored as `https://x.example/mcp` is the same agent as
 * `https://x.example/mcp/`. The routes that take `:encodedUrl` were still
 * looking the requested URL up raw, so in production
 * `GET /api/registry/agents/{https%3A%2F%2Fadcp.teqblaze.io%2Fmcp%2F}/compliance`
 * returned `status: unknown` with no data while the slashless spelling
 * returned the merged agent. Same for `interchange.io/` and
 * `sell.nofluffadvisory.com/`.
 *
 * Every identity-keyed route must resolve either spelling to the folded
 * agent and echo the canonical `agent_url`. Authorization routes must NOT —
 * see the last case.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_identity_keying';
  process.env.WORKOS_CLIENT_ID ||= 'client_identity_keying';
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  return {
    ...actual,
    requireAuth: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) =>
      res.status(401).json({ error: 'Authentication required' }),
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

const RUN = Math.random().toString(36).slice(2, 8);
/** How the agent is stored after the #7830 fold. */
const CANONICAL = `https://teqblaze-${RUN}.example.com/mcp`;
/** What a caller who remembers the old spelling asks for. */
const SLASHED = `${CANONICAL}/`;
const PUB = `pub-${RUN}.example.com`;

const encode = (url: string) => encodeURIComponent(url);

describe('identity read routes key the requested URL (#7830)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();

    // The fold means these are one agent.
    expect(registryAgentUrlKey(SLASHED)).toBe(CANONICAL);

    await pool.query(
      `INSERT INTO agent_registry_metadata (agent_url, lifecycle_stage) VALUES ($1, 'production')
       ON CONFLICT (agent_url) DO NOTHING`, [CANONICAL]);
    await pool.query(
      `INSERT INTO agent_compliance_status
         (agent_url, status, headline, last_checked_at, adcp_version, updated_at)
       VALUES ($1, 'degraded', 'partial coverage', NOW(), '3.1.29', NOW())
       ON CONFLICT (agent_url) DO UPDATE SET status = EXCLUDED.status`, [CANONICAL]);
    await pool.query(
      `INSERT INTO agent_verification_badges
         (agent_url, role, adcp_version, status, verified_at)
       VALUES ($1, 'media-buy', '3.1', 'active', NOW())
       ON CONFLICT (agent_url, role, adcp_version) DO NOTHING`, [CANONICAL]);
    await pool.query(
      `INSERT INTO agent_storyboard_status
         (agent_url, storyboard_id, status, steps_passed, steps_total)
       VALUES ($1, 'sb-1', 'passing', 3, 3)
       ON CONFLICT (agent_url, storyboard_id) DO NOTHING`, [CANONICAL]);
    await pool.query(
      `INSERT INTO agent_compliance_runs
         (agent_url, lifecycle_stage, overall_status, headline, tracks_json,
          tracks_passed, tracks_failed, tracks_skipped, tracks_partial,
          triggered_by, dry_run, tested_at, adcp_version)
       VALUES ($1, 'production', 'partial', 'partial', '[]'::jsonb,
               1, 0, 0, 1, 'heartbeat', false, NOW(), '3.1.29')`, [CANONICAL]);

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    for (const table of [
      'agent_compliance_runs', 'agent_storyboard_status', 'agent_verification_badges',
      'agent_compliance_status', 'agent_registry_metadata',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE agent_url = $1`, [CANONICAL]);
    }
    await pool.query(`DELETE FROM catalog_agent_authorizations WHERE publisher_domain = $1`, [PUB]);
    await server?.stop();
    await closeDatabase();
  });

  /** The exact production symptom. */
  it('GET /compliance resolves the slashed spelling to the folded agent', async () => {
    const canonical = await request(app).get(`/api/registry/agents/${encode(CANONICAL)}/compliance`);
    expect(canonical.status).toBe(200);
    expect(canonical.body.status).toBe('degraded');

    const slashed = await request(app).get(`/api/registry/agents/${encode(SLASHED)}/compliance`);
    expect(slashed.status).toBe(200);
    // Before the fix this was `unknown` with no data.
    expect(slashed.body.status).toBe('degraded');
    expect(slashed.body.adcp_version).toBe(canonical.body.adcp_version);
    // And the response echoes the canonical spelling, not what was asked for.
    expect(slashed.body.agent_url).toBe(CANONICAL);
  });

  it('GET /verification resolves either spelling', async () => {
    const canonical = await request(app).get(`/api/registry/agents/${encode(CANONICAL)}/verification`);
    const slashed = await request(app).get(`/api/registry/agents/${encode(SLASHED)}/verification`);
    expect(slashed.status).toBe(canonical.status);
    expect(slashed.body.badges?.length).toBe(canonical.body.badges?.length);
    expect(slashed.body.badges?.length).toBeGreaterThan(0);
    expect(slashed.body.agent_url).toBe(CANONICAL);
  });

  // Member-gated routes cannot show the data difference from an anonymous
  // caller, but they can show that the two spellings are indistinguishable —
  // which is the property the fix installs. If one keyed and the other did
  // not, these would diverge the moment a caller authenticated.
  it.each([
    'storyboard-status',
    'monitoring/settings',
    'monitoring/requests',
    'compliance/diagnostics',
  ])('GET /%s treats both spellings identically', async (path) => {
    const canonical = await request(app).get(`/api/registry/agents/${encode(CANONICAL)}/${path}`);
    const slashed = await request(app).get(`/api/registry/agents/${encode(SLASHED)}/${path}`);
    expect(slashed.status).toBe(canonical.status);
    expect(slashed.body).toEqual(canonical.body);
  });

  it('GET /compliance/history resolves either spelling', async () => {
    const canonical = await request(app).get(`/api/registry/agents/${encode(CANONICAL)}/compliance/history`);
    const slashed = await request(app).get(`/api/registry/agents/${encode(SLASHED)}/compliance/history`);
    expect(slashed.status).toBe(canonical.status);
    expect(slashed.body.count).toBe(canonical.body.count);
    expect(slashed.body.count).toBeGreaterThan(0);
    expect(slashed.body.agent_url).toBe(CANONICAL);
  });

  it('GET /badge/:role.svg serves the badge for either spelling', async () => {
    const canonical = await request(app).get(`/api/registry/agents/${encode(CANONICAL)}/badge/media-buy.svg`);
    const slashed = await request(app).get(`/api/registry/agents/${encode(SLASHED)}/badge/media-buy.svg`);
    expect(canonical.status).toBe(200);
    expect(slashed.status).toBe(200);
    expect(slashed.text).toBe(canonical.text);
  });

  it('GET /badge/:role/embed serves the embed for either spelling', async () => {
    const canonical = await request(app).get(`/api/registry/agents/${encode(CANONICAL)}/badge/media-buy/embed`);
    const slashed = await request(app).get(`/api/registry/agents/${encode(SLASHED)}/badge/media-buy/embed`);
    expect(slashed.status).toBe(canonical.status);
    expect(slashed.text).toBe(canonical.text);
  });

  it('keeps the authorization lookup spec-exact', async () => {
    // A publisher that authorized the slashed spelling has NOT authorized
    // the slashless one (#7829). The identity fold must not leak into this
    // route, which is why it does not key its parameter.
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [SLASHED, registryAgentUrlKey(SLASHED), PUB],
    );

    const slashed = await request(app).get(`/api/registry/lookup/agent/${encode(SLASHED)}/domains`);
    expect(slashed.status).toBe(200);
    expect(slashed.body.domains).toContain(PUB);

    const canonical = await request(app).get(`/api/registry/lookup/agent/${encode(CANONICAL)}/domains`);
    expect(canonical.status).toBe(200);
    expect(canonical.body.domains).toEqual([]);
  });
});
