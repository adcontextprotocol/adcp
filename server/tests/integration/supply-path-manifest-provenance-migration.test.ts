import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../../src/db/migrations/597_supply_path_manifest_provenance.sql'),
  'utf8'
);
const schema = `supply_path_migration_${randomUUID().replaceAll('-', '')}`;

describe.skipIf(!process.env.DATABASE_URL)('migration 597: manifest-bound supply-path provenance', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE publishers (
      domain TEXT PRIMARY KEY,
      adagents_json JSONB,
      resolved_url TEXT,
      last_validated TIMESTAMPTZ
    )`);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      client.release();
    }
    await pool?.end();
  });

  it('keeps historical and newly inserted manifests untrusted until a provenance-aware refresh', async () => {
    const manifest = { authorized_agents: [] };
    await client.query(
      `INSERT INTO publishers (domain, adagents_json, resolved_url, last_validated)
       VALUES ('publisher.example', $1, 'https://failed-target.example/adagents.json', NOW())`,
      [manifest]
    );
    await client.query(migration);
    await client.query(`INSERT INTO publishers (domain) VALUES ('new.example')`);

    const result = await client.query(
      'SELECT domain, adagents_json, supply_path_provenance FROM publishers ORDER BY domain'
    );
    expect(result.rows).toEqual([
      { domain: 'new.example', adagents_json: null, supply_path_provenance: null },
      { domain: 'publisher.example', adagents_json: manifest, supply_path_provenance: null },
    ]);
    const column = await client.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'publishers' AND column_name = 'supply_path_provenance'`,
      [schema]
    );
    expect(column.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
  });

  it('replays without changing a successful manifest or its full provenance', async () => {
    await client.query(migration);
    const manifest = { authorized_agents: [{ url: 'https://agent.example/mcp' }] };
    const provenance = {
      resolved_url: `https://authority.example/manifests/${'a'.repeat(3000)}?publisher=publisher.example`,
      discovery_method: 'authoritative_location',
      fetched_at: '2026-09-14T00:00:00Z',
      expires_at: '2026-09-15T00:00:00Z',
    };
    await client.query(
      `INSERT INTO publishers (domain, adagents_json, supply_path_provenance)
       VALUES ('publisher.example', $1, $2)`,
      [manifest, provenance]
    );
    await client.query(migration);
    await client.query(migration);
    const result = await client.query('SELECT adagents_json, supply_path_provenance FROM publishers');
    expect(result.rows).toEqual([{ adagents_json: manifest, supply_path_provenance: provenance }]);
  });
});
