/**
 * Community-mirror catalog lifecycle (#2176): publish (idempotent), read one,
 * list, and serve at /translated/<platform>/adagents.json.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

// Mutable identity for the authenticated caller so a re-publish can come from a
// different user (used to assert created_by_* is preserved).
const authState = vi.hoisted(() => ({
  userId: 'user_test_mirrors',
  email: 'mirrors@test.com',
  organizationId: null as string | null,
}));

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown; apiKey?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: authState.userId, email: authState.email };
    req.apiKey = authState.organizationId ? { organizationId: authState.organizationId } : undefined;
    next();
  };
  return { ...actual, requireAuth: pass, requireAdmin: (_r: unknown, _s: unknown, n: () => void) => n() };
});

vi.mock('../../src/middleware/csrf.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/csrf.js');
  return { ...actual, csrfProtection: (_r: unknown, _s: unknown, n: () => void) => n() };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

// Publish gate dependencies. Defaults set in beforeEach.
const isRegistryModerator = vi.hoisted(() => vi.fn());
const isWebUserAAOAdmin = vi.hoisted(() => vi.fn());
const notifyPendingCommunityMirrorProposal = vi.hoisted(() => vi.fn());
const notifyCommunityMirrorProposalReviewed = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/brand-logo-auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/services/brand-logo-auth.js');
  return { ...actual, isRegistryModerator };
});
vi.mock('../../src/addie/admin-status-lookup.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/addie/admin-status-lookup.js');
  return { ...actual, isWebUserAAOAdmin };
});
vi.mock('../../src/notifications/registry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/notifications/registry.js');
  return {
    ...actual,
    notifyPendingCommunityMirrorProposal,
    notifyCommunityMirrorProposalReviewed,
  };
});

import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase } from '../../src/db/publisher-db.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { CommunityMirrorDatabase } from '../../src/db/community-mirror-db.js';

const PLATFORM = 'test-meta';
const PLATFORM_LIKE = 'test-%';
const PUBLISHER_DOMAIN = 'community-mirror-test.example';
const REMOVED_PUBLISHER_DOMAIN = 'removed-community-mirror-test.example';
const TEST_DATABASE_URL = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';

const MINIMAL_PROPERTY = {
  property_id: 'instagram',
  property_type: 'mobile_app',
  name: 'Instagram',
  identifiers: [{ type: 'domain', value: PUBLISHER_DOMAIN }],
  publisher_domain: PUBLISHER_DOMAIN,
};
const REMOVED_PROPERTY = {
  property_id: 'threads',
  property_type: 'website',
  name: 'Threads',
  identifiers: [{ type: 'domain', value: REMOVED_PUBLISHER_DOMAIN }],
  publisher_domain: REMOVED_PUBLISHER_DOMAIN,
};
const MINIMAL_COLLECTION = {
  collection_id: 'test_show',
  name: 'Test Show',
  kind: 'series',
  publisher_domain: PUBLISHER_DOMAIN,
  distribution: [
    {
      publisher_domain: 'youtube.com',
      identifiers: [
        { type: 'youtube_channel_handle', value: '@CommunityMirrorShow' },
      ],
    },
  ],
};
// A valid ProductFormatDeclaration: format_kind + params are both required.
const MINIMAL_FORMAT = {
  format_option_id: 'meta_feed_image',
  display_name: 'Meta Feed Image',
  format_kind: 'image',
  params: { width: 1080, height: 1080 },
};

function publishBody(overrides: Record<string, unknown> = {}) {
  return {
    catalog_etag: 'test-etag-1',
    properties: [MINIMAL_PROPERTY],
    formats: [MINIMAL_FORMAT],
    ...overrides,
  };
}

describe('Community-mirror lifecycle — /api/registry/mirrors + /translated', () => {
  let server: HTTPServer;
  let app: unknown;
  let pool: Pool;
  let publisherDb: PublisherDatabase;
  let federatedDb: FederatedIndexDatabase;

  async function clear() {
    await pool.query(
      `DELETE FROM catalog_events
        WHERE actor IN ('registry:community_mirror', 'test:community-mirrors')
           OR payload->>'publisher_domain' = ANY($1::text[])`,
      [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]],
    );
    await pool.query(
      `DELETE FROM catalog_collection_identifiers cci
        WHERE cci.collection_rid IN (
          SELECT cc.collection_rid
            FROM catalog_collections cc
           WHERE cc.created_by = $1
              OR cc.publisher_domain = ANY($2::text[])
        )`,
      [`community_adagents:${PLATFORM}`, [PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]],
    );
    await pool.query(
      `DELETE FROM catalog_collections
        WHERE created_by = $1
           OR publisher_domain = ANY($2::text[])`,
      [`community_adagents:${PLATFORM}`, [PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]],
    );
    await pool.query(
      `DELETE FROM catalog_identifiers ci
        WHERE ci.property_rid IN (
          SELECT cp.property_rid
            FROM catalog_properties cp
           WHERE cp.created_by = $1
        )`,
      [`community_adagents:${PLATFORM}`],
    );
    await pool.query('DELETE FROM catalog_properties WHERE created_by = $1', [`community_adagents:${PLATFORM}`]);
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain = ANY($1::text[])', [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]]);
    await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]]);
    await pool.query('DELETE FROM community_mirror_proposals WHERE platform LIKE $1', [PLATFORM_LIKE]);
    await pool.query('DELETE FROM community_mirrors WHERE platform LIKE $1', [PLATFORM_LIKE]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = initializeDatabase({
      connectionString: TEST_DATABASE_URL,
    });
    await runMigrations();
    server = new HTTPServer();
    publisherDb = new PublisherDatabase();
    federatedDb = new FederatedIndexDatabase();
    await server.start(0);
    app = (server as unknown as { app: unknown }).app;
  });

  afterAll(async () => {
    await clear();
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    isRegistryModerator.mockResolvedValue(true);
    isWebUserAAOAdmin.mockResolvedValue(false);
    notifyPendingCommunityMirrorProposal.mockReset();
    notifyPendingCommunityMirrorProposal.mockResolvedValue(null);
    notifyCommunityMirrorProposalReviewed.mockReset();
    notifyCommunityMirrorProposalReviewed.mockResolvedValue(undefined);
    authState.userId = 'user_test_mirrors';
    authState.email = 'mirrors@test.com';
    authState.organizationId = null;
    await clear();
  });

  it('publishes a catalog-only mirror (authorized_agents forced to [])', async () => {
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.platform).toBe(PLATFORM);
    expect(res.body.catalog_etag).toBe('test-etag-1');
    expect(res.body.publisher_domains).toEqual([PUBLISHER_DOMAIN]);

    const publishers = await pool.query(
      `SELECT source_type, review_status, discovery_method, created_by_user_id, resolved_url, adagents_json
         FROM publishers
        WHERE domain = $1`,
      [PUBLISHER_DOMAIN],
    );
    expect(publishers.rows).toHaveLength(1);
    expect(publishers.rows[0]).toMatchObject({
      source_type: 'community',
      review_status: 'approved',
      discovery_method: 'community_catalog',
      created_by_user_id: `community_adagents:${PLATFORM}`,
      resolved_url: `/api/creative-agent/translated/${PLATFORM}/adagents.json`,
    });
    expect(publishers.rows[0].adagents_json.properties).toHaveLength(1);
    expect(publishers.rows[0].adagents_json.formats).toHaveLength(1);

    const projected = await pool.query(
      `SELECT source_type, property_id, publisher_domain, name
         FROM discovered_properties
        WHERE publisher_domain = $1`,
      [PUBLISHER_DOMAIN],
    );
    expect(projected.rows).toEqual([
      {
        source_type: 'community',
        property_id: 'instagram',
        publisher_domain: PUBLISHER_DOMAIN,
        name: 'Instagram',
      },
    ]);

    const read = await request(app).get(`/api/registry/mirrors/${PLATFORM}`);
    expect(read.status).toBe(200);
    expect(read.body.adagents_json.authorized_agents).toEqual([]);
    expect(read.body.adagents_json.formats).toHaveLength(1);
    expect(read.body.adagents_json.$schema).toMatch(/adagents\.json$/);
  });

  it('publishes a collection-only mirror and emits a collection event', async () => {
    const res = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send({ catalog_etag: 'collection-only', collections: [MINIMAL_COLLECTION] });
    expect(res.status).toBe(200);
    expect(res.body.publisher_domains).toEqual([PUBLISHER_DOMAIN]);

    const collections = await pool.query<{
      publisher_domain: string;
      collection_id: string;
      name: string;
      source: string;
      status: string;
    }>(
      `SELECT publisher_domain, collection_id, name, source, status
         FROM catalog_collections
        WHERE created_by = $1`,
      [`community_adagents:${PLATFORM}`],
    );
    expect(collections.rows).toEqual([
      {
        publisher_domain: PUBLISHER_DOMAIN,
        collection_id: 'test_show',
        name: 'Test Show',
        source: 'contributed',
        status: 'active',
      },
    ]);

    const identifiers = await pool.query<{ identifier_type: string; identifier_value: string }>(
      `SELECT cci.identifier_type, cci.identifier_value
         FROM catalog_collection_identifiers cci
         JOIN catalog_collections cc ON cc.collection_rid = cci.collection_rid
        WHERE cc.created_by = $1`,
      [`community_adagents:${PLATFORM}`],
    );
    expect(identifiers.rows).toEqual([
      { identifier_type: 'youtube_channel_handle', identifier_value: '@communitymirrorshow' },
    ]);

    const events = await pool.query<{ event_type: string; payload: { collection_id?: string } }>(
      `SELECT event_type, payload
         FROM catalog_events
        WHERE actor = 'registry:community_mirror'
        ORDER BY created_at`,
    );
    expect(events.rows.map((row) => [row.event_type, row.payload.collection_id])).toEqual([
      ['collection.created', 'test_show'],
    ]);
  });

  it('re-publish retires removed mirror collections without replacing unchanged collection rids', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send({
        catalog_etag: 'collections-v1',
        collections: [
          MINIMAL_COLLECTION,
          { ...MINIMAL_COLLECTION, collection_id: 'retired_show', name: 'Retired Show' },
        ],
      });

    const before = await pool.query<{ collection_id: string; collection_rid: string }>(
      `SELECT collection_id, collection_rid
         FROM catalog_collections
        WHERE created_by = $1`,
      [`community_adagents:${PLATFORM}`],
    );
    const originalRid = before.rows.find((row) => row.collection_id === 'test_show')?.collection_rid;
    expect(originalRid).toBeTruthy();

    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send({
        catalog_etag: 'collections-v2',
        collections: [{ ...MINIMAL_COLLECTION, name: 'Test Show Updated' }],
      });

    const after = await pool.query<{ collection_id: string; collection_rid: string; status: string; name: string }>(
      `SELECT collection_id, collection_rid, status, name
         FROM catalog_collections
        WHERE created_by = $1
        ORDER BY collection_id`,
      [`community_adagents:${PLATFORM}`],
    );
    expect(after.rows).toEqual([
      {
        collection_id: 'retired_show',
        collection_rid: expect.any(String),
        status: 'removed',
        name: 'Retired Show',
      },
      {
        collection_id: 'test_show',
        collection_rid: originalRid,
        status: 'active',
        name: 'Test Show Updated',
      },
    ]);
  });

  it('drops any caller-supplied authorized_agents', async () => {
    const res = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ authorized_agents: [{ url: 'https://evil.example', authorized_for: 'all' }] }));
    expect(res.status).toBe(200);
    const read = await request(app).get(`/api/registry/mirrors/${PLATFORM}`);
    expect(read.body.adagents_json.authorized_agents).toEqual([]);
  });

  it('allows an AAO admin who is not a registry moderator to publish', async () => {
    isRegistryModerator.mockResolvedValue(false);
    isWebUserAAOAdmin.mockResolvedValue(true);
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('re-publish is idempotent — updates in place, no duplicate row', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v1' }));
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v2' }));

    const { rows } = await pool.query('SELECT catalog_etag FROM community_mirrors WHERE platform = $1', [PLATFORM]);
    expect(rows).toHaveLength(1);
    expect(rows[0].catalog_etag).toBe('v2');

    const list = await request(app).get('/api/registry/mirrors');
    const mine = list.body.mirrors.filter((m: { platform: string }) => m.platform === PLATFORM);
    expect(mine).toHaveLength(1);
    expect(mine[0].catalog_etag).toBe('v2');
  });

  it('publishes when property_id collides with an existing differently named property', async () => {
    await pool.query(
      `INSERT INTO discovered_properties
         (property_id, publisher_domain, property_type, name, identifiers, tags, source_type, last_validated)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'adagents_json', NOW())`,
      [
        MINIMAL_PROPERTY.property_id,
        PUBLISHER_DOMAIN,
        'website',
        'First-party Instagram',
        JSON.stringify([{ type: 'domain', value: PUBLISHER_DOMAIN }]),
        ['verified'],
      ],
    );

    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT property_id, publisher_domain, property_type, name, source_type, tags
         FROM discovered_properties
        WHERE publisher_domain = $1
          AND property_id = $2`,
      [PUBLISHER_DOMAIN, MINIMAL_PROPERTY.property_id],
    );
    expect(rows).toEqual([
      {
        property_id: MINIMAL_PROPERTY.property_id,
        publisher_domain: PUBLISHER_DOMAIN,
        property_type: 'website',
        name: 'First-party Instagram',
        source_type: 'adagents_json',
        tags: ['verified'],
      },
    ]);
  });

  it('re-publish replaces the projected publisher rows for that platform', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ properties: [MINIMAL_PROPERTY, REMOVED_PROPERTY] }));
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [REMOVED_PUBLISHER_DOMAIN])).rows).toHaveLength(1);

    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ properties: [MINIMAL_PROPERTY] }));

    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [REMOVED_PUBLISHER_DOMAIN])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM discovered_properties WHERE publisher_domain = $1', [REMOVED_PUBLISHER_DOMAIN])).rows).toHaveLength(0);
  });

  it('serializes concurrent publications so the final projection matches the final mirror', async () => {
    const [first, second] = await Promise.all([
      request(app)
        .put(`/api/registry/mirrors/${PLATFORM}`)
        .send(publishBody({ catalog_etag: 'concurrent-a', properties: [MINIMAL_PROPERTY] })),
      request(app)
        .put(`/api/registry/mirrors/${PLATFORM}`)
        .send(publishBody({ catalog_etag: 'concurrent-b', properties: [REMOVED_PROPERTY] })),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const mirror = await pool.query<{ adagents_json: { properties: Array<{ publisher_domain: string }> } }>(
      'SELECT adagents_json FROM community_mirrors WHERE platform = $1',
      [PLATFORM],
    );
    const finalDomains = mirror.rows[0].adagents_json.properties.map((property) => property.publisher_domain);
    const projected = await pool.query<{ domain: string }>(
      'SELECT domain FROM publishers WHERE domain = ANY($1::text[]) ORDER BY domain',
      [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]],
    );
    expect(projected.rows.map((row) => row.domain)).toEqual([...finalDomains].sort());
    const projectedProperties = await pool.query<{ publisher_domain: string }>(
      `SELECT DISTINCT publisher_domain
         FROM discovered_properties
        WHERE publisher_domain = ANY($1::text[])
          AND source_type = 'community'
        ORDER BY publisher_domain`,
      [[PUBLISHER_DOMAIN, REMOVED_PUBLISHER_DOMAIN]],
    );
    expect(projectedProperties.rows.map((row) => row.publisher_domain)).toEqual([...finalDomains].sort());
  });

  it('preserves created_by_* across a re-publish by a different user', async () => {
    authState.userId = 'creator-A';
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v1' }));
    authState.userId = 'editor-B';
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'v2' }));

    const { rows } = await pool.query(
      'SELECT created_by_user_id, catalog_etag FROM community_mirrors WHERE platform = $1',
      [PLATFORM]
    );
    expect(rows[0].created_by_user_id).toBe('creator-A');
    expect(rows[0].catalog_etag).toBe('v2');
  });

  it('rejects a mirror with no catalog content (400)', async () => {
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send({ catalog_etag: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/catalog content/i);
  });

  it('rejects a formats[] entry missing required params — must conform to adagents.json (400)', async () => {
    const res = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ formats: [{ format_option_id: 'x', display_name: 'X', format_kind: 'image' }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conform/i);
  });

  it('rejects an invalid platform identifier (400)', async () => {
    const res = await request(app).put('/api/registry/mirrors/Bad_Platform!').send(publishBody());
    expect(res.status).toBe(400);
  });

  it('queues a valid non-moderator submission for review without publishing it', async () => {
    isRegistryModerator.mockResolvedValue(false);
    isWebUserAAOAdmin.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const res = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      status: 'pending',
      proposal_id: expect.any(String),
      proposal_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      platform: PLATFORM,
      status_url: `/api/registry/mirror-proposals/${res.body.proposal_id}`,
    });
    expect(res.headers.location).toBe(res.body.status_url);
    expect((await pool.query('SELECT 1 FROM community_mirrors WHERE platform = $1', [PLATFORM])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(0);

    const mine = await request(app).get('/api/registry/mirror-proposals');
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.proposals[0]).toMatchObject({
      id: res.body.proposal_id,
      platform: PLATFORM,
      status: 'pending',
      proposal_digest: res.body.proposal_digest,
    });
    expect(mine.body.proposals[0]).not.toHaveProperty('adagents_json');
    expect(mine.body.proposals[0]).not.toHaveProperty('proposed_by_email');
  });

  it('updates an organization\'s pending proposal in place on retry', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const first = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ catalog_etag: 'proposal-v1' }));
    const second = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ catalog_etag: 'proposal-v2' }));

    expect(second.status).toBe(202);
    expect(second.body.proposal_id).toBe(first.body.proposal_id);
    expect(second.body.proposal_digest).not.toBe(first.body.proposal_digest);
    const rows = await pool.query(
      'SELECT catalog_etag FROM community_mirror_proposals WHERE platform = $1',
      [PLATFORM],
    );
    expect(rows.rows).toEqual([{ catalog_etag: 'proposal-v2' }]);
  });

  it('refuses approval when a contributor changed the proposal after review', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const reviewed = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ catalog_etag: 'reviewed-v1' }));
    const changed = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ catalog_etag: 'changed-v2', formats: [{ ...MINIMAL_FORMAT, display_name: 'Changed' }] }));
    expect(changed.body.proposal_id).toBe(reviewed.body.proposal_id);

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    const staleApproval = await request(app)
      .post(`/api/registry/mirror-proposals/${reviewed.body.proposal_id}/approve`)
      .send({ proposal_digest: reviewed.body.proposal_digest });

    expect(staleApproval.status).toBe(409);
    expect(staleApproval.body.error).toMatch(/changed after review/i);
    expect((await pool.query('SELECT 1 FROM community_mirrors WHERE platform = $1', [PLATFORM])).rows).toHaveLength(0);
  });

  it('refuses approval when the public mirror changed after proposal submission', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ catalog_etag: 'newer-public-state' }));
    const staleApproval = await request(app)
      .post(`/api/registry/mirror-proposals/${submitted.body.proposal_id}/approve`)
      .send({ proposal_digest: submitted.body.proposal_digest });

    expect(staleApproval.status).toBe(409);
    expect(staleApproval.body.error).toMatch(/published mirror changed/i);
    const mirror = await pool.query('SELECT catalog_etag FROM community_mirrors WHERE platform = $1', [PLATFORM]);
    expect(mirror.rows).toEqual([{ catalog_etag: 'newer-public-state' }]);
  });

  it('changes the review digest when identical content is rebased onto a newer public mirror', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const original = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ catalog_etag: 'new-public-base', formats: [{ ...MINIMAL_FORMAT, display_name: 'Live' }] }));

    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    isRegistryModerator.mockResolvedValue(false);
    const rebased = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(rebased.body.proposal_id).toBe(original.body.proposal_id);
    expect(rebased.body.proposal_digest).not.toBe(original.body.proposal_digest);

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    const staleApproval = await request(app)
      .post(`/api/registry/mirror-proposals/${original.body.proposal_id}/approve`)
      .send({ proposal_digest: original.body.proposal_digest });
    expect(staleApproval.status).toBe(409);
    expect(staleApproval.body.error).toMatch(/changed after review/i);
  });

  it('scopes proposal list and detail reads to the submitting organization', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    authState.userId = 'api_key_other_org';
    authState.organizationId = 'org_other';
    const list = await request(app).get('/api/registry/mirror-proposals');
    const detail = await request(app).get(`/api/registry/mirror-proposals/${submitted.body.proposal_id}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
    expect(detail.status).toBe(404);
  });

  it('shows proposer attribution only to registry managers', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    authState.email = 'contributor@test.example';
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    const ownDetail = await request(app)
      .get(`/api/registry/mirror-proposals/${submitted.body.proposal_id}`);
    expect(ownDetail.status).toBe(200);
    expect(ownDetail.body.proposal).not.toHaveProperty('proposed_by_email');

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    const managerDetail = await request(app)
      .get(`/api/registry/mirror-proposals/${submitted.body.proposal_id}`);
    expect(managerDetail.status).toBe(200);
    expect(managerDetail.body.proposal.proposed_by_email).toBe('contributor@test.example');
  });

  it('binds the Slack review thread to the exact proposal digest', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    notifyPendingCommunityMirrorProposal.mockResolvedValue('1779110411.874');
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    await vi.waitFor(async () => {
      const row = await pool.query(
        'SELECT slack_thread_ts FROM community_mirror_proposals WHERE id = $1',
        [submitted.body.proposal_id],
      );
      expect(row.rows[0]?.slack_thread_ts).toBe('1779110411.874');
    });

    const mirrorDb = new CommunityMirrorDatabase();
    await mirrorDb.setProposalSlackThreadTs(
      submitted.body.proposal_id,
      'b'.repeat(64),
      'wrong-revision-thread',
    );
    const row = await pool.query(
      'SELECT slack_thread_ts FROM community_mirror_proposals WHERE id = $1',
      [submitted.body.proposal_id],
    );
    expect(row.rows[0]?.slack_thread_ts).toBe('1779110411.874');
  });

  it('restricts the cross-organization review queue to moderators', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    const denied = await request(app)
      .get('/api/registry/mirror-proposals?status=pending&review_queue=true');
    expect(denied.status).toBe(403);

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    const queue = await request(app)
      .get('/api/registry/mirror-proposals?status=pending&review_queue=true');
    expect(queue.status).toBe(200);
    expect(queue.body.total).toBe(1);
  });

  it('requires organization context and caps contributor proposal bodies at 1 MiB', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'user_without_org';
    authState.organizationId = null;
    const noOrg = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    expect(noOrg.status).toBe(403);
    expect(noOrg.body.error).toMatch(/organization context/i);

    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const oversized = await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ contributor_notes: 'x'.repeat(1024 * 1024) }));
    expect(oversized.status).toBe(413);
  });

  it('lets a moderator approve and atomically publish a pending proposal', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    const approved = await request(app)
      .post(`/api/registry/mirror-proposals/${submitted.body.proposal_id}/approve`)
      .send({
        proposal_digest: submitted.body.proposal_digest,
        review_notes: 'Catalog checked against platform documentation.',
      });

    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      success: true,
      proposal_id: submitted.body.proposal_id,
      platform: PLATFORM,
      publisher_domains: [PUBLISHER_DOMAIN],
    });
    const proposal = await pool.query(
      'SELECT status, reviewed_by_user_id, published_at FROM community_mirror_proposals WHERE id = $1',
      [submitted.body.proposal_id],
    );
    expect(proposal.rows[0]).toMatchObject({
      status: 'approved',
      reviewed_by_user_id: 'user_registry_moderator',
      published_at: expect.any(Date),
    });
    expect((await pool.query('SELECT 1 FROM community_mirrors WHERE platform = $1', [PLATFORM])).rows).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(1);

    const repeated = await request(app)
      .post(`/api/registry/mirror-proposals/${submitted.body.proposal_id}/approve`)
      .send({ proposal_digest: submitted.body.proposal_digest });
    expect(repeated.status).toBe(409);
    expect(repeated.body.error).toMatch(/already approved/i);
  });

  it('does not let a non-moderator approve another proposal', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    const approved = await request(app)
      .post(`/api/registry/mirror-proposals/${submitted.body.proposal_id}/approve`)
      .send({});
    expect(approved.status).toBe(403);
    expect((await pool.query('SELECT 1 FROM community_mirrors WHERE platform = $1', [PLATFORM])).rows).toHaveLength(0);
  });

  it('lets a moderator reject a pending proposal without publishing it', async () => {
    isRegistryModerator.mockResolvedValue(false);
    authState.userId = 'api_key_test_mirrors';
    authState.organizationId = 'org_test_mirrors';
    const submitted = await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());

    authState.userId = 'user_registry_moderator';
    authState.organizationId = null;
    isRegistryModerator.mockResolvedValue(true);
    const rejected = await request(app)
      .post(`/api/registry/mirror-proposals/${submitted.body.proposal_id}/reject`)
      .send({
        proposal_digest: submitted.body.proposal_digest,
        review_notes: 'Source evidence needs updating.',
      });

    expect(rejected.status).toBe(200);
    expect(rejected.body.proposal).toMatchObject({
      id: submitted.body.proposal_id,
      status: 'rejected',
      review_notes: 'Source evidence needs updating.',
    });
    expect((await pool.query('SELECT 1 FROM community_mirrors WHERE platform = $1', [PLATFORM])).rows).toHaveLength(0);
  });

  it('returns 404 for an unknown mirror', async () => {
    const res = await request(app).get(`/api/registry/mirrors/${PLATFORM}`);
    expect(res.status).toBe(404);
  });

  it('serves the mirror at /translated/<platform>/adagents.json with an ETag, and 304 on If-None-Match', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'serve-etag' }));

    const served = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/^application\/json/);
    expect(served.headers['access-control-allow-origin']).toBe('*');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);
    expect(served.headers['etag']).not.toBe('"serve-etag"');
    expect(served.body.authorized_agents).toEqual([]);

    const revalidate = await request(app)
      .get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)
      .set('If-None-Match', served.headers['etag']);
    expect(revalidate.status, JSON.stringify(revalidate.body)).toBe(304);
  });

  it('changes the HTTP ETag when content changes even if catalog_etag is reused', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: 'reused-token' }));
    const first = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);

    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({
        catalog_etag: 'reused-token',
        formats: [{ ...MINIMAL_FORMAT, display_name: 'Updated display name' }],
      }));
    const second = await request(app)
      .get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)
      .set('If-None-Match', first.headers['etag']);

    expect(second.status).toBe(200);
    expect(second.headers['etag']).not.toBe(first.headers['etag']);
    expect(second.body.formats[0].display_name).toBe('Updated display name');
  });

  it('uses a content-hash ETag when catalog_etag is absent', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody({ catalog_etag: undefined }));
    const served = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(served.status).toBe(200);
    expect(served.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);

    const revalidate = await request(app)
      .get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)
      .set('If-None-Match', served.headers['etag']);
    expect(revalidate.status, JSON.stringify(revalidate.body)).toBe(304);
  });

  it('serving carries superseded_by in the body and advertises it via a Link header', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ superseded_by: 'https://meta.com/.well-known/adagents.json' }));
    const served = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(served.status).toBe(200);
    // The body field is the normative SDK trigger; the Link header is an additive hint.
    expect(served.body.superseded_by).toBe('https://meta.com/.well-known/adagents.json');
    expect(served.headers['link']).toContain('rel="successor-version"');
    expect(served.headers['link']).toContain('https://meta.com/.well-known/adagents.json');
  });

  it('serving returns 404 for an unpublished platform', async () => {
    const res = await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`);
    expect(res.status).toBe(404);
  });

  it('deletes a superseded mirror and returns the serving route to 404', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ superseded_by: 'https://meta.com/.well-known/adagents.json' }));
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
    expect((await request(app).get(`/api/registry/mirrors/${PLATFORM}`)).status).toBe(404);
    expect((await request(app).get(`/api/creative-agent/translated/${PLATFORM}/adagents.json`)).status).toBe(404);
  });

  it('refuses to delete a mirror that has not been superseded (409)', async () => {
    await request(app).put(`/api/registry/mirrors/${PLATFORM}`).send(publishBody());
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/superseded/i);
    // The mirror is still served — fallback traffic is protected.
    expect((await request(app).get(`/api/registry/mirrors/${PLATFORM}`)).status).toBe(200);
  });

  it('force-deletes a non-superseded mirror with ?force=true', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ collections: [MINIMAL_COLLECTION] }));
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}?force=true`);
    expect(del.status).toBe(200);
    expect((await request(app).get(`/api/registry/mirrors/${PLATFORM}`)).status).toBe(404);
    expect((await pool.query('SELECT 1 FROM publishers WHERE domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM discovered_properties WHERE publisher_domain = $1', [PUBLISHER_DOMAIN])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM catalog_properties WHERE created_by = $1', [`community_adagents:${PLATFORM}`])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM catalog_collections WHERE created_by = $1', [`community_adagents:${PLATFORM}`])).rows).toHaveLength(0);
    expect((await pool.query(
      `SELECT 1
         FROM catalog_collection_identifiers cci
         JOIN catalog_collections cc ON cc.collection_rid = cci.collection_rid
        WHERE cc.created_by = $1`,
      [`community_adagents:${PLATFORM}`],
    )).rows).toHaveLength(0);
  });

  it('retiring after first-party self-host takeover removes stale community properties', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ collections: [MINIMAL_COLLECTION] }));
    await publisherDb.upsertAdagentsCache({
      domain: PUBLISHER_DOMAIN,
      manifest: {
        authorized_agents: [],
        properties: [{
          property_id: 'self-hosted',
          property_type: 'website',
          name: 'Self Hosted Site',
          identifiers: [{ type: 'domain', value: PUBLISHER_DOMAIN }],
        }],
        collections: [{
          ...MINIMAL_COLLECTION,
          name: 'Self Hosted Show',
        }],
      },
      statusCode: 200,
      responseBytes: 512,
      resolvedUrl: `https://${PUBLISHER_DOMAIN}/.well-known/adagents.json`,
      discoveryMethod: 'direct',
    });

    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}?force=true`);
    expect(del.status).toBe(200);

    const properties = await federatedDb.getPropertiesForDomain(PUBLISHER_DOMAIN);
    expect(properties.map(p => p.name)).toEqual(['Self Hosted Site']);
    expect(properties[0]?.source_type).toBe('adagents_json');
    expect((await pool.query(
      'SELECT 1 FROM discovered_properties WHERE publisher_domain = $1 AND source_type = $2',
      [PUBLISHER_DOMAIN, 'community'],
    )).rows).toHaveLength(0);
    const collections = await pool.query<{ source: string; created_by: string; name: string }>(
      `SELECT source, created_by, name
         FROM catalog_collections
        WHERE publisher_domain = $1 AND collection_id = $2`,
      [PUBLISHER_DOMAIN, MINIMAL_COLLECTION.collection_id],
    );
    expect(collections.rows).toEqual([
      {
        source: 'authoritative',
        created_by: `adagents_json:${PUBLISHER_DOMAIN}`,
        name: 'Self Hosted Show',
      },
    ]);
  });

  it('returns 404 deleting an unknown mirror', async () => {
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(404);
  });

  it('rejects delete from a non-moderator, non-admin caller (403)', async () => {
    await request(app)
      .put(`/api/registry/mirrors/${PLATFORM}`)
      .send(publishBody({ superseded_by: 'https://meta.com/.well-known/adagents.json' }));
    isRegistryModerator.mockResolvedValue(false);
    isWebUserAAOAdmin.mockResolvedValue(false);
    const del = await request(app).delete(`/api/registry/mirrors/${PLATFORM}`);
    expect(del.status).toBe(403);
  });
});
