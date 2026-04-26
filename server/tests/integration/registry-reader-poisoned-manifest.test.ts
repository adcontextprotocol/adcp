/**
 * Regression coverage for the malformed-manifest DoS surfaced by both
 * reviewers on PR 4a of #3177. The validator (adagents-manager.ts) only
 * type-checks `authorized_agents`; a publisher serving a JSON-valid
 * manifest with `properties: "x"` (or any non-array) used to crash
 * jsonb_array_elements / jsonb_array_length in the readers, taking down
 * the public registry listing for everyone.
 *
 * Two layers of defense exercised here:
 *  - publisher-db.ts upsertAdagentsCache normalizes `properties` /
 *    `authorized_agents` to arrays before stringifying into JSONB.
 *  - federated-index-db.ts / property-db.ts readers wrap the JSONB
 *    operators with `jsonb_typeof = 'array'` guards.
 *
 * The test forces the worst case by writing the malformed body directly,
 * bypassing the writer's normalization, then asserts every reader returns
 * an empty/zero result rather than throwing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FederatedIndexDatabase } from '../../src/db/federated-index-db.js';
import { PropertyDatabase } from '../../src/db/property-db.js';

const POISONED_DOMAIN = 'poisoned.registry-baseline.example';

describe('Registry readers tolerate malformed publishers.adagents_json bodies', () => {
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

  async function clearFixtures() {
    await pool.query('DELETE FROM publishers WHERE domain = $1', [POISONED_DOMAIN]);
    await pool.query('DELETE FROM discovered_properties WHERE publisher_domain = $1', [POISONED_DOMAIN]);
    await pool.query('DELETE FROM discovered_publishers WHERE domain = $1', [POISONED_DOMAIN]);
  }

  beforeEach(async () => {
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    await closeDatabase();
  });

  /**
   * Write the manifest body directly into publishers.adagents_json,
   * bypassing the writer's normalization. This simulates either:
   *  - a row that landed before publisher-db.ts grew its normalization, or
   *  - a future regression where the writer's guard slips.
   */
  async function seedPoisonedManifest(body: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO publishers (domain, adagents_json, source_type, last_validated)
       VALUES ($1, $2::jsonb, 'adagents_json', NOW())
       ON CONFLICT (domain) DO UPDATE SET
         adagents_json = EXCLUDED.adagents_json,
         source_type = 'adagents_json',
         last_validated = NOW()`,
      [POISONED_DOMAIN, JSON.stringify(body)]
    );
  }

  it('getPropertiesForDomain returns [] when properties is a string', async () => {
    await seedPoisonedManifest({ authorized_agents: [], properties: 'evil' });
    await expect(fedDb.getPropertiesForDomain(POISONED_DOMAIN)).resolves.toEqual([]);
  });

  it('getDiscoveredPropertiesByDomain returns [] when properties is an object', async () => {
    await seedPoisonedManifest({ authorized_agents: [], properties: { not: 'an array' } });
    await expect(propDb.getDiscoveredPropertiesByDomain(POISONED_DOMAIN)).resolves.toEqual([]);
  });

  it('getPropertiesForDomain tolerates a non-array tags field on a manifest property', async () => {
    await seedPoisonedManifest({
      authorized_agents: [],
      properties: [
        {
          property_id: 'p1',
          property_type: 'website',
          name: 'Bad Tags Site',
          identifiers: [{ type: 'domain', value: POISONED_DOMAIN }],
          tags: 'shopping',
        },
      ],
    });
    const props = await fedDb.getPropertiesForDomain(POISONED_DOMAIN);
    expect(props).toHaveLength(1);
    expect(props[0].tags).toEqual([]);
  });

  it('getPropertiesForDomain tolerates a non-array identifiers field on a manifest property', async () => {
    await seedPoisonedManifest({
      authorized_agents: [],
      properties: [
        {
          property_id: 'p1',
          property_type: 'website',
          name: 'Bad Identifiers Site',
          identifiers: 'not-an-array',
        },
      ],
    });
    const props = await fedDb.getPropertiesForDomain(POISONED_DOMAIN);
    expect(props).toHaveLength(1);
    expect(props[0].identifiers).toEqual([]);
  });

  it('getAllPropertiesForRegistry tolerates a poisoned publisher and still returns clean rows', async () => {
    // Poisoned manifest with non-array properties — would have killed the
    // whole catalog_only CTE before the jsonb_typeof guards.
    await seedPoisonedManifest({ authorized_agents: 12, properties: 'x' });

    // Without throwing, the listing should run. The poisoned domain itself
    // surfaces (via the catalog_only branch) with zero counts.
    const rows = await propDb.getAllPropertiesForRegistry({
      search: 'poisoned.registry-baseline',
      limit: 50,
    });
    const poisonedRow = rows.find((r) => r.domain === POISONED_DOMAIN);
    expect(poisonedRow).toBeTruthy();
    expect(poisonedRow!.property_count).toBe(0);
    expect(poisonedRow!.agent_count).toBe(0);
  });

  it('getPropertyRegistryStats tolerates a poisoned publisher', async () => {
    await seedPoisonedManifest({ authorized_agents: null, properties: false });
    // Just checking it doesn't throw — the poisoned row counts toward
    // adagents_json under the catalog_only branch.
    const stats = await propDb.getPropertyRegistryStats('poisoned.registry-baseline');
    expect(stats.total).toBeGreaterThanOrEqual(0);
  });
});
