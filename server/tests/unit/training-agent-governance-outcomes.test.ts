import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleGetPlanAuditLogs,
  handleReportPlanOutcome,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { computeDeliveryStatementDigest } from '../../src/training-agent/governance-payload-hash.js';
import { clearSessions, getSession, runWithSessionContext } from '../../src/training-agent/state.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const CTX: TrainingContext = { mode: 'open' };
const BUYER_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://buyer.example' };
const SELLER_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://agenticadvertising.org/sales' };
const PLAN = {
  plan_id: 'plan-outcome-binding',
  brand: { domain: 'outcome-binding.example' },
  objectives: 'Verify that callers cannot choose the governance ledger amount.',
  budget: { total: 1_000, currency: 'USD', reallocation_threshold: 1_000 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};

async function setupIntent(amount = 100) {
  await handleSyncPlans({ plans: [PLAN] }, BUYER_CTX);
  return handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller: 'https://buyer.example',
    target_agent: 'https://agenticadvertising.org/sales',
    tool: 'create_media_buy',
    payload: {
      total_budget: { amount, currency: 'USD' },
    },
  }, BUYER_CTX) as Promise<Record<string, any>>;
}

async function report(intent: Record<string, any>, committedBudget: number) {
  return handleReportPlanOutcome({
    plan_id: PLAN.plan_id,
    check_id: intent.check_id,
    governance_context: intent.governance_context,
    idempotency_key: `outcome_${intent.check_id}_0001`,
    outcome: 'completed',
    seller_response: { seller_reference: 'mb_001', committed_budget: committedBudget },
  }, BUYER_CTX) as Promise<Record<string, any>>;
}

async function audit() {
  return handleGetPlanAuditLogs({
    brand: PLAN.brand,
    plan_ids: [PLAN.plan_id],
    include_entries: true,
  }, BUYER_CTX) as Promise<Record<string, any>>;
}

describe('report_plan_outcome authorization and ledger binding', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('reserves the approved amount when the buyer under-reports', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const result = await report(intent, 25);
      const logs = await audit();
      const outcome = logs.plans[0].entries.find((entry: any) => entry.type === 'outcome');

      expect(result).toMatchObject({ outcome_state: 'findings', status: 'findings', committed_budget: 100 });
      expect(logs.plans[0].budget.committed).toBe(100);
      expect(outcome).toMatchObject({ committed_budget: 100, reported_committed_budget: 25 });
    });
  });

  it('uses the seller-side purchase execution amount when present', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const execution = await handleCheckGovernance({
        caller: 'https://agenticadvertising.org/sales',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 80, currency: 'USD' },
      }, SELLER_CTX) as Record<string, any>;
      const result = await report(intent, 80);

      expect(execution.verdict).toBe('approved');
      expect(result).toMatchObject({ status: 'accepted', committed_budget: 80 });
      expect((await audit()).plans[0].budget.committed).toBe(80);
    });
  });

  it('rejects a report above the governance-authorized amount without mutation', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const result = await report(intent, 101);
      const logs = await audit();

      expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
      expect(logs.plans[0].budget.committed).toBe(0);
      expect(logs.plans[0].summary.outcomes_reported).toBe(0);
    });
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects invalid reported budget %s without mutation',
    async (invalid) => {
      await runWithSessionContext(async () => {
        const intent = await setupIntent(100);
        const result = await report(intent, invalid);
        expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
        expect((await audit()).plans[0].budget.committed).toBe(0);
      });
    },
  );

  it('returns the cached response for an exact idempotent replay', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const first = await report(intent, 100);
      const session = await getSession('open:outcome-binding.example');
      const retiredEntry = [...session.governancePlans.entries()].find(([, plan]) =>
        plan.planId === PLAN.plan_id && plan.ownerAgentUrl === BUYER_CTX.authenticatedAgentUrl);
      const retiredPlan = retiredEntry?.[1];
      if (retiredEntry) session.governancePlans.delete(retiredEntry[0]);
      session.governanceChecks.clear();
      const replay = await report(intent, 100);
      expect(replay).toMatchObject({
        outcome_id: first.outcome_id,
        status: 'accepted',
        replayed: true,
      });
      expect(retiredPlan?.committedBudget).toBe(100);
    });
  });

  it('rejects idempotency-key reuse with a different outcome payload', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      expect((await report(intent, 100)).status).toBe('accepted');
      const conflict = await report(intent, 99);

      expect(conflict.errors?.[0]?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await audit()).plans[0].budget.committed).toBe(100);
    });
  });

  it('treats governance_context as part of exact outcome replay identity', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      expect((await report(intent, 100)).status).toBe('accepted');
      const conflict = await report({ ...intent, governance_context: `${intent.governance_context}.changed` }, 100);

      expect(conflict.errors?.[0]?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await audit()).plans[0].budget.committed).toBe(100);
    });
  });

  it('rejects a second terminal settlement across intent and execution check IDs', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const execution = await handleCheckGovernance({
        caller: 'https://agenticadvertising.org/sales',
        governance_context: intent.governance_context,
        phase: 'purchase',
        planned_delivery: { total_budget: 80, currency: 'USD' },
      }, SELLER_CTX) as Record<string, any>;
      expect((await report(intent, 80)).status).toBe('accepted');

      const duplicate = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: execution.check_id,
        governance_context: execution.governance_context,
        idempotency_key: `outcome_${execution.check_id}_0001`,
        outcome: 'completed',
        seller_response: { committed_budget: 80 },
      }, BUYER_CTX) as Record<string, any>;

      expect(duplicate.errors?.[0]?.code).toBe('CONFLICT');
      expect((await audit()).plans[0].budget.committed).toBe(80);
    });
  });

  it('retains delivery evidence without counting spend twice', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      await report(intent, 100);
      const deliveryMetrics = {
        statement_id: 'stmt_mb_001_0001',
        sequence: 1,
        issued_at: '2027-01-02T01:00:00Z',
        reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' },
        cumulative_spend: 40,
        currency: 'USD',
      };
      const sellerStatement = await handleCheckGovernance({
        caller: SELLER_CTX.authenticatedAgentUrl,
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_001', total_budget: 100, currency: 'USD' },
        delivery_metrics: {
          ...deliveryMetrics,
          statement_digest: computeDeliveryStatementDigest('mb_001', deliveryMetrics),
        },
      }, SELLER_CTX) as Record<string, any>;
      const delivery = {
        observation_id: 'obs_mb_001_0001',
        source: 'seller_statement_copy',
        observed_at: '2027-01-02T01:05:00Z',
        reporting_period: deliveryMetrics.reporting_period,
        cumulative_spend: 40,
        currency: 'USD',
        seller_statement_id: deliveryMetrics.statement_id,
        seller_statement_digest: computeDeliveryStatementDigest('mb_001', deliveryMetrics),
      };
      const observationRequest = {
        plan_id: PLAN.plan_id,
        idempotency_key: `delivery_${intent.check_id}_0001`,
        check_id: sellerStatement.check_id,
        governance_context: sellerStatement.governance_context,
        outcome: 'delivery',
        delivery,
      } as const;
      const result = await handleReportPlanOutcome(observationRequest, BUYER_CTX) as Record<string, any>;
      const equivocation = await handleReportPlanOutcome({
        ...observationRequest,
        idempotency_key: `delivery_${intent.check_id}_0002`,
        delivery: { ...delivery, cumulative_spend: 41 },
      }, BUYER_CTX) as Record<string, any>;
      const logs = await audit();
      const deliveryEntry = logs.plans[0].entries.find((entry: any) => entry.outcome === 'delivery');

      expect(result.status).toBe('accepted');
      expect(result.delivery_reconciliation_status).toBe('consistent');
      expect(equivocation.errors?.[0]).toMatchObject({ code: 'CONFLICT' });
      expect(logs.plans[0].budget.committed).toBe(100);
      expect(deliveryEntry.delivery).toEqual(delivery);
    });
  });

  it('rejects a legacy delivery snapshot with only one exact-tuple field', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const base = {
        plan_id: PLAN.plan_id,
        idempotency_key: `delivery_pair_${intent.check_id}`,
        outcome: 'delivery' as const,
        delivery: {
          reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' },
        },
      };

      const contextOnly = await handleReportPlanOutcome({
        ...base,
        governance_context: intent.governance_context,
      }, BUYER_CTX) as Record<string, any>;
      expect(contextOnly.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });

      const checkOnly = await handleReportPlanOutcome({
        ...base,
        idempotency_key: `${base.idempotency_key}_check`,
        check_id: intent.check_id,
      }, BUYER_CTX) as Record<string, any>;
      expect(checkOnly.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('rejects settlement by a reporter other than the original intent caller', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const result = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: intent.check_id,
        governance_context: intent.governance_context,
        idempotency_key: `attack_${intent.check_id}_0001`,
        outcome: 'completed',
        seller_response: { committed_budget: 100 },
      }, { ...CTX, authenticatedAgentUrl: 'https://attacker.example' }) as Record<string, any>;

      expect(result.errors?.[0]?.code).toBe('REFERENCE_NOT_FOUND');
      expect((await audit()).plans[0].budget.committed).toBe(0);
    });
  });

  it('rejects settlement under a different purchase_type', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const result = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: intent.check_id,
        governance_context: intent.governance_context,
        purchase_type: 'rights_license',
        idempotency_key: `wrong_type_${intent.check_id}_0001`,
        outcome: 'completed',
        seller_response: { committed_budget: 100 },
      }, BUYER_CTX) as Record<string, any>;

      expect(result.errors?.[0]?.code).toBe('VALIDATION_ERROR');
      expect((await audit()).plans[0].budget.committed).toBe(0);
    });
  });
});
