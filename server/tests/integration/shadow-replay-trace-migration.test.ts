import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { claimShadowReplayGeneration } from '../../src/addie/jobs/shadow-replay-trace.js';

const EXTERNAL_ID = 'shadow-replay-migration-test:1000.0001';
const CORRECTED_EXTERNAL_ID = 'shadow-replay-migration-test:1000.0002';
const V2_EXTERNAL_ID = 'shadow-replay-migration-test:1000.0003';
const QUOTA_EXTERNAL_IDS = [
  'shadow-replay-migration-test:quota-1',
  'shadow-replay-migration-test:quota-2',
] as const;
const QUOTA_CONFIG_HASH = 'shadow-replay-quota-concurrency-v1';
const PRIVATE_SENTINEL = 'private.person@example.test secret-client';
const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/552_shadow_replay_traces.sql'),
  'utf8',
);
const MIGRATION_556_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/556_shadow_replay_judgment_provenance.sql'),
  'utf8',
);

describe('migrations 552, 554, 555, and 556: shadow replay traces', () => {
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
        [[EXTERNAL_ID, CORRECTED_EXTERNAL_ID, V2_EXTERNAL_ID, ...QUOTA_EXTERNAL_IDS]],
      );
      await pool.query('DELETE FROM addie_config_versions WHERE config_hash = $1', [
        QUOTA_CONFIG_HASH,
      ]);
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

  it('requires complete version-3 request and optional human evidence provenance', async () => {
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
        'capture_parity_verified',
        'capture_status',
        'capture_reason',
        'capture_completed_at',
        'capability_profile',
        'capability_policy_version',
        'approved_tool_names',
        'message_payload_hmacs',
        'provider_request_hmac',
        'human_response_slack_message_ts',
        'human_response_user_hmac',
        'human_response_content_hmac',
      ]],
    );
    expect(columns.rows.map(({ column_name }) => column_name).sort()).toEqual([
      'approved_tool_names',
      'capability_policy_version',
      'capability_profile',
      'capture_completed_at',
      'capture_parity_verified',
      'capture_reason',
      'capture_status',
      'capture_version',
      'human_response_content_hmac',
      'human_response_slack_message_ts',
      'human_response_user_hmac',
      'message_payload_hmacs',
      'provider_request_hmac',
    ]);
    expect(columns.rows.find(({ column_name }) => column_name === 'capture_version')?.column_default)
      .toContain('3');
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
    expect(constraints.rows.some(({ conname, definition }) =>
      conname === 'addie_shadow_replay_traces_human_evidence_all_or_none'
      && definition.includes('(capture_version = 3)'))).toBe(true);
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
        'capture_version',
        'status',
        'reason',
        'trace_id',
        'created_at',
        'completed_at',
        'retained_until',
      ]),
    );

    const generationColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'addie_shadow_replay_generations'`,
    );
    expect(generationColumns.rows.map(({ column_name }) => column_name)).toEqual(
      expect.arrayContaining([
        'trace_id',
        'execution_policy_version',
        'status',
        'reason',
        'model',
        'quota_date',
        'quota_slot',
        'first_provider_request_hmac',
        'output_hmac',
        'output_bytes',
        'invocation_hmacs',
        'tool_executions',
        'blocked_capabilities',
        'input_tokens',
        'output_tokens',
        'started_at',
        'heartbeat_at',
        'completed_at',
        'retained_until',
      ]),
    );
    const generationConstraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'addie_shadow_replay_generations'::regclass`,
    );
    expect(generationConstraints.rows.some(({ definition }) =>
      definition.includes('jsonb_array_length(invocation_hmacs) <= 4'))).toBe(true);
    expect(generationConstraints.rows.some(({ definition }) =>
      definition.includes('jsonb_array_length(tool_executions) <= 8'))).toBe(true);
    expect(generationConstraints.rows.some(({ definition }) =>
      definition.includes('UNIQUE (quota_date, quota_slot)'))).toBe(true);

    const judgmentColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'addie_shadow_replay_judgments'`,
    );
    expect(judgmentColumns.rows.map(({ column_name }) => column_name)).toEqual(
      expect.arrayContaining([
        'trace_id',
        'status',
        'reason',
        'judgment_policy_version',
        'evaluation_valid',
        'evaluation_skipped',
        'knowledge_gap',
        'gap_severity',
        'shadow_quality',
        'deterministic_failure_labels',
        'shape_word_count',
        'shape_expected_max_words',
        'shape_ratio_to_expected',
        'judge_provider',
        'judge_model',
        'self_judged',
        'judge_prompt_version',
        'judge_prompt_hmac',
        'judge_request_hmac',
        'judge_response_hmac',
        'question_hmac',
        'source_output_hmac',
        'human_evidence_content_hmac',
        'input_tokens',
        'output_tokens',
        'started_at',
        'completed_at',
        'retained_until',
      ]),
    );
    expect(judgmentColumns.rows.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining(['question', 'human_response', 'generated_output']),
    );
    const judgmentConstraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'addie_shadow_replay_judgments'::regclass`,
    );
    expect(judgmentConstraints.rows.some(({ definition }) =>
      definition.includes('self_judged = false'))).toBe(true);
    expect(judgmentConstraints.rows.some(({ definition }) =>
      definition.includes('array_to_string(deterministic_failure_labels'))).toBe(true);
  });

  it('categorically closes existing pending v2 traces instead of upgrading them', async () => {
    await pool.query('DELETE FROM addie_threads WHERE external_id = $1', [V2_EXTERNAL_ID]);
    const config = await pool.query<{ version_id: number }>(
      `INSERT INTO addie_config_versions (
         config_hash, active_rule_ids, rules_snapshot, router_rules_hash
       ) VALUES ($1, '{}', '{}'::jsonb, $2)
       ON CONFLICT (config_hash) DO UPDATE SET router_rules_hash = EXCLUDED.router_rules_hash
       RETURNING version_id`,
      [QUOTA_CONFIG_HASH, 'f'.repeat(64)],
    );
    const thread = await pool.query<{ thread_id: string }>(
      `INSERT INTO addie_threads (channel, external_id, user_type, user_id)
       VALUES ('slack', $1, 'slack', 'U_SYNTHETIC')
       RETURNING thread_id`,
      [V2_EXTERNAL_ID],
    );
    const message = await pool.query<{ message_id: string }>(
      `INSERT INTO addie_thread_messages (
         thread_id, role, content, config_version_id, sequence_number
       ) VALUES ($1, 'user', 'synthetic v2 question', $2, 1)
       RETURNING message_id`,
      [thread.rows[0].thread_id, config.rows[0].version_id],
    );
    const trace = await pool.query<{ trace_id: string }>(
      `INSERT INTO addie_shadow_replay_traces (
         trace_id, capture_version, thread_id, source_question_message_id,
         source_slack_message_ts, source_config_version_id, hash_key_version,
         policy_version, capture_salt, effective_model, si_retrieval_present,
         provider_web_search_enabled, message_count, question_hmac,
         source_binding_hmac, member_context_hmac, channel_context_hmac,
         plan_hmac, si_retrieval_hmac, request_context_hmac, docs_corpus_hmac,
         system_block_hmacs, tool_schema_hmacs, authorization_hmac,
         expires_at, retained_until, capability_profile,
         capability_policy_version, approved_tool_names,
         message_payload_hmacs, provider_request_hmac
       ) VALUES (
         gen_random_uuid(), 2, $1, $2, '1000.0002', $3, 'test-v1', 'read-only-v1',
         $4, 'claude-example-chat', FALSE, FALSE, 1, $5, $5, $5, $5, $5,
         $5, $5, $5, '[]'::jsonb, '[]'::jsonb, $5,
         NOW() + INTERVAL '1 hour', NOW() + INTERVAL '7 days',
         'official_docs_v1', 'official-docs-policy:v1',
         '["search_docs","get_doc"]'::jsonb,
         '[{"index":0,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
         $5
       ) RETURNING trace_id`,
      [
        thread.rows[0].thread_id,
        message.rows[0].message_id,
        config.rows[0].version_id,
        '1'.repeat(32),
        'b'.repeat(64),
      ],
    );
    await pool.query(
      `UPDATE addie_threads
       SET context = jsonb_build_object(
         'shadow_eval_trace_id', $2::text,
         'shadow_eval_status', 'pending'
       )
       WHERE thread_id = $1`,
      [thread.rows[0].thread_id, trace.rows[0].trace_id],
    );

    await pool.query(MIGRATION_556_SQL);
    const closed = await pool.query<{
      capture_status: string;
      capture_reason: string;
      context: Record<string, unknown>;
    }>(
      `SELECT trace.capture_status, trace.capture_reason, thread.context
       FROM addie_shadow_replay_traces trace
       JOIN addie_threads thread ON thread.thread_id = trace.thread_id
       WHERE trace.trace_id = $1`,
      [trace.rows[0].trace_id],
    );
    expect(closed.rows[0]).toMatchObject({
      capture_status: 'skipped',
      capture_reason: 'trace_capture_version_superseded',
      context: {
        shadow_eval_status: 'skipped',
        shadow_eval_replay_error: 'trace_capture_version_superseded',
        shadow_eval_capture_parity_verified: false,
      },
    });
    expect(JSON.stringify(closed.rows[0])).not.toContain('synthetic v2 question');
  });

  it('serializes two concurrent claims at a daily limit of one', async () => {
    await pool.query('DELETE FROM addie_threads WHERE external_id = ANY($1)', [
      [...QUOTA_EXTERNAL_IDS],
    ]);
    const config = await pool.query<{ version_id: number }>(
      `INSERT INTO addie_config_versions (
         config_hash, active_rule_ids, rules_snapshot, router_rules_hash
       ) VALUES ($1, '{}', '{}'::jsonb, $2)
       ON CONFLICT (config_hash) DO UPDATE SET router_rules_hash = EXCLUDED.router_rules_hash
       RETURNING version_id`,
      [QUOTA_CONFIG_HASH, 'f'.repeat(64)],
    );
    const traces = [] as Array<{ traceId: string; threadId: string }>;
    for (const [index, externalId] of QUOTA_EXTERNAL_IDS.entries()) {
      const thread = await pool.query<{ thread_id: string }>(
        `INSERT INTO addie_threads (channel, external_id, user_type, user_id)
         VALUES ('slack', $1, 'slack', 'U_SYNTHETIC')
         RETURNING thread_id`,
        [externalId],
      );
      const message = await pool.query<{ message_id: string }>(
        `INSERT INTO addie_thread_messages (
           thread_id, role, content, config_version_id, sequence_number
         )
         VALUES ($1, 'user', 'synthetic quota question', $2, 1)
         RETURNING message_id`,
        [thread.rows[0].thread_id, config.rows[0].version_id],
      );
      const trace = await pool.query<{ trace_id: string }>(
        `INSERT INTO addie_shadow_replay_traces (
           trace_id, capture_version, thread_id, source_question_message_id,
           source_slack_message_ts, source_config_version_id, hash_key_version,
           policy_version, capture_salt, effective_model, si_retrieval_present,
           provider_web_search_enabled, message_count, question_hmac,
           source_binding_hmac, member_context_hmac, channel_context_hmac,
           plan_hmac, si_retrieval_hmac, request_context_hmac, docs_corpus_hmac,
           system_block_hmacs, tool_schema_hmacs, authorization_hmac,
           expires_at, retained_until, capability_profile,
           capability_policy_version, approved_tool_names,
           message_payload_hmacs, provider_request_hmac
         ) VALUES (
           gen_random_uuid(), 3, $1, $2, $3, $4, 'test-v1', 'read-only-v1',
           $5, 'claude-example-chat', FALSE, FALSE, 1, $6, $6, $6, $6, $6,
           $6, $6, $6, '[]'::jsonb, '[]'::jsonb, $6,
           NOW() + INTERVAL '1 hour', NOW() + INTERVAL '7 days',
           'official_docs_v1', 'official-docs-policy:v1',
           '["search_docs","get_doc"]'::jsonb,
           '[{"index":0,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
           $7
         ) RETURNING trace_id`,
        [
          thread.rows[0].thread_id,
          message.rows[0].message_id,
          `1000.${index + 10}`,
          config.rows[0].version_id,
          String(index + 1).repeat(32),
          'b'.repeat(64),
          String(index + 3).repeat(64),
        ],
      );
      traces.push({ traceId: trace.rows[0].trace_id, threadId: thread.rows[0].thread_id });
    }

    const now = new Date();
    let ready = 0;
    let release!: () => void;
    const startBarrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
    const concurrentQuery = async (text: string, params?: unknown[]) => {
      ready++;
      if (ready === traces.length) release();
      await startBarrier;
      return pool.query(text, params);
    };
    const decisions = await Promise.all(traces.map((trace, index) =>
      claimShadowReplayGeneration({
        ...trace,
        expected: {
          effective_model: 'claude-example-chat',
          provider_request_hmac: String(index + 3).repeat(64),
        },
      } as never, 1, { query: concurrentQuery as never, now })));

    expect(decisions.sort()).toEqual(['claimed', 'daily_limit_reached']);

    await pool.query(
      'DELETE FROM addie_shadow_replay_generations WHERE trace_id = ANY($1)',
      [traces.map(({ traceId }) => traceId)],
    );
    let sameTraceReady = 0;
    let releaseSameTrace!: () => void;
    const sameTraceBarrier = new Promise<void>((resolveBarrier) => {
      releaseSameTrace = resolveBarrier;
    });
    const sameTraceQuery = async (text: string, params?: unknown[]) => {
      // Only synchronize the initial INSERT statements; the conflict loser
      // must then execute its fresh-snapshot existence recheck independently.
      if (text.includes('WITH eligible AS MATERIALIZED')) {
        sameTraceReady++;
        if (sameTraceReady === 2) releaseSameTrace();
        await sameTraceBarrier;
      }
      return pool.query(text, params);
    };
    const sameTrace = traces[0];
    const sameTraceAuthorization = {
      ...sameTrace,
      expected: {
        effective_model: 'claude-example-chat',
        provider_request_hmac: '3'.repeat(64),
      },
    } as never;
    const sameTraceDecisions = await Promise.all([
      claimShadowReplayGeneration(sameTraceAuthorization, 1, {
        query: sameTraceQuery as never,
        now,
      }),
      claimShadowReplayGeneration(sameTraceAuthorization, 1, {
        query: sameTraceQuery as never,
        now,
      }),
    ]);
    expect(sameTraceDecisions.sort()).toEqual(['already_claimed', 'claimed']);
    const traceStatus = await pool.query<{ capture_status: string }>(
      'SELECT capture_status FROM addie_shadow_replay_traces WHERE trace_id = $1',
      [sameTrace.traceId],
    );
    expect(traceStatus.rows[0].capture_status).toBe('pending');
  });
});
