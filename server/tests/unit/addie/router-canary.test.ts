import { describe, expect, it, vi } from 'vitest';
import { FIXED_TRACE_ROLLOUT_POLICY_VERSION } from '../../../src/addie/eval/fixed-trace-rollout.js';
import {
  ROUTER_CANARY_POLICY_VERSION,
  ROUTER_CANARY_PRICING_VERSION,
  ROUTER_CANARY_RESERVED_COST_MICROS,
  admitRouterCanary,
  recordRouterCanaryOutcome,
  selectRouterCanaryCohort,
  type RouterCanaryAdmission,
} from '../../../src/addie/router-canary.js';
import { ROUTER_SHADOW_PROMOTION_POLICY_VERSION } from '../../../src/addie/router-shadow.js';

const CHANNEL_ID = 'C0123456789';
const OPPORTUNITY_ID = '1724688000.000001';
const HMAC_KEY = 'canary-test-key'.padEnd(32, 'x');

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
    ADDIE_ROUTER_LUNA_CANARY_DAILY_LIMIT: '1',
    ADDIE_ROUTER_LUNA_CANARY_DAILY_BUDGET_MICROS: String(
      ROUTER_CANARY_RESERVED_COST_MICROS,
    ),
    ADDIE_ROUTER_LUNA_CANARY_DEADLINE_MS: '10000',
    ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY: HMAC_KEY,
    ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY_VERSION: 'test-v1',
    OPENAI_API_KEY: 'private-openai-key',
    ...overrides,
  };
}

const cohort = {
  channelId: CHANNEL_ID,
  opportunityId: OPPORTUNITY_ID,
  channelIsPublic: true,
  channelIsShared: false,
};

function admission(): RouterCanaryAdmission {
  return {
    status: 'admitted',
    admissionDate: '2026-08-29',
    deadlineMs: 10_000,
    policyVersion: ROUTER_CANARY_POLICY_VERSION,
    pricingVersion: ROUTER_CANARY_PRICING_VERSION,
    hashKeyVersion: 'test-v1',
    requestedModel: 'gpt-5.6-luna',
  };
}

describe('Luna router canary ledger', () => {
  it.each([
    [{ ADDIE_ROUTER_LUNA_CANARY_ENABLED: 'false' }, 'disabled'],
    [{ ADDIE_ROUTER_LUNA_CANARY_PRODUCTION_DATA_APPROVED: 'false' }, 'production_data_not_approved'],
    [{ ADDIE_ROUTER_LUNA_CANARY_FIXED_TRACE_POLICY_VERSION: 'stale' }, 'evidence_not_approved'],
    [{ ADDIE_ROUTER_LUNA_CANARY_SHADOW_PROMOTION_POLICY_VERSION: 'stale' }, 'evidence_not_approved'],
    [{ ADDIE_ROUTER_LUNA_CANARY_HMAC_KEY: 'short' }, 'invalid_configuration'],
    [{ ADDIE_ROUTER_LUNA_CANARY_DEADLINE_MS: '15001' }, 'invalid_configuration'],
    [{ ADDIE_ROUTER_LUNA_CANARY_CHANNEL_IDS: 'COTHER00000' }, 'channel_not_allowlisted'],
    [{ OPENAI_API_KEY: undefined }, 'invalid_configuration'],
  ])('fails closed for %s', (override, reason) => {
    expect(selectRouterCanaryCohort(cohort, environment(override))).toEqual({
      selected: false,
      reason,
    });
  });

  it('rejects private and shared channels before sampling', () => {
    expect(selectRouterCanaryCohort({
      ...cohort,
      channelIsPublic: false,
    }, environment()).reason).toBe('private_channel');
    expect(selectRouterCanaryCohort({
      ...cohort,
      channelIsShared: true,
    }, environment()).reason).toBe('shared_channel');
  });

  it('samples deterministically without exposing configuration secrets', () => {
    const sparse = environment({ ADDIE_ROUTER_LUNA_CANARY_SAMPLE_BPS: '5000' });
    const first = selectRouterCanaryCohort(cohort, sparse);
    expect(selectRouterCanaryCohort(cohort, sparse)).toEqual(first);
    expect(['selected', 'sample_excluded']).toContain(first.reason);
    expect(first).not.toHaveProperty('config');
  });

  it('admits atomically without passing production identity or secrets to SQL', async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT admitted, reason, admission_date')) {
        return {
          rows: [{ admitted: true, reason: 'admitted', admission_date: '2026-08-29' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await admitRouterCanary(cohort, {
      env: environment(),
      query: runQuery,
      now: new Date('2026-08-29T12:00:00.000Z'),
    });

    expect(result).toEqual(admission());
    const persistedValues = runQuery.mock.calls.flatMap(([, params]) => params ?? []);
    expect(persistedValues).not.toContain(CHANNEL_ID);
    expect(persistedValues).not.toContain(OPPORTUNITY_ID);
    expect(persistedValues).not.toContain(HMAC_KEY);
    expect(persistedValues).not.toContain('private-openai-key');
  });

  it.each([
    [{ admitted: false, reason: 'daily_limit_reached', admission_date: '2026-08-29' }, 'daily_limit_reached'],
    [{ admitted: false, reason: 'rolled_back', admission_date: '2026-08-29' }, 'rolled_back'],
    [{ admitted: false, reason: 'invalid_configuration', admission_date: '2026-08-29' }, 'invalid_configuration'],
  ] as const)('reports a rejected database admission as %s', async (row, reason) => {
    const runQuery = vi.fn(async (sql: string) => ({
      rows: sql.includes('SELECT admitted, reason, admission_date') ? [row] : [],
      rowCount: 1,
    }));
    await expect(admitRouterCanary(cohort, {
      env: environment(), query: runQuery,
    })).resolves.toEqual({ status: 'not_admitted', reason });
  });

  it('falls back without dispatch when the ledger is unavailable', async () => {
    await expect(admitRouterCanary(cohort, {
      env: environment(),
      query: vi.fn().mockRejectedValue(new Error('database unavailable')),
    })).resolves.toEqual({ status: 'not_admitted', reason: 'ledger_unavailable' });
  });

  it('records one aggregate outcome and returns the latched rollback state', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      rows: [{ rolled_back: true, rollback_reason: 'failure_rate' }],
      rowCount: 1,
    });
    await expect(recordRouterCanaryOutcome(admission(), {
      status: 'fallback_succeeded',
      failureReason: 'timeout',
      candidateLatencyMs: 10_000,
      candidateCostMicros: 200,
      fallbackLatencyMs: 500,
    }, {
      query: runQuery,
      now: new Date('2026-08-29T12:00:10.000Z'),
    })).resolves.toEqual({
      recorded: true,
      rolledBack: true,
      rollbackReason: 'failure_rate',
    });
    const params = runQuery.mock.calls[0][1];
    expect(params).toEqual(expect.arrayContaining([
      'fallback_succeeded', 'timeout', 10_000, 200, 500,
    ]));
    expect(params).not.toEqual(expect.arrayContaining([CHANNEL_ID, OPPORTUNITY_ID, HMAC_KEY]));
  });

  it('rejects internally inconsistent terminal outcomes', async () => {
    await expect(recordRouterCanaryOutcome(admission(), {
      status: 'candidate_succeeded',
      failureReason: 'provider_error',
      candidateLatencyMs: 1,
      candidateCostMicros: 1,
    })).rejects.toThrow('Invalid router canary outcome');
  });
});
