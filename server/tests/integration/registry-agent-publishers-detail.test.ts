/**
 * Integration tests for `FederatedIndexDatabase.getPublishersForAgentDetail`,
 * the backing query for the AAO directory inverse-lookup endpoint
 * (`GET /v1/agents/{agent_url}/publishers`, adcp#4823).
 *
 * Each row is built end-to-end:
 *   - `agent_publisher_authorizations` row(s) for the agent → publisher edge
 *   - `publishers` row with cached adagents.json JSONB, discovery_method,
 *     manager_domain, last_validated
 *   - `discovered_properties` + `agent_property_authorizations` for the
 *     properties_authorized / properties_total counts
 *
 * Fixtures use a unique RUN_SUFFIX so concurrent test files don't collide.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT_URL = `https://sales-${RUN_SUFFIX}.directorytest.example`;
const OTHER_AGENT_URL = `https://other-${RUN_SUFFIX}.directorytest.example`;
const PUB_DIRECT = `direct-${RUN_SUFFIX}.directorytest.example`;
const PUB_MANAGED = `managed-${RUN_SUFFIX}.directorytest.example`;
const PUB_MANAGER = `manager-${RUN_SUFFIX}.directorytest.example`;
const PUB_REVOKED = `revoked-${RUN_SUFFIX}.directorytest.example`;
const PUB_NOPIN = `nopin-${RUN_SUFFIX}.directorytest.example`;

const ALL_PUBS = [PUB_DIRECT, PUB_MANAGED, PUB_MANAGER, PUB_REVOKED, PUB_NOPIN];

describe('FederatedIndexDatabase.getPublishersForAgentDetail (integration)', () => {
  let pool: Pool;
  let fedDb: FederatedIndexDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    fedDb = new FederatedIndexDatabase();
  });

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM agent_property_authorizations
       WHERE agent_url = ANY($1::text[])
          OR property_id IN (SELECT id FROM discovered_properties WHERE publisher_domain = ANY($2::text[]))`,
      [[AGENT_URL, OTHER_AGENT_URL], ALL_PUBS],
    );
    await pool.query(
      'DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])',
      [ALL_PUBS],
    );
    await pool.query(
      'DELETE FROM agent_publisher_authorizations WHERE agent_url = ANY($1::text[]) OR publisher_domain = ANY($2::text[])',
      [[AGENT_URL, OTHER_AGENT_URL], ALL_PUBS],
    );
    await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [ALL_PUBS]);
  }

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  async function insertPublisher(opts: {
    domain: string;
    discovery_method: 'direct' | 'authoritative_location' | 'ads_txt_managerdomain';
    manager_domain?: string | null;
    last_validated?: Date;
    adagents: Record<string, unknown>;
  }) {
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, domain_verified, last_validated, discovery_method, manager_domain)
       VALUES ($1, $2::jsonb, 'adagents_json', true, COALESCE($3, NOW()), $4, $5)`,
      [opts.domain, JSON.stringify(opts.adagents), opts.last_validated ?? null, opts.discovery_method, opts.manager_domain ?? null],
    );
  }

  async function insertAuthz(opts: {
    agent_url: string;
    publisher_domain: string;
    source?: 'adagents_json' | 'agent_claim';
    last_validated?: Date;
  }) {
    await pool.query(
      `INSERT INTO agent_publisher_authorizations (agent_url, publisher_domain, source, discovered_at, last_validated)
       VALUES ($1, $2, $3, NOW(), COALESCE($4, NOW()))`,
      [opts.agent_url, opts.publisher_domain, opts.source ?? 'adagents_json', opts.last_validated ?? null],
    );
  }

  async function insertPropertyAndAuthz(opts: {
    publisher_domain: string;
    property_id: string;
    authorize_to?: string;
  }) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO discovered_properties (property_id, publisher_domain, property_type, name, identifiers)
       VALUES ($1, $2, 'website', $3, $4::jsonb)
       RETURNING id`,
      [opts.property_id, opts.publisher_domain, opts.property_id, JSON.stringify([{ type: 'domain', value: opts.publisher_domain }])],
    );
    if (opts.authorize_to) {
      await pool.query(
        `INSERT INTO agent_property_authorizations (agent_url, property_id, authorized_for, discovered_at)
         VALUES ($1, $2, 'test', NOW())`,
        [opts.authorize_to, result.rows[0]!.id],
      );
    }
  }

  it('returns [] when the agent has no authorizations', async () => {
    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows).toEqual([]);
  });

  it('returns a single direct-discovery row with provenance and signing_keys_pinned', async () => {
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      adagents: {
        authorized_agents: [{
          url: AGENT_URL,
          authorization_type: 'property_ids',
          property_ids: ['prop1'],
          signing_keys: [{ algorithm: 'EdDSA', public_key: 'k1' }],
        }],
      },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_DIRECT });
    await insertPropertyAndAuthz({ publisher_domain: PUB_DIRECT, property_id: 'prop1', authorize_to: AGENT_URL });
    await insertPropertyAndAuthz({ publisher_domain: PUB_DIRECT, property_id: 'prop2' }); // unauthorized

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publisher_domain: PUB_DIRECT,
      discovery_method: 'direct',
      manager_domain: null,
      properties_authorized: 1,
      properties_total: 2,
      signing_keys_pinned: true,
      status: 'authorized',
    });
  });

  it('surfaces manager_domain on ads_txt_managerdomain discovery', async () => {
    await insertPublisher({
      domain: PUB_MANAGED,
      discovery_method: 'ads_txt_managerdomain',
      manager_domain: PUB_MANAGER,
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_MANAGED });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publisher_domain: PUB_MANAGED,
      discovery_method: 'ads_txt_managerdomain',
      manager_domain: PUB_MANAGER,
      signing_keys_pinned: false,
    });
  });

  it('signing_keys_pinned is false when entry has no signing_keys', async () => {
    await insertPublisher({
      domain: PUB_NOPIN,
      discovery_method: 'direct',
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_NOPIN });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows[0]!.signing_keys_pinned).toBe(false);
  });

  it('signing_keys_pinned is false when signing_keys is an empty array', async () => {
    await insertPublisher({
      domain: PUB_NOPIN,
      discovery_method: 'direct',
      adagents: {
        authorized_agents: [{ url: AGENT_URL, authorization_type: 'all', signing_keys: [] }],
      },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_NOPIN });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows[0]!.signing_keys_pinned).toBe(false);
  });

  it('status is revoked when the MANAGER file (parent) lists the child in revoked_publisher_domains', async () => {
    // The fan-out shape: child publisher has no blob of its own, just
    // manager_domain pointing at the parent. Revocation must propagate
    // from the manager's blob — without this, manager-side revocation of
    // a managed-network child is silently ignored by the directory.
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, domain_verified, last_validated, discovery_method)
       VALUES ($1, $2::jsonb, 'adagents_json', true, NOW(), 'direct')`,
      [
        PUB_MANAGER,
        JSON.stringify({
          authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }],
          revoked_publisher_domains: [
            { publisher_domain: PUB_MANAGED, revoked_at: '2026-05-01T00:00:00Z' },
          ],
        }),
      ],
    );
    // Child row with no blob, manager_domain pointing at PUB_MANAGER —
    // this is exactly what recordChildPublisherFromManager produces.
    await pool.query(
      `INSERT INTO publishers (domain, source_type, domain_verified, last_validated, discovery_method, manager_domain)
       VALUES ($1, 'community', true, NOW(), 'adagents_authoritative', $2)`,
      [PUB_MANAGED, PUB_MANAGER],
    );
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_MANAGED });

    const defaultRows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    // Manager itself isn't in the result (no authz for it from AGENT_URL),
    // but the managed child should be filtered out because the manager
    // revoked it.
    expect(defaultRows.map(r => r.publisher_domain)).not.toContain(PUB_MANAGED);

    const allRows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100, includeRevoked: true });
    const child = allRows.find(r => r.publisher_domain === PUB_MANAGED);
    expect(child).toBeDefined();
    expect(child!.status).toBe('revoked');
  });

  it('status is revoked when parent file lists the publisher_domain in revoked_publisher_domains', async () => {
    await insertPublisher({
      domain: PUB_REVOKED,
      discovery_method: 'direct',
      adagents: {
        authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }],
        revoked_publisher_domains: [
          { publisher_domain: PUB_REVOKED, revoked_at: '2026-05-01T00:00:00Z' },
        ],
      },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_REVOKED });

    // Default filter excludes revoked.
    const defaultRows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(defaultRows).toHaveLength(0);

    // includeRevoked surfaces it with status: revoked.
    const allRows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100, includeRevoked: true });
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.status).toBe('revoked');
  });

  it('canonicalizes agent_url when matching against authorized_agents.url for signing_keys', async () => {
    // Stored canonicalized; JSONB has a trailing slash + mixed case to verify
    // the SQL LOWER+RTRIM canonicalization on the JSONB side.
    const messyUrl = `${AGENT_URL.toUpperCase()}/`;
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      adagents: {
        authorized_agents: [{
          url: messyUrl,
          authorization_type: 'all',
          signing_keys: [{ algorithm: 'EdDSA', public_key: 'k1' }],
        }],
      },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_DIRECT });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows[0]!.signing_keys_pinned).toBe(true);
  });

  it('paginates by publisher_domain ASC via cursor', async () => {
    // Insert three publishers; expect them sorted by domain.
    for (const domain of [PUB_DIRECT, PUB_MANAGED, PUB_REVOKED]) {
      await insertPublisher({
        domain,
        discovery_method: 'direct',
        adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
      });
      await insertAuthz({ agent_url: AGENT_URL, publisher_domain: domain });
    }
    const sorted = [PUB_DIRECT, PUB_MANAGED, PUB_REVOKED].sort();

    const page1 = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 2 });
    expect(page1.map(r => r.publisher_domain)).toEqual(sorted.slice(0, 2));

    const page2 = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 2, cursor: sorted[1] });
    expect(page2.map(r => r.publisher_domain)).toEqual(sorted.slice(2));
  });

  it('honors the since filter using publisher.last_validated', async () => {
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-05-19T00:00:00Z');
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      last_validated: oldDate,
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_DIRECT });
    await insertPublisher({
      domain: PUB_MANAGED,
      discovery_method: 'direct',
      last_validated: newDate,
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_MANAGED });

    const recent = await fedDb.getPublishersForAgentDetail(AGENT_URL, {
      limit: 100,
      since: new Date('2026-03-01T00:00:00Z'),
    });
    expect(recent.map(r => r.publisher_domain)).toEqual([PUB_MANAGED]);
  });

  it('does not leak other agents into the result', async () => {
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      adagents: { authorized_agents: [{ url: OTHER_AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: OTHER_AGENT_URL, publisher_domain: PUB_DIRECT });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows).toEqual([]);
  });

  it('includePropertyIds returns property_ids array with authorized property IDs', async () => {
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_DIRECT });
    await insertPropertyAndAuthz({ publisher_domain: PUB_DIRECT, property_id: 'p-001', authorize_to: AGENT_URL });
    await insertPropertyAndAuthz({ publisher_domain: PUB_DIRECT, property_id: 'p-002', authorize_to: AGENT_URL });
    await insertPropertyAndAuthz({ publisher_domain: PUB_DIRECT, property_id: 'p-003' }); // unauthorized — must not appear

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100, includePropertyIds: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.property_ids).toEqual(['p-001', 'p-002']);
    expect(rows[0]!.properties_authorized).toBe(2);
  });

  it('without includePropertyIds, property_ids is null', async () => {
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_DIRECT });
    await insertPropertyAndAuthz({ publisher_domain: PUB_DIRECT, property_id: 'p-001', authorize_to: AGENT_URL });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100 });
    expect(rows[0]!.property_ids).toBeNull();
  });

  it('includePropertyIds returns empty array when no authorized properties have property_id', async () => {
    await insertPublisher({
      domain: PUB_DIRECT,
      discovery_method: 'direct',
      adagents: { authorized_agents: [{ url: AGENT_URL, authorization_type: 'all' }] },
    });
    await insertAuthz({ agent_url: AGENT_URL, publisher_domain: PUB_DIRECT });
    // Insert a property with no property_id (null) — should yield empty array not null
    await pool.query(
      `INSERT INTO discovered_properties (publisher_domain, property_type, name, identifiers)
       VALUES ($1, 'website', 'no-id-prop', $2::jsonb)
       RETURNING id`,
      [PUB_DIRECT, JSON.stringify([{ type: 'domain', value: PUB_DIRECT }])],
    ).then(async (res) => {
      await pool.query(
        `INSERT INTO agent_property_authorizations (agent_url, property_id, authorized_for, discovered_at)
         VALUES ($1, $2, 'test', NOW())`,
        [AGENT_URL, res.rows[0]!.id],
      );
    });

    const rows = await fedDb.getPublishersForAgentDetail(AGENT_URL, { limit: 100, includePropertyIds: true });
    expect(rows[0]!.property_ids).toEqual([]);
  });
});
