/**
 * The AAO directory inverse-lookup answers spec-exactly over HTTP
 * (#7829/#7830 follow-up).
 *
 * `GET /v1/agents/{agent_url}/publishers` used to run its parameter through
 * `canonicalizeAgentUrl` — the registry IDENTITY key, which folds a non-root
 * trailing slash — before handing it to `getPublishersForAgentDetail`. The
 * DB helper is spec-exact by design (it keys for the index and then
 * restricts to the raw `agent_url` spellings that match), but it was being
 * handed an already-folded URL, so a request for `https://a.example/mcp/`
 * came back with `https://a.example/mcp`'s publishers: an authorization the
 * publisher's adagents.json does not grant, and a direct disagreement with
 * the `AgentValidator` and with the sibling `/domains` route.
 *
 * These cases pin the two directory routes to the SAME answer for BOTH
 * spellings, which is the invariant that was broken.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_publishers_spec_exact';
  process.env.WORKOS_CLIENT_ID ||= 'client_publishers_spec_exact';
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  return {
    ...actual,
    requireAuth: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) =>
      res.status(401).json({ error: 'Authentication required' }),
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const RUN = Math.random().toString(36).slice(2, 8);
const PUB = `pub-${RUN}.directory-spec-exact.example`;
/** The spelling the publisher's adagents.json declares. */
const DECLARED = `https://agent-${RUN}.directory-spec-exact.example/mcp/`;
/** The other spelling: same identity key, a different agent to the spec. */
const OTHER = `https://agent-${RUN}.directory-spec-exact.example/mcp`;

const encode = (url: string) => encodeURIComponent(url);

describe('directory /publishers matches agent_url spec-exactly (#7829/#7830)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    // The identity key folds the two spellings; the directory must not.
    expect(registryAgentUrlKey(DECLARED)).toBe(OTHER);
    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  async function clearFixtures() {
    await pool.query('DELETE FROM catalog_agent_authorizations WHERE publisher_domain = $1', [PUB]);
    await pool.query('DELETE FROM agent_publisher_authorizations WHERE publisher_domain = $1', [PUB]);
    await pool.query('DELETE FROM publishers WHERE domain = $1', [PUB]);
  }

  beforeEach(async () => {
    await clearFixtures();
    await pool.query(
      `INSERT INTO publishers (domain, source_type, adagents_json, last_validated)
       VALUES ($1, 'adagents_json', $2::jsonb, NOW())`,
      [PUB, JSON.stringify({ authorized_agents: [{ url: DECLARED }] })],
    );
    // One publisher-wide authorization, declared WITH the trailing slash.
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [DECLARED, registryAgentUrlKey(DECLARED), PUB],
    );
  });

  afterAll(async () => {
    await clearFixtures();
    await server?.stop();
    await closeDatabase();
  });

  /**
   * Publisher domains the inverse-lookup reports for `agentUrl`. A 404 means
   * "never indexed", which for this comparison is the same answer as an
   * empty page: no publisher authorizes this spelling.
   */
  async function publishersFor(agentUrl: string, path = '/api/v1/agents'): Promise<string[]> {
    const res = await request(app).get(`${path}/${encode(agentUrl)}/publishers`);
    if (res.status === 404) return [];
    expect(res.status).toBe(200);
    expect(res.body.agent_url).toBeTruthy();
    return (res.body.publishers as Array<{ publisher_domain: string }>).map(p => p.publisher_domain);
  }

  async function domainsFor(agentUrl: string): Promise<string[]> {
    const res = await request(app).get(`/api/registry/lookup/agent/${encode(agentUrl)}/domains`);
    expect(res.status).toBe(200);
    return res.body.domains as string[];
  }

  it('reports the publisher for the declared spelling', async () => {
    expect(await publishersFor(DECLARED)).toEqual([PUB]);
  });

  it('does NOT report it for the other spelling', async () => {
    // This is the regression: the fold made this return [PUB].
    expect(await publishersFor(OTHER)).toEqual([]);
  });

  it('agrees with /domains on both spellings', async () => {
    expect(await publishersFor(DECLARED)).toEqual(await domainsFor(DECLARED));
    expect(await publishersFor(OTHER)).toEqual(await domainsFor(OTHER));
  });

  it('answers the same way on the spec-conformant /v1 mount', async () => {
    expect(await publishersFor(DECLARED, '/v1/agents')).toEqual([PUB]);
    expect(await publishersFor(OTHER, '/v1/agents')).toEqual([]);
  });

  it('404s the unindexed spelling rather than reporting the folded agent', async () => {
    const res = await request(app).get(`/api/v1/agents/${encode(OTHER)}/publishers`);
    expect(res.status).toBe(404);
    expect(res.body.agent_url).toBe(OTHER);
  });

  it('echoes the canonicalized lookup key with the trailing slash preserved', async () => {
    // Host case is normalized away; the significant trailing slash is not.
    const shoutyHost = `https://AGENT-${RUN.toUpperCase()}.DIRECTORY-SPEC-EXACT.EXAMPLE/mcp/`;
    const res = await request(app).get(`/api/v1/agents/${encode(shoutyHost)}/publishers`);
    expect(res.status).toBe(200);
    expect(res.body.agent_url).toBe(DECLARED);
    expect(res.body.publishers.map((p: { publisher_domain: string }) => p.publisher_domain)).toEqual([PUB]);
  });

  it('still serves an agent whose authorization has no trailing slash', async () => {
    // Exactness has to cut both ways: seed the slashless spelling and the
    // slashed one must stop resolving.
    await pool.query('DELETE FROM catalog_agent_authorizations WHERE publisher_domain = $1', [PUB]);
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [OTHER, registryAgentUrlKey(OTHER), PUB],
    );
    expect(await publishersFor(OTHER)).toEqual([PUB]);
    expect(await publishersFor(DECLARED)).toEqual([]);
    expect(await publishersFor(OTHER)).toEqual(await domainsFor(OTHER));
    expect(await publishersFor(DECLARED)).toEqual(await domainsFor(DECLARED));
  });
});
