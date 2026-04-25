/**
 * Baseline coverage for agent/authorization reader functions ahead of the
 * property registry unification (issue #3177). PR 4 will swap these
 * readers from agent_publisher_authorizations / agent_property_authorizations
 * to consult the new `publishers` cache + `adagents_authorization_overrides`
 * layer (#3195). Same I/O must hold across the cutover.
 *
 * What this file covers:
 *   - PropertyDatabase.getAgentAuthorizationsForDomain
 *   - FederatedIndexDatabase.getAgentsForDomain
 *   - FederatedIndexDatabase.getDomainsForAgent
 *   - FederatedIndexDatabase.getPublisherDomainsForAgent
 *   - FederatedIndexDatabase.bulkGetFirstAuthForAgents (incl. source preference)
 *   - FederatedIndexDatabase.validateAgentForProduct (all three selector kinds)
 *
 * Property/publisher-side readers live in the sibling -properties file.
 *
 * Fixtures use the *.registry-baseline.example domain suffix with an
 * `auth-` prefix so we don't collide with the -properties file or any
 * parallel registry-* test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { PropertyDatabase } from '../../src/db/property-db.js';

// `auth-` prefix scopes this file's fixtures away from the sibling
// baseline files (prop-, endpoint-, mcp-) so concurrent file execution
// can't trample state.
const DOMAIN_SUFFIX = '.registry-baseline.example';
const DOMAIN_PREFIX = 'auth-';
const AGENT_PREFIX = 'https://auth-';
const PUB_A = `${DOMAIN_PREFIX}acme${DOMAIN_SUFFIX}`;
const PUB_B = `${DOMAIN_PREFIX}pinnacle${DOMAIN_SUFFIX}`;
const AGENT_X = `${AGENT_PREFIX}sales-x.registry-baseline.example`;
const AGENT_Y = `${AGENT_PREFIX}sales-y.registry-baseline.example`;
const AGENT_Z = `${AGENT_PREFIX}sales-z.registry-baseline.example`;
const AGENT_WILDCARD = '*';

describe('Registry reader baseline — agent + authorization reads', () => {
  let pool: Pool;
  let fedDb: FederatedIndexDatabase;
  let propDb: PropertyDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    fedDb = new FederatedIndexDatabase();
    propDb = new PropertyDatabase();
  });

  // Cleanup keyed strictly to this file's `auth-` prefix + the literal
  // wildcard agent ('*'). Sibling baseline files use disjoint prefixes
  // so concurrent file execution can't trample state.
  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;
  const AGENT_LIKE = `${AGENT_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE property_id IN (
         SELECT id FROM discovered_properties WHERE publisher_domain LIKE $1
       )
          OR agent_url LIKE $2
          OR agent_url = $3`,
      [DOMAIN_LIKE, AGENT_LIKE, AGENT_WILDCARD]
    );
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM agent_publisher_authorizations WHERE publisher_domain LIKE $1 OR agent_url LIKE $2 OR agent_url = $3',
      [DOMAIN_LIKE, AGENT_LIKE, AGENT_WILDCARD]
    );
    await pool.query(
      'DELETE FROM discovered_publishers WHERE domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_agents WHERE agent_url LIKE $1',
      [AGENT_LIKE]
    );
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  // ──────────────────────────────────────────────────────────────────
  // Empty registry — readers must tolerate absence cleanly.
  // ──────────────────────────────────────────────────────────────────

  describe('empty registry', () => {
    it('getAgentsForDomain returns []', async () => {
      const auths = await fedDb.getAgentsForDomain(PUB_A);
      expect(auths).toEqual([]);
    });

    it('getDomainsForAgent returns []', async () => {
      const auths = await fedDb.getDomainsForAgent(AGENT_X);
      expect(auths).toEqual([]);
    });

    it('getAgentAuthorizationsForDomain returns []', async () => {
      const rows = await propDb.getAgentAuthorizationsForDomain(PUB_A);
      expect(rows).toEqual([]);
    });

    it('bulkGetFirstAuthForAgents returns an empty Map for an empty input array', async () => {
      const map = await fedDb.bulkGetFirstAuthForAgents([]);
      expect(map.size).toBe(0);
    });

    it('bulkGetFirstAuthForAgents returns an empty Map when no rows match', async () => {
      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_X, AGENT_Y]);
      expect(map.size).toBe(0);
    });

    it('validateAgentForProduct on an empty registry returns authorized=false', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_X, [
        { publisher_domain: PUB_A, selection_type: 'all' },
      ]);
      expect(result.authorized).toBe(false);
      expect(result.total_requested).toBe(0);
      expect(result.total_authorized).toBe(0);
      expect(result.coverage_percentage).toBe(0);
      expect(result.selectors).toHaveLength(1);
      expect(result.selectors[0].source).toBe('none');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // getAgentsForDomain / getDomainsForAgent ordering contract.
  // ──────────────────────────────────────────────────────────────────

  describe('basic authorization reads', () => {
    beforeEach(async () => {
      // Two agents authorized for PUB_A: one via adagents_json, one via
      // agent_claim. ORDER BY source puts adagents_json first.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_Y,
        publisher_domain: PUB_A,
        source: 'agent_claim',
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'all',
        source: 'adagents_json',
      });
      // AGENT_X also represents PUB_B.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_B,
        source: 'adagents_json',
      });
    });

    it('getAgentsForDomain orders rows by (source, agent_url)', async () => {
      const auths = await fedDb.getAgentsForDomain(PUB_A);
      expect(auths.length).toBe(2);
      expect(auths[0]).toMatchObject({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        source: 'adagents_json',
        authorized_for: 'all',
      });
      expect(auths[1]).toMatchObject({
        agent_url: AGENT_Y,
        publisher_domain: PUB_A,
        source: 'agent_claim',
      });
    });

    it('getDomainsForAgent orders rows by (source, publisher_domain) for one agent', async () => {
      const auths = await fedDb.getDomainsForAgent(AGENT_X);
      const pubs = auths.map((a) => a.publisher_domain);
      expect(pubs).toEqual([PUB_A, PUB_B]);
      expect(auths.every((a) => a.agent_url === AGENT_X)).toBe(true);
    });

    it('getAgentAuthorizationsForDomain returns [] when only publisher-level rows exist (no bleed into property-level reads)', async () => {
      // Property-level and publisher-level authorization are separate
      // graphs. The publisher-level rows seeded in beforeEach must not
      // surface through this property-level reader. PR 4 must preserve
      // this separation.
      const rows = await propDb.getAgentAuthorizationsForDomain(PUB_A);
      expect(rows).toEqual([]);
    });

    it('getAgentAuthorizationsForDomain reports rows once a property is linked', async () => {
      await fedDb.upsertProperty({
        property_id: 'auth-prop-a',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Auth Acme Site',
        identifiers: [{ type: 'domain', value: PUB_A }],
      });
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      const propRow = props[0] as unknown as { id: string };
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: propRow.id,
        authorized_for: 'all',
      });

      const rows = await propDb.getAgentAuthorizationsForDomain(PUB_A);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        agent_url: AGENT_X,
        property_name: 'Auth Acme Site',
        authorized_for: 'all',
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // bulkGetFirstAuthForAgents — DISTINCT ON behavior + source priority.
  // ──────────────────────────────────────────────────────────────────

  describe('bulkGetFirstAuthForAgents', () => {
    it('prefers adagents_json over agent_claim for the same agent', async () => {
      // Insert agent_claim first to verify the function does not use
      // discovered_at to pick — only `ORDER BY source` matters.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_B,
        source: 'agent_claim',
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        authorized_for: 'all',
        source: 'adagents_json',
      });

      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_X]);
      const first = map.get(AGENT_X);
      expect(first).toBeTruthy();
      expect(first!.source).toBe('adagents_json');
      expect(first!.publisher_domain).toBe(PUB_A);
      expect(first!.authorized_for).toBe('all');
    });

    it('returns one row per agent in the input batch and skips agents with no auth', async () => {
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        source: 'adagents_json',
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_Y,
        publisher_domain: PUB_B,
        source: 'agent_claim',
      });

      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_X, AGENT_Y, AGENT_Z]);
      expect(map.size).toBe(2);
      expect(map.get(AGENT_X)?.publisher_domain).toBe(PUB_A);
      expect(map.get(AGENT_Y)?.publisher_domain).toBe(PUB_B);
      expect(map.has(AGENT_Z)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // validateAgentForProduct — selector contracts.
  //
  // These pin the *output shape* of the validator. Internal SQL is free
  // to change in PR 4 as long as the same fixtures produce the same
  // selectors[] / coverage_percentage / total_* values.
  // ──────────────────────────────────────────────────────────────────

  describe('validateAgentForProduct', () => {
    // Three properties on PUB_A. AGENT_X is authorized for two of them.
    // No property authorization for AGENT_Y, but AGENT_Y has a publisher-
    // level adagents_json claim — used to assert that source='none' vs
    // 'adagents_json' / 'agent_claim' is reported even when properties
    // counts disagree.
    let propIds: { home: string; news: string; mobile: string };

    beforeEach(async () => {
      await fedDb.upsertProperty({
        property_id: 'auth-home',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Home',
        identifiers: [{ type: 'domain', value: PUB_A }],
        tags: ['flagship'],
      });
      await fedDb.upsertProperty({
        property_id: 'auth-news',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'News',
        identifiers: [{ type: 'domain', value: `news.${PUB_A}` }],
        tags: ['flagship', 'news'],
      });
      await fedDb.upsertProperty({
        property_id: 'auth-mobile',
        publisher_domain: PUB_A,
        property_type: 'mobile_app',
        name: 'Mobile',
        identifiers: [{ type: 'ios_bundle', value: 'com.acme.app' }],
        tags: ['mobile'],
      });

      const all = await fedDb.getPropertiesForDomain(PUB_A);
      const byPropId = new Map(all.map((p) => [p.property_id!, p as unknown as { id: string }]));
      propIds = {
        home: byPropId.get('auth-home')!.id,
        news: byPropId.get('auth-news')!.id,
        mobile: byPropId.get('auth-mobile')!.id,
      };

      // AGENT_X authorized for home + news only (not mobile).
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: propIds.home,
      });
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: propIds.news,
      });

      // Publisher-level authorizations record the source signal.
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        source: 'adagents_json',
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_Y,
        publisher_domain: PUB_A,
        source: 'agent_claim',
      });
    });

    it('selection_type=all reports partial coverage when agent has subset', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_X, [
        { publisher_domain: PUB_A, selection_type: 'all' },
      ]);
      expect(result.total_requested).toBe(3);
      expect(result.total_authorized).toBe(2);
      expect(result.coverage_percentage).toBe(67);
      expect(result.authorized).toBe(false);
      expect(result.selectors).toHaveLength(1);
      expect(result.selectors[0]).toMatchObject({
        publisher_domain: PUB_A,
        selection_type: 'all',
        requested_count: 3,
        authorized_count: 2,
        source: 'adagents_json',
      });
    });

    it('selection_type=by_id flags unauthorized property ids', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_X, [
        {
          publisher_domain: PUB_A,
          selection_type: 'by_id',
          property_ids: ['auth-home', 'auth-mobile'],
        },
      ]);
      expect(result.total_requested).toBe(2);
      expect(result.total_authorized).toBe(1);
      expect(result.coverage_percentage).toBe(50);
      expect(result.selectors[0].unauthorized_items).toEqual(['auth-mobile']);
      expect(result.selectors[0].source).toBe('adagents_json');
    });

    it('selection_type=by_id returns authorized=true for a fully covered subset', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_X, [
        {
          publisher_domain: PUB_A,
          selection_type: 'by_id',
          property_ids: ['auth-home', 'auth-news'],
        },
      ]);
      expect(result.authorized).toBe(true);
      expect(result.coverage_percentage).toBe(100);
      expect(result.selectors[0].unauthorized_items).toEqual([]);
    });

    it('selection_type=by_tag pins property-counting semantics + tag-level unauthorized items', async () => {
      // Selector tags ['flagship', 'mobile'] match all three properties
      // via tags && operator: home (flagship) + news (flagship) +
      // mobile (mobile). AGENT_X is authorized for home + news only.
      // So: requested=3 (matched properties), authorized=2, coverage=67.
      // Tag coverage: flagship is covered (home + news both authorized),
      // mobile is not (mobile property unauthorized) → unauthorized=['mobile'].
      const result = await fedDb.validateAgentForProduct(AGENT_X, [
        {
          publisher_domain: PUB_A,
          selection_type: 'by_tag',
          property_tags: ['flagship', 'mobile'],
        },
      ]);
      expect(result.selectors).toHaveLength(1);
      expect(result.total_requested).toBe(3);
      expect(result.total_authorized).toBe(2);
      expect(result.coverage_percentage).toBe(67);
      expect(result.authorized).toBe(false);
      expect(result.selectors[0]).toMatchObject({
        publisher_domain: PUB_A,
        selection_type: 'by_tag',
        requested_count: 3,
        authorized_count: 2,
        unauthorized_items: ['mobile'],
        source: 'adagents_json',
      });
    });

    it('reports source=agent_claim for an agent with only an unverified claim', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_Y, [
        { publisher_domain: PUB_A, selection_type: 'all' },
      ]);
      expect(result.selectors[0].source).toBe('agent_claim');
      expect(result.total_authorized).toBe(0);
      expect(result.authorized).toBe(false);
    });

    it('reports source=none when an agent has no publisher-level row at all', async () => {
      const result = await fedDb.validateAgentForProduct(AGENT_Z, [
        { publisher_domain: PUB_A, selection_type: 'all' },
      ]);
      expect(result.selectors[0].source).toBe('none');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Wildcard agent — '*' is a literal in the schema today (no implicit
  // expansion at the SQL layer). PR 4 must preserve that.
  // ──────────────────────────────────────────────────────────────────

  describe("wildcard agent ('*')", () => {
    beforeEach(async () => {
      await fedDb.upsertAuthorization({
        agent_url: AGENT_WILDCARD,
        publisher_domain: PUB_A,
        source: 'adagents_json',
      });
    });

    it('getAgentsForDomain returns the literal "*" row', async () => {
      const auths = await fedDb.getAgentsForDomain(PUB_A);
      const urls = auths.map((a) => a.agent_url);
      expect(urls).toContain(AGENT_WILDCARD);
    });

    it('getDomainsForAgent("*") returns rows for the literal wildcard agent only', async () => {
      const auths = await fedDb.getDomainsForAgent(AGENT_WILDCARD);
      expect(auths.length).toBe(1);
      expect(auths[0].agent_url).toBe(AGENT_WILDCARD);
      expect(auths[0].publisher_domain).toBe(PUB_A);
    });

    it('a non-wildcard agent does not implicitly inherit the wildcard row', async () => {
      // No row for AGENT_X — '*' must NOT expand at read time.
      const auths = await fedDb.getDomainsForAgent(AGENT_X);
      expect(auths).toEqual([]);
    });

    it('bulkGetFirstAuthForAgents treats "*" as a literal agent_url key', async () => {
      // PR 4 must not special-case the wildcard inside the bulk path
      // any differently from the single-agent reader.
      const map = await fedDb.bulkGetFirstAuthForAgents([AGENT_WILDCARD]);
      const first = map.get(AGENT_WILDCARD);
      expect(first).toBeTruthy();
      expect(first!.agent_url).toBe(AGENT_WILDCARD);
      expect(first!.publisher_domain).toBe(PUB_A);
      expect(first!.source).toBe('adagents_json');
    });
  });
});
