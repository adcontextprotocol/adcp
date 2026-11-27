import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCHEDULE_STATE_MIGRATION = readFileSync(
  resolve(__dirname, '../../src/db/migrations/635_compliance_heartbeat_schedule_state.sql'),
  'utf8',
);

/** The shape of the two tables as the previous release left them. */
const PRE_MIGRATION_SCHEMA = `
  CREATE TABLE agent_registry_metadata (
    agent_url TEXT PRIMARY KEY,
    check_interval_hours INTEGER NOT NULL DEFAULT 12,
    next_compliance_check_at TIMESTAMPTZ,
    heartbeat_claim_owner TEXT,
    heartbeat_started_at TIMESTAMPTZ
  );
  CREATE TABLE agent_compliance_runs (
    agent_url TEXT NOT NULL,
    tested_at TIMESTAMPTZ NOT NULL,
    triggered_by TEXT NOT NULL DEFAULT 'heartbeat',
    dry_run BOOLEAN NOT NULL DEFAULT TRUE,
    is_authoritative BOOLEAN NOT NULL DEFAULT TRUE
  );
`;

interface MigratedRow {
  agent_url: string;
  next_compliance_check_at: Date | null;
  compliance_lock_until: Date | null;
  last_heartbeat_attempt_at: Date | null;
  last_heartbeat_skip_reason: string | null;
  last_heartbeat_success_at: Date | null;
}

describe.skipIf(!process.env.DATABASE_URL)('compliance heartbeat schedule state migration', () => {
  const schema = `heartbeat_schedule_migration_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;

  const row = async (agentUrl: string): Promise<MigratedRow> => (await client.query<MigratedRow>(
    `SELECT agent_url, next_compliance_check_at, compliance_lock_until,
            last_heartbeat_attempt_at, last_heartbeat_skip_reason, last_heartbeat_success_at
     FROM agent_registry_metadata WHERE agent_url = $1`,
    [agentUrl],
  )).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(PRE_MIGRATION_SCHEMA);
  });

  afterEach(async () => {
    await client?.query('ROLLBACK');
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('moves an in-flight batch claim into the lock and leaves its agent due', async () => {
    const claimLock = new Date(Date.now() + 100 * 60 * 1000);
    const cadence = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO agent_registry_metadata (agent_url, next_compliance_check_at, heartbeat_claim_owner)
       VALUES ('claimed', $1, 'machine-1:process'), ('scheduled', $2, NULL), ('never', NULL, NULL)`,
      [claimLock, cadence],
    );

    await client.query(SCHEDULE_STATE_MIGRATION);

    expect(await row('claimed')).toMatchObject({ compliance_lock_until: claimLock, next_compliance_check_at: null });
    expect(await row('scheduled')).toMatchObject({ compliance_lock_until: null, next_compliance_check_at: cadence });
    expect(await row('never')).toMatchObject({ compliance_lock_until: null, next_compliance_check_at: null });
  });

  it('seeds attempt and success history from recorded heartbeat runs only', async () => {
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO agent_registry_metadata (agent_url) VALUES ('skipping'), ('healthy'), ('owner-only'), ('unseen')`,
    );
    await client.query(
      `INSERT INTO agent_compliance_runs (agent_url, tested_at, triggered_by, dry_run, is_authoritative) VALUES
         ('skipping', $1, 'heartbeat', FALSE, TRUE),
         ('skipping', $2, 'heartbeat', FALSE, FALSE),
         ('skipping', $3, 'owner_test', FALSE, TRUE),
         ('skipping', $4, 'heartbeat', TRUE, TRUE),
         ('healthy', $2, 'heartbeat', FALSE, TRUE),
         ('owner-only', $3, 'owner_test', FALSE, TRUE)`,
      [at(72), at(24), at(1), at(0.5)],
    );

    await client.query(SCHEDULE_STATE_MIGRATION);

    // Owner tests and dry runs are not heartbeats; a non-authoritative heartbeat
    // is an attempt but not a success.
    expect(await row('skipping')).toMatchObject({
      last_heartbeat_attempt_at: at(24),
      last_heartbeat_success_at: at(72),
      last_heartbeat_skip_reason: null,
    });
    expect(await row('healthy')).toMatchObject({
      last_heartbeat_attempt_at: at(24),
      last_heartbeat_success_at: at(24),
    });
    expect(await row('owner-only')).toMatchObject({ last_heartbeat_attempt_at: null, last_heartbeat_success_at: null });
    expect(await row('unseen')).toMatchObject({ last_heartbeat_attempt_at: null, last_heartbeat_success_at: null });
  });

  it('leaves rows it already migrated untouched when re-applied', async () => {
    await client.query(
      `INSERT INTO agent_registry_metadata (agent_url, next_compliance_check_at, heartbeat_claim_owner)
       VALUES ('claimed', NOW() + INTERVAL '1 hour', 'machine-1:process')`,
    );
    await client.query(
      `INSERT INTO agent_compliance_runs (agent_url, tested_at, dry_run) VALUES ('claimed', NOW() - INTERVAL '2 days', FALSE)`,
    );
    await client.query(SCHEDULE_STATE_MIGRATION);
    const newCadence = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await client.query(
      `UPDATE agent_registry_metadata
       SET next_compliance_check_at = $1, last_heartbeat_attempt_at = NOW(), last_heartbeat_success_at = NOW()
       WHERE agent_url = 'claimed'`,
      [newCadence],
    );
    const before = await row('claimed');

    await client.query(SCHEDULE_STATE_MIGRATION);

    expect(await row('claimed')).toEqual(before);
  });
});
