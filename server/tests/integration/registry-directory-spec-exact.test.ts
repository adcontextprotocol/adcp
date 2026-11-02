/**
 * The directory answers authorization questions spec-exactly (#7829/#7830).
 *
 * `catalog_agent_authorizations` keys by IDENTITY, which folds a trailing
 * slash so one agent has one row. Every per-agent read that answers "is this
 * agent authorized" must not inherit that fold: a publisher that authorized
 * `https://a.example/mcp/` has not authorized `https://a.example/mcp`, and
 * the directory must never disagree with the `AgentValidator` that decides
 * the same question against the publisher's live manifest.
 *
 * One case per read site. Each seeds a single authorization declared with a
 * trailing slash, then asserts the listing for the slashless spelling does
 * not report it — and that the slashed spelling still does, so the filter is
 * exact rather than merely restrictive.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { AuthorizationSnapshotDatabase } from '../../src/db/authorization-snapshot-db.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';

const PUB = 'spec-exact.example';
/** What the publisher declared. */
const DECLARED = 'https://agent.spec-exact.example/mcp/';
/** The other spelling — same identity key, different agent to the spec. */
const OTHER = 'https://agent.spec-exact.example/mcp';
const PROPERTY_ID = 'spec_exact_site';
const IDENTIFIER = 'spec-exact-site.example';

describe('directory reads answer spec-exactly (#7829/#7830)', () => {
  let pool: Pool;
  let db: FederatedIndexDatabase;
  let snapshotDb: AuthorizationSnapshotDatabase;
  let propertyRid: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    db = new FederatedIndexDatabase();
    snapshotDb = new AuthorizationSnapshotDatabase();
  });

  async function clearFixtures() {
    await pool.query(`DELETE FROM catalog_agent_authorizations WHERE publisher_domain = $1
                        OR property_rid IN (SELECT property_rid FROM catalog_properties
                                             WHERE created_by = $2)`,
      [PUB, `adagents_json:${PUB}`]);
    await pool.query(`DELETE FROM catalog_identifiers WHERE property_rid IN (
                        SELECT property_rid FROM catalog_properties WHERE created_by = $1)`,
      [`adagents_json:${PUB}`]);
    await pool.query(`DELETE FROM catalog_properties WHERE created_by = $1`,
      [`adagents_json:${PUB}`]);
    await pool.query(`DELETE FROM publishers WHERE domain = $1`, [PUB]);
  }

  beforeEach(async () => {
    await clearFixtures();
    await pool.query(
      `INSERT INTO publishers (domain, source_type, adagents_json)
       VALUES ($1, 'adagents_json', $2::jsonb)`,
      [PUB, JSON.stringify({
        authorized_agents: [{ url: DECLARED }],
        // The property readers slug-match catalog rows to manifest entries.
        properties: [{
          property_id: PROPERTY_ID,
          property_type: 'website',
          name: 'Spec Exact Site',
          identifiers: [{ type: 'domain', value: IDENTIFIER }],
        }],
      })],
    );
    const { rows } = await pool.query<{ property_rid: string }>(
      `INSERT INTO catalog_properties
         (property_rid, property_id, classification, source, status, created_by)
       VALUES (gen_random_uuid(), $1, 'property', 'authoritative', 'active', $2)
       RETURNING property_rid::text AS property_rid`,
      [PROPERTY_ID, `adagents_json:${PUB}`],
    );
    propertyRid = rows[0].property_rid;
    await pool.query(
      `INSERT INTO catalog_identifiers
         (id, property_rid, identifier_type, identifier_value, evidence, confidence)
       VALUES (gen_random_uuid(), $1, 'domain', $2, 'adagents_json', 'authoritative')`,
      [propertyRid, IDENTIFIER],
    );
    // One publisher-wide row and one per-property row, both declared with
    // the trailing slash. The identity key folds it; the directory must not.
    const key = registryAgentUrlKey(DECLARED)!;
    expect(key).toBe(OTHER);
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [DECLARED, key, PUB],
    );
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, property_rid, property_id_slug, evidence)
       VALUES ($1, $2, $3, $4, 'adagents_json')`,
      [DECLARED, key, propertyRid, PROPERTY_ID],
    );
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  it('getDomainsForAgent', async () => {
    expect((await db.getDomainsForAgent(DECLARED)).map(r => r.publisher_domain)).toEqual([PUB]);
    expect(await db.getDomainsForAgent(OTHER)).toEqual([]);
  });

  it('getPublishersForAgentDetail', async () => {
    const declared = await db.getPublishersForAgentDetail(DECLARED, { limit: 10 });
    expect(declared.map(r => r.publisher_domain)).toEqual([PUB]);
    expect(await db.getPublishersForAgentDetail(OTHER, { limit: 10 })).toEqual([]);
  });

  it('bulkGetFirstAuthForAgents', async () => {
    const declared = await db.bulkGetFirstAuthForAgents([DECLARED]);
    expect(declared.get(DECLARED)?.publisher_domain).toBe(PUB);
    const other = await db.bulkGetFirstAuthForAgents([OTHER]);
    expect(other.get(OTHER)).toBeUndefined();
  });

  it('getPropertiesForAgent', async () => {
    expect((await db.getPropertiesForAgent(DECLARED)).map(p => p.property_id)).toEqual([PROPERTY_ID]);
    expect(await db.getPropertiesForAgent(OTHER)).toEqual([]);
  });

  it('getPropertiesForAgentDomain', async () => {
    expect((await db.getPropertiesForAgentDomain(DECLARED, PUB)).map(p => p.property_id))
      .toEqual([PROPERTY_ID]);
    expect(await db.getPropertiesForAgentDomain(OTHER, PUB)).toEqual([]);
  });

  it('getPublisherDomainsForAgent', async () => {
    expect(await db.getPublisherDomainsForAgent(DECLARED)).toEqual([PUB]);
    expect(await db.getPublisherDomainsForAgent(OTHER)).toEqual([]);
  });

  it('isPropertyAuthorizedForAgent', async () => {
    await expect(db.isPropertyAuthorizedForAgent(DECLARED, 'domain', IDENTIFIER))
      .resolves.toMatchObject({ authorized: true });
    await expect(db.isPropertyAuthorizedForAgent(OTHER, 'domain', IDENTIFIER))
      .resolves.toEqual({ authorized: false });
  });

  it('validateAgentForProduct (via getAuthorizationSource)', async () => {
    // An "all properties at this publisher" selector resolves through
    // getAuthorizationSource, which is the read site under test.
    const selector = { publisher_domain: PUB, selection_type: 'all' as const };
    const declared = await db.validateAgentForProduct(DECLARED, [selector]);
    expect(declared.selectors[0].source).not.toBe('none');
    const other = await db.validateAgentForProduct(OTHER, [selector]);
    expect(other.selectors[0].source).toBe('none');
  });

  it('authorization snapshot getNarrow', async () => {
    const declared = await snapshotDb.getNarrow({
      agentUrl: DECLARED,
      agentUrlCanonical: registryAgentUrlKey(DECLARED)!,
      evidence: ['adagents_json'],
      include: 'effective',
    });
    expect(declared.rows.length).toBeGreaterThan(0);

    const other = await snapshotDb.getNarrow({
      agentUrl: OTHER,
      agentUrlCanonical: registryAgentUrlKey(OTHER)!,
      evidence: ['adagents_json'],
      include: 'effective',
    });
    expect(other.rows).toEqual([]);
  });

  it('agrees with the validator about which spelling is authorized', async () => {
    // The whole point: the directory and the #7829 validator answer the same
    // question the same way. Both say yes to the declared spelling and no to
    // the other one.
    const { AgentValidator } = await import('../../src/validator.js');
    const dns = (await import('node:dns/promises')).default;
    const { vi } = await import('vitest');
    vi.spyOn(dns, 'lookup').mockResolvedValue(
      [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ authorized_agents: [{ url: DECLARED }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })));
    try {
      const validator = new AgentValidator();
      await expect(validator.validate(PUB, DECLARED)).resolves.toMatchObject({ authorized: true });
      await expect(validator.validate(PUB, OTHER)).resolves.toMatchObject({ authorized: false });
      expect((await db.getDomainsForAgent(DECLARED)).length).toBeGreaterThan(0);
      expect(await db.getDomainsForAgent(OTHER)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
