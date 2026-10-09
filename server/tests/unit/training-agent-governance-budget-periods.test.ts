/**
 * adcp#7956: budget periods on campaign governance plans. The sandbox
 * governance agent derives the period that contains a dated action's whole
 * flight, denies straddling / over-period / unallocated actions, echoes the
 * matched `budget_period_id`, and rejects a re-sync that strands a commitment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Initialize the aggregate tool catalog before importing a leaf handler.
import '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleReportPlanOutcome,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { GovernanceAdjustmentState, GovernanceOutcomeState, TrainingContext } from '../../src/training-agent/types.js';
import {
  buildBuyCommitments,
  matchBudgetPeriod,
  mergeStatedFlight,
  resolveActionFlight,
} from '../../src/training-agent/governance-budget-periods.js';

const BUYER = 'https://buyer.example';
const SELLER = 'https://seller.example/mcp';
const BUYER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: BUYER };
const SELLER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: SELLER };
const PLAN_ID = 'nova-spring-2027';

const Q1 = { budget_period_id: 'q1', start: '2027-01-01T00:00:00Z', end: '2027-04-01T00:00:00Z', amount: 60_000 };
const Q2 = { budget_period_id: 'q2', start: '2027-04-01T00:00:00Z', end: '2027-07-01T00:00:00Z', amount: 40_000 };

type Result = Record<string, any>;

function plan(periods: unknown = [Q1, Q2], overrides: Record<string, unknown> = {}) {
  return {
    plan_id: PLAN_ID,
    brand: { domain: 'nova-brands.example' },
    objectives: 'Spring launch split across two quarters.',
    budget: {
      total: 100_000,
      currency: 'USD',
      reallocation_unlimited: true,
      ...(periods === null ? {} : { periods }),
    },
    flight: { start: '2027-01-01T00:00:00Z', end: '2027-07-01T00:00:00Z' },
    countries: ['US'],
    ...overrides,
  };
}

const sync = (p: unknown) => handleSyncPlans({ plans: [p] }, BUYER_CTX) as Promise<Result>;

async function syncOk(p: unknown = plan()) {
  const result = await sync(p);
  expect(result.errors, JSON.stringify(result)).toBeUndefined();
  return result;
}

function intent(
  amount: number,
  flight: { start_time?: string; end_time?: string } | undefined,
  extra: Record<string, unknown> = {},
  payloadExtra: Record<string, unknown> = {},
) {
  return handleCheckGovernance({
    plan_id: PLAN_ID,
    caller: BUYER,
    target_agent: SELLER,
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    proposed_commitment: { amount, currency: 'USD' },
    payload: {
      total_budget: { amount, currency: 'USD' },
      ...(flight ?? {}),
      ...payloadExtra,
    },
    ...extra,
  }, BUYER_CTX) as Promise<Result>;
}

let reportSeq = 0;
async function settle(approved: Result, sellerReference: string) {
  expect(approved.verdict, JSON.stringify(approved)).toBe('approved');
  const reported = await handleReportPlanOutcome({
    plan_id: PLAN_ID,
    check_id: approved.check_id,
    governance_context: approved.governance_context,
    idempotency_key: `settle_${sellerReference}_${reportSeq++}_padding`,
    outcome: 'completed',
    seller_response: { seller_reference: sellerReference },
  }, BUYER_CTX) as Result;
  expect(reported.errors, JSON.stringify(reported)).toBeUndefined();
}

/** Intent that must be approved, then settled onto the ledger under `ref`. */
async function commit(ref: string, amount: number, start: string, end: string) {
  const approved = await intent(amount, { start_time: start, end_time: end });
  await settle(approved, ref);
  return approved;
}

function modification(
  ref: string,
  delta: number,
  flight: { start_time?: string; end_time?: string },
  extra: Record<string, unknown> = {},
) {
  return handleCheckGovernance({
    plan_id: PLAN_ID,
    caller: BUYER,
    target_agent: SELLER,
    tool: 'update_media_buy',
    purchase_type: 'media_buy',
    proposed_commitment: { amount: delta, currency: 'USD' },
    payload: { media_buy_id: ref, ...flight },
    ...extra,
  }, BUYER_CTX) as Promise<Result>;
}

const run = (fn: () => Promise<void>) => runWithSessionContext(fn);
const findingText = (result: Result) => (result.findings ?? []).map((f: Result) => f.explanation).join(' | ');

describe('sync_plans budget.periods validation', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('accepts adjacent periods that share a boundary and reports the period category', () => run(async () => {
    const result = await syncOk();
    expect(result.plans[0].categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ category_id: 'budget_period' }),
    ]));
  }));

  it('accepts a plan with periods that sum below the total (unallocated remainder)', () => run(async () => {
    await syncOk(plan([{ ...Q1, amount: 30_000 }, { ...Q2, amount: 20_000 }]));
  }));

  it('does not report the period category for a plan without periods', () => run(async () => {
    const result = await syncOk(plan(null));
    expect(result.plans[0].categories.map((c: Result) => c.category_id)).not.toContain('budget_period');
  }));

  it.each([
    ['a calendar-invalid date', [Q1, { ...Q2, start: '2027-02-30T00:00:00Z' }], 'ISO 8601'],
    ['hour 24', [Q1, { ...Q2, end: '2027-07-01T24:00:00Z' }], 'ISO 8601'],
    ['duplicate ids', [Q1, { ...Q2, budget_period_id: 'q1' }], 'not unique'],
    ['overlapping windows', [Q1, { ...Q2, start: '2027-03-31T00:00:00Z' }], 'overlap'],
    ['a period outside the flight', [Q1, { ...Q2, end: '2027-07-02T00:00:00Z' }], 'inside the plan flight'],
    ['amounts above the total', [Q1, { ...Q2, amount: 40_001 }], 'above budget.total'],
    ['end not after start', [Q1, { ...Q2, end: Q2.start }], 'later than start'],
    ['a negative amount', [Q1, { ...Q2, amount: -1 }], 'amount'],
    ['an unsafe id', [Q1, { ...Q2, budget_period_id: 'q 2' }], 'budget_period_id'],
    ['an empty array', [], 'non-empty'],
    ['an unsupported property', [Q1, { ...Q2, label: 'Q2' }], 'unsupported property'],
    ['a non-date-time start', [Q1, { ...Q2, start: 'tomorrow' }], 'ISO 8601'],
  ])('rejects %s with INVALID_REQUEST and a field', (_name, periods, fragment) => run(async () => {
    const result = await sync(plan(periods));
    expect(result.errors?.[0]).toMatchObject({ code: 'INVALID_REQUEST', field: expect.stringContaining('budget.periods') });
    expect(result.errors[0].message).toContain(fragment);
  }));

  it('rejects more than 366 periods', () => run(async () => {
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse('2027-01-01T00:00:00Z');
    const many = Array.from({ length: 367 }, (_, i) => ({
      budget_period_id: `d${i}`,
      start: new Date(start + i * day).toISOString(),
      end: new Date(start + (i + 1) * day).toISOString(),
      amount: 1,
    }));
    const result = await sync(plan(many, { flight: { start: '2027-01-01T00:00:00Z', end: '2028-01-02T00:00:00Z' } }));
    expect(result.errors?.[0]).toMatchObject({ code: 'INVALID_REQUEST' });
  }));

  it('does not write an earlier plan when a later plan in the same sync is rejected', () => run(async () => {
    const bad = { ...plan([Q1, { ...Q2, budget_period_id: 'q1' }]), plan_id: 'second-plan' };
    const result = await handleSyncPlans({ plans: [{ ...plan(), plan_id: 'first-plan' }, bad] }, BUYER_CTX) as Result;
    expect(result.errors?.[0]?.field).toContain('plans[1]');
    const check = await handleCheckGovernance({
      plan_id: 'first-plan', caller: BUYER, target_agent: SELLER, tool: 'create_media_buy', purchase_type: 'media_buy',
      proposed_commitment: { amount: 1, currency: 'USD' }, payload: { total_budget: { amount: 1, currency: 'USD' } },
    }, BUYER_CTX) as Result;
    expect(check.errors?.[0]?.code ?? check.findings?.[0]?.category_id).toBeDefined();
    expect(check.verdict).not.toBe('approved');
  }));
});

describe('check_governance with budget periods', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('approves a buy inside a period and returns the matched period', () => run(async () => {
    await syncOk();
    const result = await intent(10_000, { start_time: '2027-01-15T00:00:00Z', end_time: '2027-03-15T00:00:00Z' });
    expect(result.verdict, JSON.stringify(result)).toBe('approved');
    expect(result.budget_period_id).toBe('q1');
    expect(result.categories_evaluated).toContain('budget_period');
  }));

  it('lets a buy end exactly on the boundary stay in the earlier period', () => run(async () => {
    await syncOk();
    const result = await intent(10_000, { start_time: '2027-03-01T00:00:00Z', end_time: '2027-04-01T00:00:00Z' });
    expect(result.verdict).toBe('approved');
    expect(result.budget_period_id).toBe('q1');
  }));

  it('assigns a buy that starts on the boundary to the later period', () => run(async () => {
    await syncOk();
    const result = await intent(10_000, { start_time: '2027-04-01T00:00:00Z', end_time: '2027-05-01T00:00:00Z' });
    expect(result.verdict).toBe('approved');
    expect(result.budget_period_id).toBe('q2');
  }));

  it('denies a flight that straddles a boundary', () => run(async () => {
    await syncOk();
    const result = await intent(10_000, { start_time: '2027-03-15T00:00:00Z', end_time: '2027-04-15T00:00:00Z' });
    expect(result.verdict).toBe('denied');
    expect(result.governance_context).toBeUndefined();
    expect(result.budget_period_id).toBeUndefined();
    expect(findingText(result)).toContain('straddles budget periods q1 and q2');
  }));

  it('denies a dated flight that sits in the unallocated remainder', () => run(async () => {
    await syncOk(plan([{ ...Q1, amount: 30_000 }, { ...Q2, end: '2027-05-01T00:00:00Z', amount: 20_000 }]));
    const result = await intent(1_000, { start_time: '2027-05-10T00:00:00Z', end_time: '2027-06-10T00:00:00Z' });
    expect(result.verdict).toBe('denied');
    expect(findingText(result)).toContain('not inside any single budget period');
  }));

  it('denies a buy that exceeds its period while the plan total has room', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 50_000, '2027-01-10T00:00:00Z', '2027-03-10T00:00:00Z');
    // $20k fits the plan total ($50k remaining) but not Q1's last $10k.
    const result = await intent(20_000, { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' });
    expect(result.verdict).toBe('denied');
    expect(result.budget_period_id).toBe('q1');
    expect(result.governance_context).toBeUndefined();
    expect(findingText(result)).toContain('period q1');
    // The same amount fits Q2, so the denial is the period and not the total.
    const q2 = await intent(20_000, { start_time: '2027-05-01T00:00:00Z', end_time: '2027-06-01T00:00:00Z' });
    expect(q2.verdict).toBe('approved');
    expect(q2.budget_period_id).toBe('q2');
  }));

  it('allows a commitment that exactly fills its period', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 50_000, '2027-01-10T00:00:00Z', '2027-03-10T00:00:00Z');
    const result = await intent(10_000, { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' });
    expect(result.verdict).toBe('approved');
  }));

  it('still enforces the plan total inside a period', () => run(async () => {
    await syncOk(plan([{ ...Q1, amount: 100_000 }], { flight: { start: '2027-01-01T00:00:00Z', end: '2027-07-01T00:00:00Z' } }));
    const result = await intent(100_001, { start_time: '2027-01-10T00:00:00Z', end_time: '2027-03-10T00:00:00Z' });
    expect(result.verdict).toBe('denied');
  }));

  it('counts an undated commitment against the total only', () => run(async () => {
    await syncOk();
    const undated = await intent(70_000, undefined);
    expect(undated.verdict, JSON.stringify(undated)).toBe('approved');
    expect(undated.budget_period_id).toBeUndefined();
    await settle(undated, 'mb_undated');
    // The undated $70k does not consume Q1, but it does use plan total.
    const q1 = await intent(30_000, { start_time: '2027-01-10T00:00:00Z', end_time: '2027-03-10T00:00:00Z' });
    expect(q1.verdict).toBe('approved');
    await settle(q1, 'mb_q1_dated');
    // $70k undated + $30k in Q1 leaves $0 of the plan total; one more dollar is over it.
    const over = await intent(1, { start_time: '2027-01-10T00:00:00Z', end_time: '2027-03-10T00:00:00Z' });
    expect(over.verdict).not.toBe('approved');
  }));

  it('denies an action whose flight cannot be parsed instead of skipping periods', () => run(async () => {
    await syncOk();
    const result = await intent(1_000, { start_time: '2027-02-01T00:00:00Z', end_time: 'next week' });
    expect(result.verdict).toBe('denied');
    expect(findingText(result)).toContain('cannot be placed in a budget period');
  }));

  it('resolves an asap start at the evaluation time', () => run(async () => {
    const evergreen = { budget_period_id: 'evergreen', start: '2020-01-01T00:00:00Z', end: '2099-01-01T00:00:00Z', amount: 50_000 };
    await syncOk(plan([evergreen], { flight: { start: '2020-01-01T00:00:00Z', end: '2099-01-01T00:00:00Z' } }));
    const result = await intent(1_000, { start_time: 'asap', end_time: '2098-12-01T00:00:00Z' });
    expect(result.verdict, JSON.stringify(result)).toBe('approved');
    expect(result.budget_period_id).toBe('evergreen');
  }));

  describe('budget_period_id assertion', () => {
    it('approves when the assertion matches the derived period', () => run(async () => {
      await syncOk();
      const result = await intent(
        10_000,
        { start_time: '2027-01-15T00:00:00Z', end_time: '2027-03-15T00:00:00Z' },
        { budget_period_id: 'q1' },
      );
      expect(result.verdict).toBe('approved');
      expect(result.budget_period_id).toBe('q1');
    }));

    it('denies a mismatched assertion and reports the derived period', () => run(async () => {
      await syncOk();
      const result = await intent(
        10_000,
        { start_time: '2027-01-15T00:00:00Z', end_time: '2027-03-15T00:00:00Z' },
        { budget_period_id: 'q2' },
      );
      expect(result.verdict).toBe('denied');
      expect(result.budget_period_id).toBe('q1');
      expect(result.governance_context).toBeUndefined();
      expect(result.findings[0].details).toMatchObject({ field: 'budget_period_id', expected: 'q1', actual: 'q2' });
    }));

    it('denies an assertion on a plan that has no periods', () => run(async () => {
      await syncOk(plan(null));
      const result = await intent(
        10_000,
        { start_time: '2027-01-15T00:00:00Z', end_time: '2027-03-15T00:00:00Z' },
        { budget_period_id: 'q1' },
      );
      expect(result.verdict).toBe('denied');
      expect(findingText(result)).toContain('no budget periods');
    }));

    it('denies an assertion on an undated action', () => run(async () => {
      await syncOk();
      const result = await intent(10_000, undefined, { budget_period_id: 'q1' });
      expect(result.verdict).toBe('denied');
      expect(findingText(result)).toContain('no flight dates');
    }));

    it('rejects a malformed assertion as VALIDATION_ERROR', () => run(async () => {
      await syncOk();
      const result = await intent(
        10_000,
        { start_time: '2027-01-15T00:00:00Z', end_time: '2027-03-15T00:00:00Z' },
        { budget_period_id: 'not valid!' },
      );
      expect(result.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR', field: 'budget_period_id' });
    }));
  });

  it('behaves exactly as before when the plan has no periods', () => run(async () => {
    await syncOk(plan(null));
    const result = await intent(10_000, { start_time: '2027-03-15T00:00:00Z', end_time: '2027-04-15T00:00:00Z' });
    expect(result.verdict).toBe('approved');
    expect(result.budget_period_id).toBeUndefined();
    expect(result.categories_evaluated).not.toContain('budget_period');
  }));

  describe('modifications', () => {
    it('checks a move to another period as moving the whole commitment', () => run(async () => {
      await syncOk();
      await commit('mb_move', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
      await commit('mb_q2_a', 10_000, '2027-04-10T00:00:00Z', '2027-05-10T00:00:00Z');
      // Q2 holds $10k. Moving the $30k buy in with a $5k increase needs $35k more: $45k > $40k.
      const denied = await modification('mb_move', 5_000, { start_time: '2027-04-20T00:00:00Z', end_time: '2027-05-20T00:00:00Z' });
      expect(denied.verdict).toBe('denied');
      expect(denied.budget_period_id).toBe('q2');
      // With a smaller increase it fits ($10k + $30k + $0 = $40k) and Q1 is freed.
      const moved = await modification('mb_move', 0, { start_time: '2027-04-20T00:00:00Z', end_time: '2027-05-20T00:00:00Z' });
      expect(moved.verdict, JSON.stringify(moved)).toBe('approved');
      expect(moved.budget_period_id).toBe('q2');
      await settle(moved, 'mb_move');
      const q1Again = await intent(60_000, { start_time: '2027-01-10T00:00:00Z', end_time: '2027-03-10T00:00:00Z' });
      expect(q1Again.verdict).toBe('approved');
    }));

    it('denies a modification that makes the flight straddle two periods', () => run(async () => {
      await syncOk();
      await commit('mb_extend', 10_000, '2027-02-01T00:00:00Z', '2027-03-15T00:00:00Z');
      const result = await modification('mb_extend', 1_000, { end_time: '2027-04-15T00:00:00Z' });
      expect(result.verdict).toBe('denied');
      expect(findingText(result)).toContain('straddles budget periods q1 and q2');
    }));

    it('derives the period from the buy on the ledger when the update carries no dates', () => run(async () => {
      await syncOk();
      await commit('mb_bump', 10_000, '2027-02-01T00:00:00Z', '2027-03-15T00:00:00Z');
      const result = await modification('mb_bump', 5_000, {});
      expect(result.verdict).toBe('approved');
      expect(result.budget_period_id).toBe('q1');
    }));

    it('denies a period overrun created by an in-period increase', () => run(async () => {
      await syncOk();
      await commit('mb_grow', 55_000, '2027-02-01T00:00:00Z', '2027-03-15T00:00:00Z');
      const result = await modification('mb_grow', 5_001, {});
      expect(result.verdict).toBe('denied');
      expect(result.budget_period_id).toBe('q1');
    }));
  });

  describe('execution checks', () => {
    async function approvedPurchaseIntent(flight = { start_time: '2027-01-15T00:00:00Z', end_time: '2027-03-15T00:00:00Z' }) {
      await syncOk();
      const approved = await intent(10_000, flight);
      expect(approved.verdict).toBe('approved');
      return approved;
    }

    const purchaseCheck = (context: string, plannedDelivery: Record<string, unknown>) => handleCheckGovernance({
      caller: SELLER,
      governance_context: context,
      phase: 'purchase',
      planned_delivery: { total_budget: 10_000, currency: 'USD', ...plannedDelivery },
    }, SELLER_CTX) as Promise<Result>;

    it('approves a planned flight inside the intent period and echoes it', () => run(async () => {
      const approved = await approvedPurchaseIntent();
      const result = await purchaseCheck(approved.governance_context, {
        start_time: '2027-01-15T00:00:00Z',
        end_time: '2027-03-15T00:00:00Z',
      });
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
      expect(result.check_type).toBe('execution');
      expect(result.budget_period_id).toBe('q1');
    }));

    it('falls back to the intent flight when the seller omits planned dates', () => run(async () => {
      const approved = await approvedPurchaseIntent();
      const result = await purchaseCheck(approved.governance_context, {});
      expect(result.verdict, JSON.stringify(result)).toBe('approved');
      expect(result.budget_period_id).toBe('q1');
    }));

    it('denies a planned flight that straddles a boundary', () => run(async () => {
      const approved = await approvedPurchaseIntent();
      const result = await purchaseCheck(approved.governance_context, {
        start_time: '2027-03-15T00:00:00Z',
        end_time: '2027-04-15T00:00:00Z',
      });
      expect(result.verdict).toBe('denied');
      expect(result.governance_context).toBeUndefined();
    }));

    it('denies a planned flight in a different period than the intent authorized', () => run(async () => {
      const approved = await approvedPurchaseIntent();
      const result = await purchaseCheck(approved.governance_context, {
        start_time: '2027-04-15T00:00:00Z',
        end_time: '2027-05-15T00:00:00Z',
      });
      expect(result.verdict).toBe('denied');
      expect(findingText(result)).toContain('intent was authorized for period q1');
    }));
  });

  describe('delivery checks', () => {
    it('derives the period and paces against it', () => run(async () => {
      await syncOk();
      const approved = await intent(10_000, { start_time: '2027-04-10T00:00:00Z', end_time: '2027-05-10T00:00:00Z' });
      const purchase = await handleCheckGovernance({
        caller: SELLER,
        governance_context: approved.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 10_000, currency: 'USD', start_time: '2027-04-10T00:00:00Z', end_time: '2027-05-10T00:00:00Z' },
      }, SELLER_CTX) as Result;
      expect(purchase.verdict).toBe('approved');
      const { computeDeliveryStatementDigest } = await import('../../src/training-agent/governance-payload-hash.js');
      const metrics: Record<string, unknown> = {
        statement_id: 'stmt_period_0001',
        sequence: 1,
        issued_at: '2027-04-20T00:00:00Z',
        reporting_period: { start: '2027-04-10T00:00:00Z', end: '2027-04-20T00:00:00Z' },
        cumulative_spend: 36_000,
        currency: 'USD',
      };
      metrics.statement_digest = computeDeliveryStatementDigest('mb_delivery', metrics);
      const delivery = await handleCheckGovernance({
        caller: SELLER,
        governance_context: purchase.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_delivery', start_time: '2027-04-10T00:00:00Z', end_time: '2027-05-10T00:00:00Z' },
        delivery_metrics: metrics,
      }, SELLER_CTX) as Result;
      // $36k is 36% of the $100k plan but 90% of Q2's $40k.
      expect(delivery.errors, JSON.stringify(delivery)).toBeUndefined();
      expect(delivery.budget_period_id).toBe('q2');
      expect(findingText(delivery)).toContain('budget period q2');
    }));
  });
});

describe('sync_plans re-sync with existing commitments', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('rejects an amount below what is already committed to the period', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    const result = await sync(plan([{ ...Q1, amount: 29_999 }, Q2]));
    expect(result.errors?.[0]).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'plans[0].budget.periods[0].amount',
    });
    expect(result.errors[0].message).toContain('below the $30000 already committed');
  }));

  it('accepts an amount equal to the committed amount to stop new spending', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    await syncOk(plan([{ ...Q1, amount: 30_000 }, Q2]));
    const blocked = await intent(1, { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' });
    expect(blocked.verdict).toBe('denied');
  }));

  it('rejects a sync that leaves a commitment outside every period', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    const result = await sync(plan([Q2]));
    expect(result.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(result.errors[0].message).toContain('outside every period');
  }));

  it('rejects a re-sync whose new boundary makes a committed flight straddle', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 30_000, '2027-02-01T00:00:00Z', '2027-03-25T00:00:00Z');
    const result = await sync(plan([
      { ...Q1, end: '2027-03-15T00:00:00Z' },
      { ...Q2, start: '2027-03-15T00:00:00Z' },
    ]));
    expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
  }));

  it('lets periods be added, extended, and have money moved between them', () => run(async () => {
    await syncOk(plan([{ ...Q1, amount: 30_000 }]));
    await commit('mb_q1_a', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    await syncOk(plan([{ ...Q1, amount: 45_000 }, { ...Q2, amount: 40_000 }]));
    await syncOk(plan([{ ...Q1, end: '2027-05-01T00:00:00Z', amount: 50_000 }, { ...Q2, start: '2027-05-01T00:00:00Z', amount: 30_000 }]));
  }));

  it('ignores undated commitments when re-syncing', () => run(async () => {
    await syncOk();
    const undated = await intent(70_000, undefined);
    await settle(undated, 'mb_undated');
    await syncOk(plan([{ ...Q1, amount: 10_000 }, { ...Q2, amount: 10_000 }]));
  }));

  it('lets a re-sync drop periods entirely, restoring total-only governance', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    await syncOk(plan(null));
    const result = await intent(10_000, { start_time: '2027-03-15T00:00:00Z', end_time: '2027-04-15T00:00:00Z' });
    expect(result.verdict).toBe('approved');
  }));

  it('does not mutate the plan when a re-sync is rejected', () => run(async () => {
    await syncOk();
    await commit('mb_q1_a', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    await sync(plan([{ ...Q1, amount: 1 }, Q2]));
    // The original Q1 limit is still in force.
    const result = await intent(30_000, { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' });
    expect(result.verdict).toBe('approved');
  }));
});

describe('flight spoofing and ledger coverage', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('cannot bypass periods with an empty flight object beside straddling top-level dates', () => run(async () => {
    await syncOk();
    const result = await intent(
      10_000,
      { start_time: '2027-03-15T00:00:00Z', end_time: '2027-04-15T00:00:00Z' },
      {},
      { flight: {} },
    );
    expect(result.verdict).toBe('denied');
    expect(findingText(result)).toContain('straddles budget periods q1 and q2');
  }));

  it('denies a payload whose flight object disagrees with its top-level dates', () => run(async () => {
    await syncOk();
    const result = await intent(
      10_000,
      { start_time: '2027-03-15T00:00:00Z', end_time: '2027-04-15T00:00:00Z' },
      {},
      { flight: { start: '2027-02-01T00:00:00Z', end: '2027-03-01T00:00:00Z' } },
    );
    expect(result.verdict).toBe('denied');
    expect(findingText(result)).toContain('conflicting flight');
  }));

  it('accepts the same flight stated in two places and in two notations', () => run(async () => {
    await syncOk();
    const result = await intent(
      10_000,
      { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' },
      {},
      { flight: { start: '2027-02-01T00:00:00+00:00', end: '2027-03-01T00:00:00Z' } },
    );
    expect(result.verdict).toBe('approved');
    expect(result.budget_period_id).toBe('q1');
  }));

  it('counts commitments made before periods existed against the first period that holds them', () => run(async () => {
    await syncOk(plan(null));
    await commit('mb_early', 90_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    const rejected = await sync(plan([{ ...Q1, amount: 10_000 }, { ...Q2, amount: 40_000 }]));
    expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
  }));

  it('lets periods be added to a plan with buys when every buy fits, and then enforces them', () => run(async () => {
    await syncOk(plan(null));
    await commit('mb_early', 50_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    await syncOk();
    const over = await intent(20_000, { start_time: '2027-02-01T00:00:00Z', end_time: '2027-03-01T00:00:00Z' });
    expect(over.verdict).toBe('denied');
    expect(over.budget_period_id).toBe('q1');
  }));

  it('does not leave a mode-downgraded violation on the ledger as a dated orphan', () => run(async () => {
    await syncOk(plan([Q1, Q2], { mode: 'advisory' }));
    const straddle = await intent(5_000, { start_time: '2027-03-15T00:00:00Z', end_time: '2027-04-15T00:00:00Z' });
    expect(straddle.verdict).toBe('approved');
    await settle(straddle, 'mb_straddle');
    await syncOk(plan([{ ...Q1, amount: 50_000 }, Q2], { mode: 'advisory' }));
  }));

  it('denies a dateless modification of a buy the ledger has never settled', () => run(async () => {
    await syncOk();
    const result = await modification('mb_unknown', 1_000, {});
    expect(result.verdict).toBe('denied');
    expect(findingText(result)).toContain('no settled commitment');
  }));

  it('joins a modification outcome to its buy by media_buy_id, not by seller_reference', () => run(async () => {
    await syncOk();
    await commit('mb_join', 30_000, '2027-01-15T00:00:00Z', '2027-03-15T00:00:00Z');
    const moved = await modification('mb_join', 0, { start_time: '2027-04-20T00:00:00Z', end_time: '2027-05-20T00:00:00Z' });
    expect(moved.verdict).toBe('approved');
    // The seller reports the modification with an unrelated reference.
    await settle(moved, 'rev_2_of_something_else');
    const q1Again = await intent(60_000, { start_time: '2027-01-10T00:00:00Z', end_time: '2027-03-10T00:00:00Z' });
    expect(q1Again.verdict).toBe('approved');
  }));

  it('paces delivery against the ledger period, ignoring dates the seller restates', () => run(async () => {
    await syncOk();
    const approved = await intent(10_000, { start_time: '2027-04-10T00:00:00Z', end_time: '2027-05-10T00:00:00Z' });
    const purchase = await handleCheckGovernance({
      caller: SELLER,
      governance_context: approved.governance_context,
      phase: 'purchase',
      planned_delivery: { media_buy_id: 'mb_ledger', total_budget: 10_000, currency: 'USD', start_time: '2027-04-10T00:00:00Z', end_time: '2027-05-10T00:00:00Z' },
    }, SELLER_CTX) as Result;
    await settle(approved, 'mb_ledger');
    const { computeDeliveryStatementDigest } = await import('../../src/training-agent/governance-payload-hash.js');
    const metrics: Record<string, unknown> = {
      statement_id: 'stmt_ledger_0001',
      sequence: 1,
      issued_at: '2027-04-20T00:00:00Z',
      reporting_period: { start: '2027-04-10T00:00:00Z', end: '2027-04-20T00:00:00Z' },
      cumulative_spend: 36_000,
      currency: 'USD',
    };
    metrics.statement_digest = computeDeliveryStatementDigest('mb_ledger', metrics);
    const delivery = await handleCheckGovernance({
      caller: SELLER,
      governance_context: purchase.governance_context,
      phase: 'delivery',
      // The seller restates unparseable dates; the ledger flight still places the buy in q2.
      planned_delivery: { media_buy_id: 'mb_ledger', start_time: 'whenever', end_time: 'sometime' },
      delivery_metrics: metrics,
    }, SELLER_CTX) as Result;
    expect(delivery.budget_period_id).toBe('q2');
    // $36k is 90% of q2's $40k: a warning against the period, not the 36% of the plan total.
    expect(findingText(delivery)).toContain('90.0% of budget period q2');
  }));
});

describe('budget period primitives', () => {
  const periods = [
    { budgetPeriodId: 'a', start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z', amount: 1 },
    { budgetPeriodId: 'b', start: '2027-02-01T00:00:00Z', end: '2027-03-01T00:00:00Z', amount: 1 },
  ];

  it('treats a zero-length flight on a boundary as belonging to the later period', () => {
    const match = matchBudgetPeriod(periods, { start: '2027-02-01T00:00:00Z', end: '2027-02-01T00:00:00Z' });
    expect(match).toMatchObject({ kind: 'contained', period: { budgetPeriodId: 'b' } });
  });

  it('reports a flight past the last period as unallocated and one touching two as straddling', () => {
    expect(matchBudgetPeriod(periods, { start: '2027-02-15T00:00:00Z', end: '2027-03-15T00:00:00Z' }).kind).toBe('unallocated');
    expect(matchBudgetPeriod(periods, { start: '2027-01-15T00:00:00Z', end: '2027-02-15T00:00:00Z' }).kind).toBe('straddles');
  });

  it('resolves asap at the evaluation time and completes a half-stated flight from the ledger', () => {
    const now = Date.parse('2027-01-10T00:00:00Z');
    expect(resolveActionFlight({ start: 'asap', end: '2027-01-20T00:00:00Z' }, undefined, now))
      .toEqual({ kind: 'dated', flight: { start: '2027-01-10T00:00:00.000Z', end: '2027-01-20T00:00:00Z' } });
    expect(resolveActionFlight({ end: '2027-01-25T00:00:00Z' }, { start: '2027-01-05T00:00:00Z', end: '2027-01-20T00:00:00Z' }, now))
      .toEqual({ kind: 'dated', flight: { start: '2027-01-05T00:00:00Z', end: '2027-01-25T00:00:00Z' } });
    expect(resolveActionFlight({ end: '2027-01-25T00:00:00Z' }, undefined, now).kind).toBe('invalid');
    expect(resolveActionFlight({}, undefined, now).kind).toBe('undated');
    expect(resolveActionFlight({ end: 'asap' }, undefined, now).kind).toBe('invalid');
  });

  it('flags conflicting flight statements and ignores agreeing ones', () => {
    expect(mergeStatedFlight([{ start: 'a' }, { start: 'b' }]).conflict).toContain('conflicting flight start');
    expect(mergeStatedFlight([{ start: '2027-01-01T00:00:00Z' }, { start: '2027-01-01T00:00:00+00:00' }]).conflict).toBeUndefined();
  });

  it('nets headroom-restoring adjustments and lets the latest flight win', () => {
    const outcome = (over: Partial<GovernanceOutcomeState>): GovernanceOutcomeState => ({
      outcomeId: 'o', planId: 'p', outcomeType: 'completed', committedBudget: 0, findings: [], timestamp: '2027-01-01T00:00:00.000Z', ...over,
    });
    const early = { start: '2027-01-05T00:00:00Z', end: '2027-01-20T00:00:00Z' };
    const late = { start: '2027-02-05T00:00:00Z', end: '2027-02-20T00:00:00Z' };
    const buys = buildBuyCommitments(
      [
        outcome({ outcomeId: 'o1', sellerReference: 'mb1', committedBudget: 100, flight: early, timestamp: '2027-01-01T00:00:00.000Z' }),
        outcome({ outcomeId: 'o2', sellerReference: 'unrelated', mediaBuyId: 'mb1', committedBudget: 20, flight: late, timestamp: '2027-01-02T00:00:00.000Z' }),
        outcome({ outcomeId: 'o3', outcomeType: 'failed', committedBudget: 999 }),
      ],
      [{ outcomeId: 'o1', headroomRestored: 30 } as GovernanceAdjustmentState],
    );
    expect(buys.get('mb1')).toEqual({ key: 'mb1', amount: 90, flight: late });
    expect(buys.size).toBe(1);
  });
});
