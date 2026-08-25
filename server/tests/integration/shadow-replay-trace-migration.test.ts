import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const EXTERNAL_ID = 'shadow-replay-migration-test:1000.0001';
const CORRECTED_EXTERNAL_ID = 'shadow-replay-migration-test:1000.0002';
const PRIVATE_SENTINEL = 'private.person@example.test secret-client';
const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/552_shadow_replay_traces.sql'),
  'utf8',
);

describe('migrations 552 and 554: shadow replay traces', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL
        || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(
        'DELETE FROM addie_threads WHERE external_id = ANY($1)',
        [[EXTERNAL_ID, CORRECTED_EXTERNAL_ID]],
      );
    }
    await closeDatabase();
  });

  it('redacts an untagged legacy error row based on private queue-key presence', async () => {
    await pool.query('DELETE FROM addie_threads WHERE external_id = $1', [EXTERNAL_ID]);
    const inserted = await pool.query<{ thread_id: string }>(
      `INSERT INTO addie_threads (
         channel, external_id, user_type, flagged, flag_reason, context
       ) VALUES (
         'slack', $1, 'slack', TRUE, $2::text,
         jsonb_build_object(
           'shadow_eval_status', 'error',
           'shadow_eval_question', $2::text,
           'shadow_eval_router_decision', jsonb_build_object('reason', $2::text),
           'unrelated_key', 'preserved'
         )
       ) RETURNING thread_id`,
      [EXTERNAL_ID, PRIVATE_SENTINEL],
    );

    await pool.query(MIGRATION_SQL);
    const result = await pool.query<{
      context: Record<string, unknown>;
      flag_reason: string | null;
    }>(
      'SELECT context, flag_reason FROM addie_threads WHERE thread_id = $1',
      [inserted.rows[0].thread_id],
    );

    expect(result.rows[0].context).toEqual({
      shadow_eval_status: 'error',
      unrelated_key: 'preserved',
    });
    expect(JSON.stringify(result.rows[0])).not.toContain(PRIVATE_SENTINEL);
    expect(result.rows[0].flag_reason).toBe(
      'Suppressed-opportunity evaluation (legacy details redacted)',
    );
  });

  it('preserves corrected-answer evidence that uses shared evaluation keys', async () => {
    await pool.query('DELETE FROM addie_threads WHERE external_id = $1', [CORRECTED_EXTERNAL_ID]);
    const correctedContext = {
      shadow_eval_status: 'complete',
      shadow_eval_type: 'corrected_answer',
      shadow_eval_source: 'addie_corrected_capture',
      shadow_eval_question: 'corrected question',
      shadow_eval_answer_response: 'production answer',
      shadow_eval_human_response: 'human correction',
      shadow_eval_result: { gap_details: 'specific missing fact' },
    };
    const inserted = await pool.query<{ thread_id: string }>(
      `INSERT INTO addie_threads (
         channel, external_id, user_type, flagged, flag_reason, context
       ) VALUES ('slack', $1, 'slack', TRUE, 'Corrected answer', $2::jsonb)
       RETURNING thread_id`,
      [CORRECTED_EXTERNAL_ID, JSON.stringify(correctedContext)],
    );

    await pool.query(MIGRATION_SQL);
    const result = await pool.query<{
      context: Record<string, unknown>;
      flag_reason: string | null;
    }>(
      'SELECT context, flag_reason FROM addie_threads WHERE thread_id = $1',
      [inserted.rows[0].thread_id],
    );

    expect(result.rows[0]).toEqual({
      context: correctedContext,
      flag_reason: 'Corrected answer',
    });
  });

  it('requires complete version-2 request provenance without retaining one trace per thread', async () => {
    const columns = await pool.query<{
      column_name: string;
      column_default: string | null;
    }>(
      `SELECT column_name, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'addie_shadow_replay_traces'
         AND column_name = ANY($1)`,
      [[
        'capture_version',
        'capture_status',
        'capture_reason',
        'capture_completed_at',
        'capability_profile',
        'capability_policy_version',
        'approved_tool_names',
        'message_payload_hmacs',
        'provider_request_hmac',
      ]],
    );
    expect(columns.rows.map(({ column_name }) => column_name).sort()).toEqual([
      'approved_tool_names',
      'capability_policy_version',
      'capability_profile',
      'capture_completed_at',
      'capture_reason',
      'capture_status',
      'capture_version',
      'message_payload_hmacs',
      'provider_request_hmac',
    ]);
    expect(columns.rows.find(({ column_name }) => column_name === 'capture_version')?.column_default)
      .toContain('2');
    expect(columns.rows.find(({ column_name }) => column_name === 'capture_status')?.column_default)
      .toContain('pending');

    const constraints = await pool.query<{
      conname: string;
      contype: string;
      definition: string;
    }>(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'addie_shadow_replay_traces'::regclass`,
    );
    expect(constraints.rows.some(({ conname, definition }) =>
      conname === 'addie_shadow_replay_traces_v2_request_boundary_check'
      && definition.includes('provider_request_hmac IS NOT NULL'))).toBe(true);
    expect(constraints.rows.some(({ conname }) =>
      conname === 'addie_shadow_replay_traces_thread_id_key')).toBe(false);
    expect(constraints.rows.some(({ contype, definition }) =>
      contype === 'u' && definition.includes('(source_question_message_id)'))).toBe(true);

    const attemptColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'addie_shadow_replay_capture_attempts'`,
    );
    expect(attemptColumns.rows.map(({ column_name }) => column_name)).toEqual(
      expect.arrayContaining([
        'attempt_id',
        'thread_id',
        'source_question_message_id',
        'capability_profile',
        'status',
        'reason',
        'trace_id',
        'created_at',
        'completed_at',
        'retained_until',
      ]),
    );
  });
});
