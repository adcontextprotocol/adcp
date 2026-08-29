import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  ROUTER_CANARY_RESERVED_COST_MICROS,
  admitRouterCanary,
  recordRouterCanaryOutcome,
} from '../../src/addie/router-canary.js';
import { FIXED_TRACE_ROLLOUT_POLICY_VERSION } from '../../src/addie/eval/fixed-trace-rollout.js';
import { ROUTER_SHADOW_PROMOTION_POLICY_VERSION } from '../../src/addie/router-shadow.js';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const CHANNEL_ID = 'C0123456789';
const KEY_VERSION = 'router-canary-integration-v1';

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    ADDIE_ROUTER_LUNA_CANARY_ENABLED: 'true',
    ADDIE_ROUTER_LUNA_CANARY_PRODUCTION_DATA_APPROVED: 'true',
    ADDIE_ROUTER_LUNA_CANARY_FIXED_TRACE_POLICY_VERSION:
      FIXED_TRACE_ROLLOUT_POLICY_VERSION,
    ADDIE_ROUTER_LUNA_CANARY_SHADOW_PROMOTION_POLICY_VERSION:
      ROUTER_SHADOW_PROMOTION_POLICY_VERSION,
    ADDIE_ROUTER_LUNA_CANARY_CHANNEL_IDS: CHANNEL_ID,
    ADDIE_ROUTER_LUNA_CANARY_SAMPLE_BPS: '10000',
    ADDIE_ROUTER_LUNA_CANARY_DAILY_LIMIT: '10',
    ADDIE_ROUTER_LUNA_CANARY_DAILY_BUDGET_MICROS: String(
      ROUTER_CANARY_RESERVED_COST_MICROS * 10,
    ),
    ADDIE_ROUTER_LUNA_CANARY_DEADLINE_MS: '10000',
    ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY: 'integration-canary-key'.padEnd(32, 'x'),
    ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY_VERSION: KEY_VERSION,
    OPENAI_API_KEY: 'unused',
    ...overrides,
  };
}

function cohort(opportunityId: string) {
  return {
    channelId: CHANNEL_ID,
    opportunityId,
    channelIsPublic: true,
    channelIsShared: false,
  };
}

describe('migration 566: Luna router canary ledger', () => {
  let pool: Pool;
  let migrationReady = false;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL
        || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    migrationReady = true;
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM addie_router_canary_daily_metrics WHERE hash_key_version = $1',
      [KEY_VERSION],
    );
    await pool.query(
      'DELETE FROM addie_router_canary_state WHERE hash_key_version = $1',
      [KEY_VERSION],
    );
  });

  afterAll(async () => {
    if (pool && migrationReady) {
      await pool.query(
        'DELETE FROM addie_router_canary_daily_metrics WHERE hash_key_version = $1',
        [KEY_VERSION],
      );
      await pool.query(
        'DELETE FROM addie_router_canary_state WHERE hash_key_version = $1',
        [KEY_VERSION],
      );
    }
    await closeDatabase();
  });

  it('contains only aggregate rollout state and metrics columns', async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('addie_router_canary_state', 'addie_router_canary_daily_metrics')`,
    );
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).toEqual(expect.arrayContaining([
      'sampled_count', 'admitted_count', 'completed_count', 'rolled_back_at',
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      'channel_id', 'thread_id', 'message_id', 'user_id', 'opportunity_id',
      'source_binding_hmac', 'prompt', 'response',
    ]));
  });

  it('atomically enforces the daily admission cap without source persistence', async () => {
    const limited = environment({
      ADDIE_ROUTER_LUNA_CANARY_DAILY_LIMIT: '1',
      ADDIE_ROUTER_LUNA_CANARY_DAILY_BUDGET_MICROS: String(
        ROUTER_CANARY_RESERVED_COST_MICROS,
      ),
    });
    const results = await Promise.all([
      admitRouterCanary(cohort('1.000001'), { env: limited }),
      admitRouterCanary(cohort('1.000002'), { env: limited }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'admitted', 'not_admitted',
    ]);
    expect(results.find((result) => result.status === 'not_admitted')).toEqual({
      status: 'not_admitted', reason: 'daily_limit_reached',
    });
  });

  it('latches rollback after the bounded failure-rate threshold', async () => {
    for (let index = 0; index < 5; index++) {
      const admitted = await admitRouterCanary(cohort(`2.00000${index}`), {
        env: environment(),
      });
      expect(admitted.status).toBe('admitted');
      if (admitted.status !== 'admitted') throw new Error('expected admission');
      const failed = index >= 3;
      const recorded = await recordRouterCanaryOutcome(admitted, failed ? {
        status: 'fallback_succeeded',
        failureReason: 'provider_error',
        candidateLatencyMs: 100,
        candidateCostMicros: 100,
        fallbackLatencyMs: 100,
      } : {
        status: 'candidate_succeeded',
        candidateLatencyMs: 100,
        candidateCostMicros: 100,
      });
      expect(recorded.recorded).toBe(true);
      expect(recorded.rolledBack).toBe(index === 4);
    }

    await expect(admitRouterCanary(cohort('2.000006'), {
      env: environment(),
    })).resolves.toEqual({ status: 'not_admitted', reason: 'rolled_back' });
    const state = await pool.query<{
      inflight_count: number;
      rollback_reason: string;
    }>(
      `SELECT inflight_count, rollback_reason
       FROM addie_router_canary_state WHERE hash_key_version = $1`,
      [KEY_VERSION],
    );
    expect(state.rows[0]).toEqual({
      inflight_count: 0,
      rollback_reason: 'failure_rate',
    });
  });
});
