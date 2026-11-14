/**
 * The registry directory applies origin-only `authorized_agents[].url`
 * matching exactly as `AgentValidator` does (#8943, DR-0023).
 *
 * An origin-only entry (`https://agent.example`) is keyed under the ORIGIN's
 * identity key, yet authorizes every agent URL at that origin. Each per-agent
 * authorization read must therefore look up both the agent's key and its
 * origin's key, then keep only the raw spellings `agentUrlAuthorizedBy`
 * accepts. An entry with a path stays exact.
 *
 * The fixture table is the same one tests/unit/authorized-agent-url-matching
 * runs the validator against; the last case here runs both sides on every
 * row and asserts they agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Pool } from 'pg';
import dns from 'node:dns/promises';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { AuthorizationSnapshotDatabase } from '../../src/db/authorization-snapshot-db.js';
import { registryAgentUrlKey } from '../../src/db/registry-agent-url-key.js';
import { AgentValidator } from '../../src/validator.js';
import { FederatedIndexService } from '../../src/federated-index.js';
import {
  AUTHORIZED_CASES,
  UNAUTHORIZED_CASES,
} from '../fixtures/authorized-agent-url-matching.js';

const PUB_SUFFIX = '.origin-only.example';
const ORIGIN_PUB = `origin${PUB_SUFFIX}`;
const PATH_PUB = `path${PUB_SUFFIX}`;
const ORIGIN_ENTRY = 'https://agent.origin-only.example';
const PATH_ENTRY = 'https://agent.origin-only.example/tenants/acme/mcp';
const DEEP_AGENT = 'https://agent.origin-only.example/mcp';
const PROPERTY_ID = 'origin_only_site';
const IDENTIFIER = 'origin-only-site.example';

const ALL_CASES = [...AUTHORIZED_CASES, ...UNAUTHORIZED_CASES];
const casePub = (i: number) => `case${i}${PUB_SUFFIX}`;

describe('directory reads apply origin-only matching (#8943)', () => {
  let pool: Pool;
  let db: FederatedIndexDatabase;
  let snapshotDb: AuthorizationSnapshotDatabase;

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
    const likePub = `%${PUB_SUFFIX}`;
    await pool.query(
      `DELETE FROM catalog_agent_authorizations
        WHERE publisher_domain LIKE $1
           OR property_rid IN (SELECT property_rid FROM catalog_properties WHERE created_by LIKE $2)`,
      [likePub, `adagents_json:${likePub}`]);
    await pool.query(
      `DELETE FROM catalog_identifiers WHERE property_rid IN (
         SELECT property_rid FROM catalog_properties WHERE created_by LIKE $1)`,
      [`adagents_json:${likePub}`]);
    await pool.query(`DELETE FROM catalog_properties WHERE created_by LIKE $1`, [`adagents_json:${likePub}`]);
    await pool.query(`DELETE FROM publishers WHERE domain LIKE $1`, [likePub]);
    // The writes above fire change-feed triggers (catalog_events). Drop the
    // events this file caused, last, so they cannot crowd another file's
    // events off the first page of the shared feed (registry-feed.test.ts
    // reads the feed from the start with the default page size).
    await pool.query(
      `DELETE FROM catalog_events WHERE payload::text LIKE $1 OR payload::text LIKE $2`,
      ['%origin-only.example%', '%agent.example.com%'],
    );
  }

  async function seedPublisherWide(publisherDomain: string, entryUrl: string, signingKeys = false) {
    await pool.query(
      `INSERT INTO publishers (domain, source_type, adagents_json)
       VALUES ($1, 'adagents_json', $2::jsonb)
       ON CONFLICT (domain) DO NOTHING`,
      [publisherDomain, JSON.stringify({
        authorized_agents: [{
          url: entryUrl,
          ...(signingKeys ? { signing_keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'k1' }] } : {}),
        }],
      })],
    );
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [entryUrl, registryAgentUrlKey(entryUrl)!, publisherDomain],
    );
  }

  beforeEach(async () => {
    await clearFixtures();
    // ORIGIN_PUB lists the bare origin and pins a signing key on it; it also
    // has one property authorized to the origin-only entry.
    await pool.query(
      `INSERT INTO publishers (domain, source_type, adagents_json)
       VALUES ($1, 'adagents_json', $2::jsonb)`,
      [ORIGIN_PUB, JSON.stringify({
        authorized_agents: [{
          url: ORIGIN_ENTRY,
          signing_keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'k1' }],
        }],
        properties: [{
          property_id: PROPERTY_ID,
          property_type: 'website',
          name: 'Origin Only Site',
          identifiers: [{ type: 'domain', value: IDENTIFIER }],
        }],
      })],
    );
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [ORIGIN_ENTRY, registryAgentUrlKey(ORIGIN_ENTRY)!, ORIGIN_PUB],
    );
    const { rows } = await pool.query<{ property_rid: string }>(
      `INSERT INTO catalog_properties
         (property_rid, property_id, classification, source, status, created_by)
       VALUES (gen_random_uuid(), $1, 'property', 'authoritative', 'active', $2)
       RETURNING property_rid::text AS property_rid`,
      [PROPERTY_ID, `adagents_json:${ORIGIN_PUB}`],
    );
    await pool.query(
      `INSERT INTO catalog_identifiers
         (id, property_rid, identifier_type, identifier_value, evidence, confidence)
       VALUES (gen_random_uuid(), $1, 'domain', $2, 'adagents_json', 'authoritative')`,
      [rows[0].property_rid, IDENTIFIER],
    );
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, property_rid, property_id_slug, evidence)
       VALUES ($1, $2, $3, $4, 'adagents_json')`,
      [ORIGIN_ENTRY, registryAgentUrlKey(ORIGIN_ENTRY)!, rows[0].property_rid, PROPERTY_ID],
    );
    // PATH_PUB lists one tenant's full URL on the same host.
    await seedPublisherWide(PATH_PUB, PATH_ENTRY);
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  it('getDomainsForAgent: origin-only entry covers a deeper path; path entry stays exact', async () => {
    const deep = (await db.getDomainsForAgent(DEEP_AGENT)).map(r => r.publisher_domain);
    expect(deep).toContain(ORIGIN_PUB);
    expect(deep).not.toContain(PATH_PUB);

    const tenant = (await db.getDomainsForAgent(PATH_ENTRY)).map(r => r.publisher_domain).sort();
    expect(tenant).toEqual([ORIGIN_PUB, PATH_PUB].sort());

    const otherTenant = (await db.getDomainsForAgent('https://agent.origin-only.example/tenants/zenith/mcp'))
      .map(r => r.publisher_domain);
    expect(otherTenant).toEqual([ORIGIN_PUB]);

    expect(await db.getDomainsForAgent('https://other.origin-only.example/mcp')).toEqual([]);
    expect(await db.getDomainsForAgent('http://agent.origin-only.example/mcp')).toEqual([]);
    expect(await db.getDomainsForAgent('https://agent.origin-only.example:8443/mcp')).toEqual([]);
  });

  it('getDomainsForAgent: default port and case on the agent URL normalize to the origin', async () => {
    const domains = (await db.getDomainsForAgent('HTTPS://Agent.Origin-Only.Example:443/mcp'))
      .map(r => r.publisher_domain);
    expect(domains).toContain(ORIGIN_PUB);
  });

  it('getPublishersForAgentDetail reports the origin-only publisher with its pinned signing key', async () => {
    const rows = await db.getPublishersForAgentDetail(DEEP_AGENT, { limit: 10, includePropertyIds: true });
    expect(rows.map(r => r.publisher_domain)).toEqual([ORIGIN_PUB]);
    expect(rows[0].signing_keys_pinned).toBe(true);
    // Property counts follow the origin-only entry's catalog rows too.
    expect(rows[0].properties_authorized).toBe(1);
    expect(rows[0].property_ids).toEqual([PROPERTY_ID]);
    const counted = await db.getPublishersForAgentDetail(DEEP_AGENT, { limit: 10 });
    expect(counted[0].properties_authorized).toBe(1);
    expect(counted[0].property_ids ?? null).toBeNull();
    expect(await db.getPublishersForAgentDetail('https://other.origin-only.example/mcp', { limit: 10 }))
      .toEqual([]);
  });

  it('signing_keys_pinned counts only entries that authorize the agent', async () => {
    // KEYS_PUB lists the bare origin WITHOUT keys and `/mcp/` WITH keys. An
    // agent at `/mcp` is authorized by the origin entry only; the `/mcp/`
    // entry shares its registry key but does not authorize it, so its keys
    // must not be reported. An agent at `/mcp/` is authorized by both.
    const KEYS_PUB = `keys${PUB_SUFFIX}`;
    const slashed = 'https://agent.origin-only.example/mcp/';
    await pool.query(
      `INSERT INTO publishers (domain, source_type, adagents_json)
       VALUES ($1, 'adagents_json', $2::jsonb)`,
      [KEYS_PUB, JSON.stringify({
        authorized_agents: [
          { url: ORIGIN_ENTRY },
          { url: slashed, signing_keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'k1' }] },
        ],
      })],
    );
    for (const url of [ORIGIN_ENTRY, slashed]) {
      await pool.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, publisher_domain, evidence)
         VALUES ($1, $2, $3, 'adagents_json')`,
        [url, registryAgentUrlKey(url)!, KEYS_PUB],
      );
    }
    const pinnedFor = async (agent: string) => (await db.getPublishersForAgentDetail(agent, { limit: 10 }))
      .find(r => r.publisher_domain === KEYS_PUB)?.signing_keys_pinned;
    expect(await pinnedFor(DEEP_AGENT)).toBe(false);
    expect(await pinnedFor(slashed)).toBe(true);
  });

  it('a spelling the registry cannot key raw still finds what the validator matches', async () => {
    // `https:host/path` canonicalizes to `https://host/path` for the
    // validator; the directory must reach the same rows.
    const unkeyable = 'https:agent.origin-only.example/tenants/acme/mcp';
    expect(registryAgentUrlKey(unkeyable)).toBeNull();
    const domains = (await db.getDomainsForAgent(unkeyable)).map(r => r.publisher_domain).sort();
    expect(domains).toEqual([ORIGIN_PUB, PATH_PUB].sort());
  });

  it('getAuthorizationsForAgent lists a publisher once when two of its entries authorize the agent', async () => {
    // PATH_PUB also lists the bare origin, so it authorizes the tenant URL twice.
    await pool.query(
      `INSERT INTO catalog_agent_authorizations
         (agent_url, agent_url_canonical, publisher_domain, evidence)
       VALUES ($1, $2, $3, 'adagents_json')`,
      [ORIGIN_ENTRY, registryAgentUrlKey(ORIGIN_ENTRY)!, PATH_PUB],
    );
    expect((await db.getDomainsForAgent(PATH_ENTRY)).filter(r => r.publisher_domain === PATH_PUB))
      .toHaveLength(2);
    const service = new FederatedIndexService();
    const auths = await service.getAuthorizationsForAgent(PATH_ENTRY);
    expect(auths.map(a => a.publisher_domain).sort()).toEqual([ORIGIN_PUB, PATH_PUB].sort());
    expect((await service.getDomainsForAgent(PATH_ENTRY)).sort()).toEqual([ORIGIN_PUB, PATH_PUB].sort());
  });

  it('bulkGetFirstAuthForAgents answers each input by position, even when two inputs share a key', async () => {
    // `/tenants/acme/mcp` and `/tenants/acme/mcp/` share a registry key but
    // are different agents: only the first is authorized by PATH_PUB.
    const tenantSlashed = `${PATH_ENTRY}/`;
    const result = await db.bulkGetFirstAuthForAgents([PATH_ENTRY, tenantSlashed]);
    expect(result.get(PATH_ENTRY)).toBeDefined();
    expect(result.get(tenantSlashed)?.publisher_domain).toBe(ORIGIN_PUB);
  });

  it('bulkGetFirstAuthForAgents attributes an origin-only row to every input at that origin', async () => {
    const a2a = 'https://agent.origin-only.example/a2a';
    const other = 'https://other.origin-only.example/mcp';
    const result = await db.bulkGetFirstAuthForAgents([DEEP_AGENT, a2a, other]);
    expect(result.get(DEEP_AGENT)?.publisher_domain).toBe(ORIGIN_PUB);
    expect(result.get(a2a)?.publisher_domain).toBe(ORIGIN_PUB);
    expect(result.get(other)).toBeUndefined();
  });

  it('property reads follow the origin-only entry', async () => {
    expect((await db.getPropertiesForAgent(DEEP_AGENT)).map(p => p.property_id)).toEqual([PROPERTY_ID]);
    expect((await db.getPropertiesForAgentDomain(DEEP_AGENT, ORIGIN_PUB)).map(p => p.property_id))
      .toEqual([PROPERTY_ID]);
    expect(await db.getPublisherDomainsForAgent(DEEP_AGENT)).toEqual([ORIGIN_PUB]);
    await expect(db.isPropertyAuthorizedForAgent(DEEP_AGENT, 'domain', IDENTIFIER))
      .resolves.toMatchObject({ authorized: true });

    const stranger = 'https://other.origin-only.example/mcp';
    expect(await db.getPropertiesForAgent(stranger)).toEqual([]);
    await expect(db.isPropertyAuthorizedForAgent(stranger, 'domain', IDENTIFIER))
      .resolves.toEqual({ authorized: false });
  });

  it('validateAgentForProduct (via getAuthorizationSource) follows the origin-only entry', async () => {
    const selector = { publisher_domain: ORIGIN_PUB, selection_type: 'all' as const };
    const deep = await db.validateAgentForProduct(DEEP_AGENT, [selector]);
    expect(deep.selectors[0].source).not.toBe('none');
    const stranger = await db.validateAgentForProduct('https://other.origin-only.example/mcp', [selector]);
    expect(stranger.selectors[0].source).toBe('none');
  });

  it('authorization snapshot getNarrow returns origin-only rows for a deeper agent URL', async () => {
    for (const include of ['effective', 'raw'] as const) {
      const deep = await snapshotDb.getNarrow({
        agentUrl: DEEP_AGENT,
        agentUrlCanonical: registryAgentUrlKey(DEEP_AGENT)!,
        evidence: ['adagents_json'],
        include,
      });
      expect(deep.rows.length).toBeGreaterThan(0);
      expect(new Set(deep.rows.map(r => r.agent_url))).toEqual(new Set([ORIGIN_ENTRY]));

      const tenant = await snapshotDb.getNarrow({
        agentUrl: PATH_ENTRY,
        agentUrlCanonical: registryAgentUrlKey(PATH_ENTRY)!,
        evidence: ['adagents_json'],
        include,
      });
      expect(new Set(tenant.rows.map(r => r.agent_url))).toEqual(new Set([ORIGIN_ENTRY, PATH_ENTRY]));

      const stranger = await snapshotDb.getNarrow({
        agentUrl: 'https://other.origin-only.example/mcp',
        agentUrlCanonical: registryAgentUrlKey('https://other.origin-only.example/mcp')!,
        evidence: ['adagents_json'],
        include,
      });
      expect(stranger.rows).toEqual([]);
    }
  });

  it('agrees with the validator on every row of the shared fixture table', async () => {
    // One publisher per case, each listing exactly that case's entry, so a
    // case's verdict is read off its own publisher regardless of the rest.
    await clearFixtures();
    for (const [i, { entry }] of ALL_CASES.entries()) {
      await seedPublisherWide(casePub(i), entry);
    }

    vi.spyOn(dns, 'lookup').mockResolvedValue(
      [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    try {
      for (const [i, { entry, agent, why }] of ALL_CASES.entries()) {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
          JSON.stringify({ authorized_agents: [{ url: entry }] }),
          { status: 200, headers: { 'content-type': 'application/json' } })));
        const validatorSays = (await new AgentValidator().validate(casePub(i), agent)).authorized;
        const registrySays = (await db.getDomainsForAgent(agent))
          .some(r => r.publisher_domain === casePub(i));
        const expected = AUTHORIZED_CASES.some(c => c.entry === entry && c.agent === agent);
        expect({ why, validatorSays, registrySays }).toEqual({ why, validatorSays: expected, registrySays: expected });
      }
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
