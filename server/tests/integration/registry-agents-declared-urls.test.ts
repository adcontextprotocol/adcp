/**
 * The agents listing exposes every declared spelling of an agent's URL
 * (#7830 follow-up to #8312/#8314).
 *
 * The registry lists an agent once, under its folded identity key: `/mcp`
 * and `/mcp/` are one agent. The directory answers authorization questions
 * spec-exactly, with the trailing slash significant (#7829, #8314). Those
 * two rules are both right, and together they left a hole: the public
 * agents page asked `GET /v1/agents/{listed url}/publishers`, so an agent
 * whose publishers declared it as `/mcp/` showed no publisher
 * authorizations at all — the page was asking about a spelling no
 * publisher ever wrote.
 *
 * `declared_urls` closes it: the listing reports the spellings that exist,
 * and the page asks about each. These cases pin the server half end to end
 * — the listing field, and the fact that the directory really does answer
 * only the slashed spelling.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { MemberDatabase } from '../../src/db/member-db.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_declared_urls';
  process.env.WORKOS_CLIENT_ID ||= 'client_declared_urls';
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
const ORG = `org_declared_urls_${RUN}`;
const SLUG = `declared-urls-${RUN}`;
/** How the registry lists the agent after the #7830 fold. */
const CANONICAL = `https://agent-${RUN}.declared-urls.example/mcp`;
/** How the publisher's adagents.json spells it. */
const SLASHED = `${CANONICAL}/`;
const PUB = `pub-${RUN}.declared-urls.example`;
const PROPERTY_ID = `declared_urls_site_${RUN}`;

const encode = (url: string) => encodeURIComponent(url);

describe('registry listing exposes declared agent_url spellings (#7830)', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    expect(registryAgentUrlKey(SLASHED)).toBe(CANONICAL);

    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at, updated_at)
       VALUES ($1, $2, true, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG, `Declared URLs ${RUN}`],
    );
    // The owner registered the slashed spelling; the registry keys it folded
    // and keeps the registered spelling in declared_url.
    await new MemberDatabase().createProfile({
      workos_organization_id: ORG,
      display_name: `Declared URLs ${RUN}`,
      slug: SLUG,
      is_public: true,
      agents: [{ url: SLASHED, visibility: 'public', type: 'sales', name: `Agent ${RUN}` }],
    });

    await pool.query(
      `INSERT INTO publishers (domain, source_type, adagents_json, last_validated)
       VALUES ($1, 'adagents_json', $2::jsonb, NOW())`,
      [PUB, JSON.stringify({
        authorized_agents: [{ url: SLASHED }],
        properties: [{
          property_id: PROPERTY_ID,
          property_type: 'website',
          name: `Declared URLs Site ${RUN}`,
          identifiers: [{ type: 'domain', value: PUB }],
        }],
      })],
    );
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [SLASHED, registryAgentUrlKey(SLASHED), PUB],
    );

    // One property under that publisher, authorized for the same slashed
    // spelling, so the listing's property enrichment has something to find.
    const { rows } = await pool.query<{ property_rid: string }>(
      `INSERT INTO catalog_properties
         (property_rid, property_id, classification, source, status, created_by)
       VALUES (gen_random_uuid(), $1, 'property', 'authoritative', 'active', $2)
       RETURNING property_rid::text AS property_rid`,
      [PROPERTY_ID, `adagents_json:${PUB}`],
    );
    await pool.query(
      `INSERT INTO catalog_identifiers
         (id, property_rid, identifier_type, identifier_value, evidence, confidence)
       VALUES (gen_random_uuid(), $1, 'domain', $2, 'adagents_json', 'authoritative')`,
      [rows[0].property_rid, PUB],
    );
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, property_rid, property_id_slug, evidence)
       VALUES ($1, $2, $3, $4, 'adagents_json')`,
      [SLASHED, registryAgentUrlKey(SLASHED), rows[0].property_rid, PROPERTY_ID],
    );

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE publisher_domain = $1
           OR property_rid IN (SELECT property_rid FROM catalog_properties WHERE created_by = $2)`,
      [PUB, `adagents_json:${PUB}`],
    );
    await pool.query(
      `DELETE FROM catalog_identifiers WHERE property_rid IN (
         SELECT property_rid FROM catalog_properties WHERE created_by = $1)`,
      [`adagents_json:${PUB}`],
    );
    await pool.query('DELETE FROM catalog_properties WHERE created_by = $1', [`adagents_json:${PUB}`]);
    await pool.query('DELETE FROM publishers WHERE domain = $1', [PUB]);
    await pool.query('DELETE FROM member_profiles WHERE workos_organization_id = $1', [ORG]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG]);
    await server?.stop();
    await closeDatabase();
  });

  async function listedAgent(query = ''): Promise<Record<string, unknown> | undefined> {
    const res = await request(app).get(`/api/registry/agents${query}`);
    expect(res.status).toBe(200);
    return (res.body.agents as Array<Record<string, unknown>>).find(a => a.url === CANONICAL);
  }

  it('lists the agent under its folded identity url', async () => {
    const agent = await listedAgent();
    expect(agent).toBeDefined();
    expect(agent!.url).toBe(CANONICAL);
  });

  it('reports every declared spelling, listed url first', async () => {
    const agent = await listedAgent();
    const declared = agent!.declared_urls as string[];
    expect(declared[0]).toBe(CANONICAL);
    // The owner's registered spelling and the publisher's are both the
    // slashed one; it must appear, and the list must not duplicate it.
    expect(declared).toContain(SLASHED);
    expect(declared).toEqual([...new Set(declared)]);
  });

  it('is present on the unenriched listing too', async () => {
    const agent = await listedAgent('?type=sales');
    expect(agent!.declared_urls).toContain(SLASHED);
  });

  it('is the only way to reach this agent\'s publishers, because the directory is spec-exact', async () => {
    const folded = await request(app).get(`/api/v1/agents/${encode(CANONICAL)}/publishers`);
    // 404 "never indexed" — correct, and the reason the page needs the list.
    expect(folded.status).toBe(404);

    const declared = await request(app).get(`/api/v1/agents/${encode(SLASHED)}/publishers`);
    expect(declared.status).toBe(200);
    expect(declared.body.publishers.map((p: { publisher_domain: string }) => p.publisher_domain))
      .toEqual([PUB]);
  });

  it('enriches properties across the declared spellings, not just the folded url', async () => {
    const agent = await listedAgent('?properties=true');
    // getPropertiesForAgent / getPublisherDomainsForAgent are spec-exact
    // reads too, so asking with the folded url alone found nothing here
    // either and the agent rendered with no properties at all.
    expect(agent!.publisher_domains).toContain(PUB);
    expect((agent!.property_summary as { total_count: number }).total_count).toBe(1);
  });

  it('answers the merged publisher set the page builds from declared_urls', async () => {
    const agent = await listedAgent();
    const spellings = agent!.declared_urls as string[];
    const merged = new Set<string>();
    for (const spelling of spellings) {
      const res = await request(app).get(`/api/v1/agents/${encode(spelling)}/publishers`);
      if (res.status === 404) continue;
      expect(res.status).toBe(200);
      for (const p of res.body.publishers as Array<{ publisher_domain: string }>) {
        merged.add(p.publisher_domain);
      }
    }
    // Before this change the page asked only about CANONICAL and rendered
    // "No indexed publisher authorizations are available for this agent yet."
    expect([...merged]).toEqual([PUB]);
  });
});
