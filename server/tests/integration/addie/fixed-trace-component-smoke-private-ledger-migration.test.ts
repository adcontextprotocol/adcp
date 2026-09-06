import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.RUN_PRIVATE_LEDGER_POSTGRES_TEST === '1' ? process.env.DATABASE_URL : undefined;
const migration = readFileSync(new URL('../../../src/db/migrations/582_addie_fixed_trace_component_smoke_private_ledger.sql', import.meta.url), 'utf8');
let client: Client | null = null;

/** Requires the integration PostgreSQL service; no network or provider access. */
describe.skipIf(!databaseUrl)('private ledger migration on PostgreSQL', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query(migration);
  });
  afterAll(async () => { if (client) { await client.query('ROLLBACK').catch(() => undefined); await client.end().catch(() => undefined); } });
  it('accepts the 71-character sha256 pricing cohort column contract', async () => {
    const result = await client!.query<{ character_maximum_length: number | null }>(
      "SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'addie_fixed_trace_component_smoke_authorizations' AND column_name = 'pricing_cohort_digest'",
    );
    expect(result.rows).toEqual([{ character_maximum_length: 71 }]);
    expect(migration).toContain("pricing_cohort_digest ~ '^sha256:[a-f0-9]{64}$'");
  });
});
