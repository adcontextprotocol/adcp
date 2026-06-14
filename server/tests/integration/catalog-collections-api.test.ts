import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase, getClient } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createCatalogApiRouter } from '../../src/routes/catalog-api.js';
import { CollectionCatalogDatabase } from '../../src/db/collection-catalog-db.js';

const TEST_PUB = 'catalog-collections-api.example';
const AUTH_PUB = 'catalog-collections-auth.example';

function buildApp(config: Parameters<typeof createCatalogApiRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api/registry', createCatalogApiRouter(config));
  return app;
}

function passAuth(req: { user?: unknown }, _res: unknown, next: () => void) {
  req.user = { id: 'admin_api_key', email: 'admin@example.com' };
  next();
}

function collectionBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'API Show',
    kind: 'series',
    distribution: [
      {
        publisher_domain: 'youtube.com',
        identifiers: [
          { type: 'youtube_channel_handle', value: '@ApiShow' },
          { type: 'youtube_channel_url', value: 'https://www.youtube.com/@ApiShow/videos' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Catalog collection API routes', () => {
  let pool: Pool;
  let collectionDb: CollectionCatalogDatabase;
  let app: ReturnType<typeof buildApp>;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM catalog_events
        WHERE payload->>'publisher_domain' = ANY($1::text[])
           OR actor = 'registry:community_collection'`,
      [[TEST_PUB, AUTH_PUB]],
    );
    await pool.query(
      `DELETE FROM catalog_collection_identifiers cci
        WHERE cci.collection_rid IN (
          SELECT cc.collection_rid
            FROM catalog_collections cc
           WHERE cc.publisher_domain = ANY($1::text[])
        )`,
      [[TEST_PUB, AUTH_PUB]],
    );
    await pool.query(
      `DELETE FROM catalog_collections WHERE publisher_domain = ANY($1::text[])`,
      [[TEST_PUB, AUTH_PUB]],
    );
  }

  async function seedCollection(status: 'active' | 'removed' = 'active') {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const event = await collectionDb.projectCollection(client, {
        publisherDomain: TEST_PUB,
        collection: {
          collection_id: 'api_show',
          ...collectionBody(),
        },
        evidence: 'community',
        confidence: 'strong',
        source: 'contributed',
        createdBy: 'test:catalog-api',
      });
      if (!event) throw new Error('expected collection event');
      if (status === 'removed') {
        await client.query(
          `UPDATE catalog_collections SET status = 'removed' WHERE collection_rid = $1`,
          [event.collection_rid],
        );
      }
      await client.query('COMMIT');
      return event.collection_rid;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    collectionDb = new CollectionCatalogDatabase();
    app = buildApp({
      requireAuth: passAuth,
      requireAdmin: (_req, _res, next) => next(),
      requireGlobalAdmin: [passAuth],
    });
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  it('lists collections with filters and rejects invalid pagination', async () => {
    await seedCollection();

    const badLimit = await request(app).get('/api/registry/catalog/collections?limit=NaN');
    expect(badLimit.status).toBe(400);

    const res = await request(app)
      .get(`/api/registry/catalog/collections?publisher_domain=${TEST_PUB}&limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0]).toMatchObject({
      publisher_domain: TEST_PUB,
      collection_id: 'api_show',
      identifiers: [
        { publisher_domain: 'youtube.com', type: 'youtube_channel_handle', value: '@apishow' },
        { publisher_domain: 'youtube.com', type: 'youtube_channel_url', value: 'https://youtube.com/@apishow' },
      ],
    });
  });

  it('sync excludes removed collections', async () => {
    await seedCollection('removed');
    const res = await request(app).get('/api/registry/catalog/collections/sync?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.collections.filter((entry: { publisher_domain: string }) =>
      entry.publisher_domain === TEST_PUB
    )).toEqual([]);
  });

  it('looks up collections by distribution identifier through query and path routes', async () => {
    await seedCollection();

    const byHandle = await request(app)
      .get('/api/registry/catalog/collections/distribution')
      .query({
        publisher_domain: 'youtube.com',
        identifier_type: 'youtube_channel_handle',
        identifier_value: 'ApiShow',
      });
    expect(byHandle.status).toBe(200);
    expect(byHandle.body.collection_id).toBe('api_show');

    const encodedUrl = encodeURIComponent('https://www.youtube.com/@ApiShow/videos');
    const byPath = await request(app)
      .get(`/api/registry/catalog/collections/distribution/youtube.com/youtube_channel_url/${encodedUrl}`);
    expect(byPath.status).toBe(200);
    expect(byPath.body.collection_id).toBe('api_show');
  });

  it('rejects missing auth config and global-admin middleware failures on collection writes', async () => {
    const unconfigured = buildApp({});
    const unavailable = await request(unconfigured)
      .put(`/api/registry/catalog/collections/${TEST_PUB}/api_show`)
      .send(collectionBody());
    expect(unavailable.status).toBe(503);

    const forbiddenApp = buildApp({
      requireGlobalAdmin: [(_req, res) => res.status(403).json({ error: 'global_admin_required' })],
    });
    const forbidden = await request(forbiddenApp)
      .put(`/api/registry/catalog/collections/${TEST_PUB}/api_show`)
      .send(collectionBody());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('global_admin_required');
  });

  it('validates collection PUT bodies and refuses authoritative overwrites', async () => {
    const missingName = await request(app)
      .put(`/api/registry/catalog/collections/${TEST_PUB}/api_show`)
      .send({ kind: 'series', distribution: [] });
    expect(missingName.status).toBe(400);

    const mismatch = await request(app)
      .put(`/api/registry/catalog/collections/${TEST_PUB}/api_show`)
      .send(collectionBody({ collection_id: 'different' }));
    expect(mismatch.status).toBe(400);

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await collectionDb.projectCollection(client, {
        publisherDomain: AUTH_PUB,
        collection: { collection_id: 'auth_show', ...collectionBody({ name: 'Authoritative Show' }) },
        evidence: 'adagents_json',
        confidence: 'authoritative',
        source: 'authoritative',
        createdBy: `adagents_json:${AUTH_PUB}`,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const authoritative = await request(app)
      .put(`/api/registry/catalog/collections/${AUTH_PUB}/auth_show`)
      .send(collectionBody({ name: 'Overwrite' }));
    expect(authoritative.status).toBe(409);
  });

  it('writes collection.created and collection.updated events transactionally', async () => {
    const created = await request(app)
      .put(`/api/registry/catalog/collections/${TEST_PUB}/api_show`)
      .send(collectionBody());
    expect(created.status).toBe(200);
    expect(created.body.event_type).toBe('collection.created');

    const updated = await request(app)
      .put(`/api/registry/catalog/collections/${TEST_PUB}/api_show`)
      .send(collectionBody({ name: 'API Show Updated' }));
    expect(updated.status).toBe(200);
    expect(updated.body.event_type).toBe('collection.updated');

    const events = await pool.query<{ event_type: string; payload: { collection_id?: string; name?: string } }>(
      `SELECT event_type, payload
         FROM catalog_events
        WHERE payload->>'publisher_domain' = $1
        ORDER BY created_at`,
      [TEST_PUB],
    );
    expect(events.rows.map((row) => [row.event_type, row.payload.collection_id, row.payload.name])).toEqual([
      ['collection.created', 'api_show', 'API Show'],
      ['collection.updated', 'api_show', 'API Show Updated'],
    ]);
  });
});
