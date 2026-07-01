import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { initializeDatabase, closeDatabase, getClient } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PublisherDatabase, type AdagentsManifest } from '../../src/db/publisher-db.js';
import { CatalogEventsDatabase, type CatalogEvent } from '../../src/db/catalog-events-db.js';
import { CollectionCatalogDatabase } from '../../src/db/collection-catalog-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_ROOT = path.resolve(__dirname, '../../../static/schemas/source');
const TEST_PUB = 'collection-writer.example';
const OTHER_PUB = 'collection-other.example';
const COMMUNITY_PUB = 'collection-community.example';

function loadSchemaByRef(ref: string): unknown {
  const relative = ref.replace(/^\/schemas\//, '');
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, relative), 'utf8'));
}

async function buildRegistryEventValidator() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async (uri) => loadSchemaByRef(uri),
  });
  addFormats(ajv);
  return ajv.compileAsync(loadSchemaByRef('/schemas/core/registry-event.json'));
}

function collection(
  collectionId: string,
  handle: string,
  overrides: Record<string, unknown> = {},
): NonNullable<AdagentsManifest['collections']>[number] {
  return {
    collection_id: collectionId,
    name: 'Weekly Show',
    kind: 'series',
    distribution: [
      {
        publisher_domain: 'youtube.com',
        identifiers: [
          { type: 'youtube_channel_handle', value: handle },
          { type: 'youtube_channel_url', value: `m.youtube.com/${handle}/videos` },
        ],
      },
    ],
    ...overrides,
  };
}

function eventForSchema(row: CatalogEvent): Record<string, unknown> {
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

describe('CollectionCatalogDatabase integration', () => {
  let pool: Pool;
  let publisherDb: PublisherDatabase;
  let eventsDb: CatalogEventsDatabase;
  let collectionsDb: CollectionCatalogDatabase;
  let validateRegistryEvent: Awaited<ReturnType<typeof buildRegistryEventValidator>>;

  async function clearFixtures() {
    await pool.query(
      `DELETE FROM catalog_events
        WHERE actor LIKE 'test:collections%'
           OR actor = 'registry:community_mirror'
           OR payload->>'publisher_domain' = ANY($1::text[])`,
      [[TEST_PUB, OTHER_PUB, COMMUNITY_PUB]],
    );
    await pool.query(
      `DELETE FROM catalog_collection_identifiers cci
        WHERE cci.collection_rid IN (
          SELECT cc.collection_rid
            FROM catalog_collections cc
           WHERE cc.publisher_domain = ANY($1::text[])
              OR cc.created_by IN ($2, $3, $4)
        )`,
      [
        [TEST_PUB, OTHER_PUB, COMMUNITY_PUB],
        `adagents_json:${TEST_PUB}`,
        `adagents_json:${OTHER_PUB}`,
        'test:community',
      ],
    );
    await pool.query(
      `DELETE FROM catalog_collections
        WHERE publisher_domain = ANY($1::text[])
           OR created_by IN ($2, $3, $4)`,
      [
        [TEST_PUB, OTHER_PUB, COMMUNITY_PUB],
        `adagents_json:${TEST_PUB}`,
        `adagents_json:${OTHER_PUB}`,
        'test:community',
      ],
    );
    await pool.query(
      `DELETE FROM publishers WHERE domain = ANY($1::text[])`,
      [[TEST_PUB, OTHER_PUB, COMMUNITY_PUB]],
    );
  }

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    publisherDb = new PublisherDatabase();
    eventsDb = new CatalogEventsDatabase();
    collectionsDb = new CollectionCatalogDatabase();
    validateRegistryEvent = await buildRegistryEventValidator();
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  it('projects authoritative collections idempotently and emits schema-valid events', async () => {
    await publisherDb.upsertAdagentsCache({
      domain: TEST_PUB,
      manifest: {
        authorized_agents: [],
        collections: [collection('weekly_show', '@WeeklyShow')],
      },
      eventsDb,
      collectionEventActor: 'test:collections:authoritative',
    });

    const createdFeed = await eventsDb.queryFeed(null, ['collection.*'], 10);
    if ('error' in createdFeed) throw new Error(createdFeed.message);
    const created = createdFeed.events.filter((event) => event.actor === 'test:collections:authoritative');
    expect(created.map((event) => event.event_type)).toEqual(['collection.created']);
    for (const event of created) {
      expect(validateRegistryEvent(eventForSchema(event))).toBe(true);
    }

    const lookup = await collectionsDb.lookupByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_url',
      'https://www.youtube.com/@WeeklyShow/videos',
    );
    expect(lookup?.publisher_domain).toBe(TEST_PUB);
    expect(lookup?.collection_id).toBe('weekly_show');
    expect(lookup?.identifiers.map((i) => i.identifier_value).sort()).toEqual([
      '@weeklyshow',
      'https://youtube.com/@weeklyshow',
    ]);

    await publisherDb.upsertAdagentsCache({
      domain: TEST_PUB,
      manifest: {
        authorized_agents: [],
        collections: [collection('weekly_show', '@WeeklyShow')],
      },
      eventsDb,
      collectionEventActor: 'test:collections:authoritative',
    });

    const afterIdempotentFeed = await eventsDb.queryFeed(null, ['collection.*'], 10);
    if ('error' in afterIdempotentFeed) throw new Error(afterIdempotentFeed.message);
    expect(afterIdempotentFeed.events.filter((event) => event.actor === 'test:collections:authoritative')).toHaveLength(1);
  });

  it('retires renamed collections and lets the new collection reclaim the same identifier in one crawl', async () => {
    await publisherDb.upsertAdagentsCache({
      domain: TEST_PUB,
      manifest: {
        authorized_agents: [],
        collections: [collection('old_show', '@WeeklyShow')],
      },
      eventsDb,
      collectionEventActor: 'test:collections:rename',
    });

    await publisherDb.upsertAdagentsCache({
      domain: TEST_PUB,
      manifest: {
        authorized_agents: [],
        collections: [collection('new_show', '@WeeklyShow', { name: 'New Weekly Show' })],
      },
      eventsDb,
      collectionEventActor: 'test:collections:rename',
    });

    const lookup = await collectionsDb.lookupByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_handle',
      '@weeklyshow',
    );
    expect(lookup?.collection_id).toBe('new_show');
    expect(lookup?.status).toBe('active');

    const rows = await pool.query<{ collection_id: string; status: string }>(
      `SELECT collection_id, status
         FROM catalog_collections
        WHERE publisher_domain = $1
        ORDER BY collection_id`,
      [TEST_PUB],
    );
    expect(rows.rows).toEqual([
      { collection_id: 'new_show', status: 'active' },
      { collection_id: 'old_show', status: 'removed' },
    ]);

    const feed = await eventsDb.queryFeed(null, ['collection.*'], 10);
    if ('error' in feed) throw new Error(feed.message);
    expect(feed.events
      .filter((event) => event.actor === 'test:collections:rename')
      .map((event) => event.event_type)
      .sort()
    ).toEqual(['collection.created', 'collection.created', 'collection.removed']);
  });

  it('authoritative identifiers supersede contributed identifiers, but contributed cannot steal authoritative identifiers', async () => {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await collectionsDb.projectCollection(client, {
        publisherDomain: COMMUNITY_PUB,
        collection: collection('community_show', '@SharedShow') as Record<string, unknown>,
        evidence: 'community',
        confidence: 'strong',
        source: 'contributed',
        createdBy: 'test:community',
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await publisherDb.upsertAdagentsCache({
      domain: TEST_PUB,
      manifest: {
        authorized_agents: [],
        collections: [collection('authoritative_show', '@SharedShow')],
      },
    });

    expect((await collectionsDb.lookupByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_handle',
      '@sharedshow',
    ))?.publisher_domain).toBe(TEST_PUB);

    const secondClient = await getClient();
    try {
      await secondClient.query('BEGIN');
      await collectionsDb.projectCollection(secondClient, {
        publisherDomain: OTHER_PUB,
        collection: collection('other_show', '@SharedShow') as Record<string, unknown>,
        evidence: 'community',
        confidence: 'strong',
        source: 'contributed',
        createdBy: 'test:community',
      });
      await secondClient.query('COMMIT');
    } catch (err) {
      await secondClient.query('ROLLBACK');
      throw err;
    } finally {
      secondClient.release();
    }

    expect((await collectionsDb.lookupByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_handle',
      '@sharedshow',
    ))?.publisher_domain).toBe(TEST_PUB);

    const conflicts = await pool.query<{ predicate: string }>(
      `SELECT predicate
         FROM catalog_collection_facts
        WHERE subject_value = $1
          AND predicate = 'identifier_conflict'`,
      ['youtube.com:youtube_channel_handle:@sharedshow'],
    );
    expect(conflicts.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('duplicate distribution identifiers do not abort sibling collection projection', async () => {
    await publisherDb.upsertAdagentsCache({
      domain: TEST_PUB,
      manifest: {
        authorized_agents: [],
        collections: [
          collection('first_show', '@DuplicateShow'),
          collection('second_show', '@DuplicateShow', { name: 'Second Show' }),
        ],
      },
      eventsDb,
      collectionEventActor: 'test:collections:duplicate',
    });

    const rows = await pool.query<{ collection_id: string; status: string }>(
      `SELECT collection_id, status
         FROM catalog_collections
        WHERE publisher_domain = $1
        ORDER BY collection_id`,
      [TEST_PUB],
    );
    expect(rows.rows).toEqual([
      { collection_id: 'first_show', status: 'active' },
      { collection_id: 'second_show', status: 'active' },
    ]);
    expect((await collectionsDb.lookupByDistributionIdentifier(
      'youtube.com',
      'youtube_channel_handle',
      '@duplicateshow',
    ))?.collection_id).toBe('first_show');
  });
});
