/**
 * Baseline coverage for property/publisher reader functions ahead of the
 * property registry unification (issue #3177). PR 1 (#3195) shipped the
 * empty `publishers` + `adagents_authorization_overrides` schema; PR 4
 * will swap readers to consult that schema. These tests pin the I/O of
 * the current readers — same fixtures, identical assertions must pass
 * before and after the cutover.
 *
 * What this file covers:
 *   - PropertyDatabase.getDiscoveredPropertiesByDomain
 *   - PropertyDatabase.getAllPropertiesForRegistry
 *   - PropertyDatabase.getPropertyRegistryStats
 *   - FederatedIndexDatabase.getPropertiesForDomain (publisher-side reader)
 *   - FederatedIndexDatabase.getPropertiesForAgent
 *   - FederatedIndexDatabase.getPublisherDomainsForAgent
 *   - FederatedIndexDatabase.findAgentsForPropertyIdentifier
 *   - FederatedIndexDatabase.hasValidAdagents
 *   - FederatedIndexDatabase.getStats (lower-bound assertions only)
 *
 * Authorization-side readers (getAgentsForDomain, validateAgentForProduct,
 * etc.) live in registry-reader-baseline-authorizations.test.ts.
 *
 * Fixtures use the *.registry-baseline.example domain suffix so a parallel
 * run of registry-feed/registry-search/etc. cannot trample our seed data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { PropertyDatabase } from '../../src/db/property-db.js';

// `prop-` prefix scopes this file's fixtures away from the sibling
// baseline files (auth-, endpoint-, mcp-) so concurrent file execution
// can't trample state via shared LIKE patterns.
const DOMAIN_SUFFIX = '.registry-baseline.example';
const DOMAIN_PREFIX = 'prop-';
const AGENT_PREFIX = 'https://prop-';
const PUB_A = `${DOMAIN_PREFIX}acme${DOMAIN_SUFFIX}`;
const PUB_B = `${DOMAIN_PREFIX}pinnacle${DOMAIN_SUFFIX}`;
const PUB_C = `${DOMAIN_PREFIX}nova${DOMAIN_SUFFIX}`;
const HOSTED_DOMAIN = `${DOMAIN_PREFIX}meridian${DOMAIN_SUFFIX}`;
const AGENT_X = `${AGENT_PREFIX}sales-x.registry-baseline.example`;
const AGENT_Y = `${AGENT_PREFIX}sales-y.registry-baseline.example`;

describe('Registry reader baseline — properties + publisher-side reads', () => {
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

  // Cleanup keyed strictly to this file's `prop-` prefix. The sibling
  // baseline files (auth-, endpoint-, mcp-) use disjoint prefixes so
  // concurrent file execution can't trample state.
  const DOMAIN_LIKE = `${DOMAIN_PREFIX}%${DOMAIN_SUFFIX}`;
  const AGENT_LIKE = `${AGENT_PREFIX}%${DOMAIN_SUFFIX}`;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE property_id IN (
         SELECT id FROM discovered_properties WHERE publisher_domain LIKE $1
       )
          OR agent_url LIKE $2`,
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM agent_publisher_authorizations WHERE publisher_domain LIKE $1 OR agent_url LIKE $2',
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_publishers WHERE domain LIKE $1 OR discovered_by_agent LIKE $2',
      [DOMAIN_LIKE, AGENT_LIKE]
    );
    await pool.query(
      'DELETE FROM discovered_agents WHERE agent_url LIKE $1 OR source_domain LIKE $2',
      [AGENT_LIKE, DOMAIN_LIKE]
    );
    await pool.query(
      'DELETE FROM hosted_properties WHERE publisher_domain LIKE $1',
      [DOMAIN_LIKE]
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
  // Empty registry — every reader must tolerate a cold DB shape.
  // ──────────────────────────────────────────────────────────────────

  describe('empty registry (no fixtures for this suffix)', () => {
    it('getPropertiesForDomain returns []', async () => {
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      expect(props).toEqual([]);
    });

    it('getDiscoveredPropertiesByDomain returns []', async () => {
      const props = await propDb.getDiscoveredPropertiesByDomain(PUB_A);
      expect(props).toEqual([]);
    });

    it('getPropertiesForAgent returns [] for an unknown agent', async () => {
      const props = await fedDb.getPropertiesForAgent(AGENT_X);
      expect(props).toEqual([]);
    });

    it('getPublisherDomainsForAgent returns [] for an unknown agent', async () => {
      const domains = await fedDb.getPublisherDomainsForAgent(AGENT_X);
      expect(domains).toEqual([]);
    });

    it('findAgentsForPropertyIdentifier returns [] when no property matches', async () => {
      const agents = await fedDb.findAgentsForPropertyIdentifier(
        'domain',
        `unknown${DOMAIN_SUFFIX}`
      );
      expect(agents).toEqual([]);
    });

    it('hasValidAdagents returns null for a domain never discovered', async () => {
      const result = await fedDb.hasValidAdagents(`unseen${DOMAIN_SUFFIX}`);
      expect(result).toBeNull();
    });

    it('getAllPropertiesForRegistry filtered to our prefix returns []', async () => {
      const rows = await propDb.getAllPropertiesForRegistry({ search: DOMAIN_PREFIX });
      expect(rows).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Single publisher / single property / single agent.
  // ──────────────────────────────────────────────────────────────────

  describe('single publisher + property + agent', () => {
    beforeEach(async () => {
      await fedDb.upsertProperty({
        property_id: 'prop-a-website',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Acme Homepage',
        identifiers: [{ type: 'domain', value: PUB_A }],
        tags: ['news'],
      });
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      const propRow = props[0] as unknown as { id: string };
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: propRow.id,
        authorized_for: 'all',
      });
    });

    it('getPropertiesForDomain returns the seeded property with parsed identifiers', async () => {
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      expect(props.length).toBe(1);
      expect(props[0].publisher_domain).toBe(PUB_A);
      expect(props[0].name).toBe('Acme Homepage');
      expect(props[0].property_type).toBe('website');
      expect(props[0].identifiers).toEqual([{ type: 'domain', value: PUB_A }]);
      expect(props[0].tags).toEqual(['news']);
    });

    it('getDiscoveredPropertiesByDomain returns the seeded row with the same fields', async () => {
      const props = await propDb.getDiscoveredPropertiesByDomain(PUB_A);
      expect(props.length).toBe(1);
      expect(props[0].publisher_domain).toBe(PUB_A);
      expect(props[0].name).toBe('Acme Homepage');
      expect(props[0].identifiers).toEqual([{ type: 'domain', value: PUB_A }]);
    });

    it('getPropertiesForAgent returns properties via the join', async () => {
      const props = await fedDb.getPropertiesForAgent(AGENT_X);
      expect(props.length).toBe(1);
      expect(props[0].publisher_domain).toBe(PUB_A);
      expect(props[0].name).toBe('Acme Homepage');
    });

    it('getPublisherDomainsForAgent returns the publisher', async () => {
      const domains = await fedDb.getPublisherDomainsForAgent(AGENT_X);
      expect(domains).toEqual([PUB_A]);
    });

    it('findAgentsForPropertyIdentifier matches on (type, value)', async () => {
      const matches = await fedDb.findAgentsForPropertyIdentifier('domain', PUB_A);
      expect(matches.length).toBe(1);
      expect(matches[0].agent_url).toBe(AGENT_X);
      expect(matches[0].publisher_domain).toBe(PUB_A);
      expect(matches[0].property.name).toBe('Acme Homepage');
    });

    it('findAgentsForPropertyIdentifier does not match on a partial type/value', async () => {
      const wrongType = await fedDb.findAgentsForPropertyIdentifier('ios_bundle', PUB_A);
      expect(wrongType).toEqual([]);
      const wrongValue = await fedDb.findAgentsForPropertyIdentifier(
        'domain',
        `other${DOMAIN_SUFFIX}`
      );
      expect(wrongValue).toEqual([]);
    });

    it('findAgentsForPropertyIdentifier returns [] when the property has no agent_property_authorizations row (INNER JOIN contract)', async () => {
      // Insert a property with the same identifier under a *different*
      // publisher and no authorization. The current implementation uses
      // an INNER JOIN against agent_property_authorizations, so this row
      // must be invisible. PR 4 swapping to LEFT JOIN would silently
      // return ghost agent_url=null rows; this test catches that.
      const ORPHAN_DOMAIN = `prop-orphan${DOMAIN_SUFFIX}`;
      await fedDb.upsertProperty({
        property_id: 'orphan-prop',
        publisher_domain: ORPHAN_DOMAIN,
        property_type: 'website',
        name: 'Orphan Site',
        identifiers: [{ type: 'orphan_id', value: 'orphan-only' }],
      });
      const matches = await fedDb.findAgentsForPropertyIdentifier(
        'orphan_id',
        'orphan-only'
      );
      expect(matches).toEqual([]);
    });

    it('findAgentsForPropertyIdentifier orders results by (publisher_domain, agent_url)', async () => {
      // Seed a second publisher with a property carrying an identifier
      // shared with PUB_A's home property. Two agents on each side give
      // us a four-row result with a stable expected order.
      const SHARED_TYPE = 'shared_id';
      const SHARED_VALUE = 'shared-1';
      await fedDb.upsertProperty({
        property_id: 'order-a',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Order A Site',
        identifiers: [{ type: SHARED_TYPE, value: SHARED_VALUE }],
      });
      await fedDb.upsertProperty({
        property_id: 'order-b',
        publisher_domain: PUB_B,
        property_type: 'website',
        name: 'Order B Site',
        identifiers: [{ type: SHARED_TYPE, value: SHARED_VALUE }],
      });
      const aProps = await fedDb.getPropertiesForDomain(PUB_A);
      const bProps = await fedDb.getPropertiesForDomain(PUB_B);
      const aRow = aProps.find((p) => p.property_id === 'order-a') as unknown as { id: string };
      const bRow = bProps.find((p) => p.property_id === 'order-b') as unknown as { id: string };
      // Authorize Y first (alphabetically later) to verify ORDER BY,
      // not insertion order, drives the result.
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_Y,
        property_id: bRow.id,
      });
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: bRow.id,
      });
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_Y,
        property_id: aRow.id,
      });
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: aRow.id,
      });

      const matches = await fedDb.findAgentsForPropertyIdentifier(SHARED_TYPE, SHARED_VALUE);
      expect(matches.map((m) => `${m.publisher_domain}/${m.agent_url}`)).toEqual([
        `${PUB_A}/${AGENT_X}`,
        `${PUB_A}/${AGENT_Y}`,
        `${PUB_B}/${AGENT_X}`,
        `${PUB_B}/${AGENT_Y}`,
      ]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Multiple properties per publisher + ORDER BY contract.
  // ──────────────────────────────────────────────────────────────────

  describe('multiple properties per publisher', () => {
    beforeEach(async () => {
      // Seeded out of final ORDER BY so we can assert sorting actually applies.
      await fedDb.upsertProperty({
        property_id: 'pin-mobile',
        publisher_domain: PUB_B,
        property_type: 'mobile_app',
        name: 'Pinnacle Mobile',
        identifiers: [{ type: 'ios_bundle', value: 'com.pinnacle.app' }],
      });
      await fedDb.upsertProperty({
        property_id: 'pin-web-news',
        publisher_domain: PUB_B,
        property_type: 'website',
        name: 'Pinnacle News',
        identifiers: [{ type: 'domain', value: `news.${PUB_B}` }],
      });
      await fedDb.upsertProperty({
        property_id: 'pin-web-home',
        publisher_domain: PUB_B,
        property_type: 'website',
        name: 'Pinnacle Homepage',
        identifiers: [{ type: 'domain', value: PUB_B }],
      });
    });

    it('getPropertiesForDomain orders by (property_type, name)', async () => {
      const props = await fedDb.getPropertiesForDomain(PUB_B);
      expect(props.map((p) => `${p.property_type}/${p.name}`)).toEqual([
        'mobile_app/Pinnacle Mobile',
        'website/Pinnacle Homepage',
        'website/Pinnacle News',
      ]);
    });

    it('getPropertiesForAgent orders by (publisher_domain, property_type, name)', async () => {
      // Authorize AGENT_X for PUB_B properties + one PUB_A property so
      // the cross-publisher ordering contract gets exercised.
      const pubBProps = await fedDb.getPropertiesForDomain(PUB_B);
      for (const p of pubBProps) {
        await fedDb.upsertAgentPropertyAuthorization({
          agent_url: AGENT_X,
          property_id: (p as unknown as { id: string }).id,
        });
      }
      await fedDb.upsertProperty({
        property_id: 'acme-home',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Acme Homepage',
        identifiers: [{ type: 'domain', value: PUB_A }],
      });
      const pubAProps = await fedDb.getPropertiesForDomain(PUB_A);
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: (pubAProps[0] as unknown as { id: string }).id,
      });

      const ordered = await fedDb.getPropertiesForAgent(AGENT_X);
      // PUB_A < PUB_B alphabetically (`prop-acme...` < `prop-pinnacle...`).
      expect(ordered.map((p) => `${p.publisher_domain}/${p.property_type}/${p.name}`)).toEqual([
        `${PUB_A}/website/Acme Homepage`,
        `${PUB_B}/mobile_app/Pinnacle Mobile`,
        `${PUB_B}/website/Pinnacle Homepage`,
        `${PUB_B}/website/Pinnacle News`,
      ]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Multiple agents per property — both surface through the readers.
  // ──────────────────────────────────────────────────────────────────

  describe('multiple agents per property', () => {
    beforeEach(async () => {
      await fedDb.upsertProperty({
        property_id: 'shared-prop',
        publisher_domain: PUB_C,
        property_type: 'website',
        name: 'Nova Shared Site',
        identifiers: [{ type: 'domain', value: PUB_C }],
      });
      const props = await fedDb.getPropertiesForDomain(PUB_C);
      const propRow = props[0] as unknown as { id: string };
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: propRow.id,
      });
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_Y,
        property_id: propRow.id,
      });
    });

    it('findAgentsForPropertyIdentifier returns both agents', async () => {
      const matches = await fedDb.findAgentsForPropertyIdentifier('domain', PUB_C);
      const urls = matches.map((m) => m.agent_url).sort();
      expect(urls).toEqual([AGENT_X, AGENT_Y]);
    });

    it('getPropertiesForAgent works independently for each agent', async () => {
      const xProps = await fedDb.getPropertiesForAgent(AGENT_X);
      const yProps = await fedDb.getPropertiesForAgent(AGENT_Y);
      expect(xProps.length).toBe(1);
      expect(yProps.length).toBe(1);
      expect(xProps[0].name).toBe('Nova Shared Site');
      expect(yProps[0].name).toBe('Nova Shared Site');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // hasValidAdagents — three states: null (unseen), false, true.
  // ──────────────────────────────────────────────────────────────────

  describe('hasValidAdagents three-state contract', () => {
    it('returns false when discovered_publishers row exists with has_valid_adagents=false', async () => {
      await fedDb.upsertPublisher({
        domain: PUB_A,
        discovered_by_agent: AGENT_X,
        has_valid_adagents: false,
      });
      const result = await fedDb.hasValidAdagents(PUB_A);
      expect(result).toBe(false);
    });

    it('returns true once any record reports has_valid_adagents=true', async () => {
      await fedDb.upsertPublisher({
        domain: PUB_B,
        discovered_by_agent: AGENT_X,
        has_valid_adagents: false,
      });
      await fedDb.upsertPublisher({
        domain: PUB_B,
        discovered_by_agent: AGENT_Y,
        has_valid_adagents: true,
      });
      const result = await fedDb.hasValidAdagents(PUB_B);
      expect(result).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Registry view (hosted + discovered union).
  // ──────────────────────────────────────────────────────────────────

  describe('getAllPropertiesForRegistry / getPropertyRegistryStats', () => {
    beforeEach(async () => {
      // One discovered property (adagents_json source).
      await fedDb.upsertProperty({
        property_id: 'reg-discovered',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Acme Homepage',
        identifiers: [{ type: 'domain', value: PUB_A }],
      });
      const props = await fedDb.getPropertiesForDomain(PUB_A);
      const propRow = props[0] as unknown as { id: string };
      await fedDb.upsertAgentPropertyAuthorization({
        agent_url: AGENT_X,
        property_id: propRow.id,
      });

      // One hosted (community) property — public + approved.
      await propDb.createHostedProperty({
        publisher_domain: HOSTED_DOMAIN,
        adagents_json: {
          authorized_agents: [{ url: AGENT_X }],
          properties: [{ name: 'Meridian Site', property_type: 'website' }],
        },
        source_type: 'community',
        is_public: true,
        review_status: 'approved',
      });
    });

    it('returns one row per source for our prefix, with the hosted row marked as community', async () => {
      const rows = await propDb.getAllPropertiesForRegistry({ search: DOMAIN_PREFIX });
      const byDomain = new Map(rows.map((r) => [r.domain, r]));

      const hosted = byDomain.get(HOSTED_DOMAIN);
      expect(hosted).toBeTruthy();
      expect(hosted!.source).toBe('community');
      expect(hosted!.property_count).toBe(1);
      expect(hosted!.agent_count).toBe(1);

      const discovered = byDomain.get(PUB_A);
      expect(discovered).toBeTruthy();
      expect(discovered!.source).toBe('adagents_json');
      expect(discovered!.property_count).toBe(1);
      expect(discovered!.agent_count).toBe(1);
    });

    it('rows are returned ordered by domain ascending', async () => {
      const rows = await propDb.getAllPropertiesForRegistry({ search: DOMAIN_PREFIX });
      const domains = rows.map((r) => r.domain);
      const sorted = [...domains].sort();
      expect(domains).toEqual(sorted);
    });

    it('getPropertyRegistryStats counts at least both seeded sources for our prefix', async () => {
      const stats = await propDb.getPropertyRegistryStats(DOMAIN_PREFIX);
      expect(stats.community).toBeGreaterThanOrEqual(1);
      expect(stats.adagents_json).toBeGreaterThanOrEqual(1);
      // total is the sum of all source buckets and must reconcile with
      // the per-bucket counts.
      expect(stats.total).toBeGreaterThanOrEqual(stats.community + stats.adagents_json);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Stats — lower-bound assertions to survive cross-suite contamination.
  // ──────────────────────────────────────────────────────────────────

  describe('getStats lower-bounds', () => {
    it('reflects at least the rows seeded in this test', async () => {
      await fedDb.upsertAgent({
        agent_url: AGENT_X,
        source_type: 'adagents_json',
        source_domain: PUB_A,
      });
      await fedDb.upsertAuthorization({
        agent_url: AGENT_X,
        publisher_domain: PUB_A,
        source: 'adagents_json',
      });
      await fedDb.upsertProperty({
        property_id: 'stats-prop',
        publisher_domain: PUB_A,
        property_type: 'website',
        name: 'Acme Stats Site',
        identifiers: [{ type: 'domain', value: PUB_A }],
      });
      await fedDb.upsertPublisher({
        domain: PUB_A,
        discovered_by_agent: AGENT_X,
        has_valid_adagents: true,
      });

      const stats = await fedDb.getStats();
      expect(stats.discovered_agents).toBeGreaterThanOrEqual(1);
      expect(stats.discovered_publishers).toBeGreaterThanOrEqual(1);
      expect(stats.discovered_properties).toBeGreaterThanOrEqual(1);
      expect(stats.authorizations).toBeGreaterThanOrEqual(1);
      expect(stats.authorizations_by_source.adagents_json).toBeGreaterThanOrEqual(1);
      expect(stats.properties_by_type.website).toBeGreaterThanOrEqual(1);
    });
  });
});
