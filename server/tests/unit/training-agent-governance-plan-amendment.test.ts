/**
 * adcp#7758: media_buy_seller/governance_denied proves the seller's own
 * execution check by amending the plan between an approved intent and the
 * seller's purchase check. The sandbox governance agent must deny that check
 * whether or not the seller reports the optional planned_delivery.total_budget.
 */
import { afterEach, describe, expect, it } from 'vitest';
// Initialize the aggregate tool catalog before importing a leaf handler.
import '../../src/training-agent/task-handlers.js';
import { handleCheckGovernance, handleSyncPlans } from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const BUYER = 'https://buyer.example';
const SELLER = 'https://seller.example/mcp';
const BUYER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: BUYER };
const SELLER_CTX: TrainingContext = { mode: 'open', authenticatedAgentUrl: SELLER };

function plan(total: number) {
  return {
    plan_id: 'plan-amendment-7758',
    brand: { domain: 'plan-amendment.example' },
    objectives: 'Plan amended between intent and execution.',
    budget: { total, currency: 'USD', reallocation_threshold: total },
    flight: { start: '2020-01-01T00:00:00Z', end: '2099-06-30T23:59:59Z' },
    countries: ['US'],
  };
}

async function approvedIntent(): Promise<string> {
  const synced = await handleSyncPlans({ plans: [plan(100_000)] }, BUYER_CTX) as Record<string, any>;
  expect(synced.errors, JSON.stringify(synced)).toBeUndefined();
  const intent = await handleCheckGovernance({
    plan_id: 'plan-amendment-7758',
    caller: BUYER,
    target_agent: SELLER,
    tool: 'create_media_buy',
    purchase_type: 'media_buy',
    proposed_commitment: { amount: 25_000, currency: 'USD' },
    payload: {
      brand: { domain: 'plan-amendment.example' },
      total_budget: { amount: 25_000, currency: 'USD' },
      start_time: 'asap',
      end_time: '2099-06-30T23:59:59Z',
      packages: [],
      idempotency_key: 'plan-amendment-7758-create-0001',
    },
  }, BUYER_CTX) as Record<string, any>;
  expect(intent.verdict ?? intent.status, JSON.stringify(intent)).toBe('approved');
  return intent.governance_context as string;
}

async function amendTo(total: number) {
  const amended = await handleSyncPlans({ plans: [plan(total)] }, BUYER_CTX) as Record<string, any>;
  expect(amended.errors, JSON.stringify(amended)).toBeUndefined();
}

function purchaseCheck(governanceContext: string, plannedDelivery: Record<string, unknown>) {
  return handleCheckGovernance({
    caller: SELLER,
    governance_context: governanceContext,
    phase: 'purchase',
    planned_delivery: { start_time: new Date().toISOString(), end_time: '2099-06-30T23:59:59Z', ...plannedDelivery },
  }, SELLER_CTX) as Promise<Record<string, any>>;
}

describe('execution check after a plan amendment (governance_denied)', () => {
  afterEach(() => clearSessions());

  it('denies an intent-approved purchase the amended plan no longer permits', async () => {
    await runWithSessionContext(async () => {
      const context = await approvedIntent();
      await amendTo(10_000);
      const result = await purchaseCheck(context, { total_budget: 25_000, currency: 'USD' });
      expect(result.verdict ?? result.status).toBe('denied');
      expect(result.check_type).toBe('execution');
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ category_id: 'budget_authority', severity: 'critical' }),
      ]));
      expect(result.governance_context).toBeUndefined();
    });
  });

  it('evaluates the intent ceiling when the seller omits planned_delivery.total_budget', async () => {
    await runWithSessionContext(async () => {
      const context = await approvedIntent();
      await amendTo(10_000);
      const result = await purchaseCheck(context, {});
      expect(result.verdict ?? result.status).toBe('denied');
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ category_id: 'budget_authority' }),
      ]));
    });
  });

  it('still approves a purchase without total_budget when the plan has headroom', async () => {
    await runWithSessionContext(async () => {
      const context = await approvedIntent();
      const result = await purchaseCheck(context, {});
      expect(result.verdict ?? result.status, JSON.stringify(result)).toBe('approved');
      expect(result.governance_context).toEqual(expect.any(String));
    });
  });
});
