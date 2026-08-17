import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/training-agent/task-handlers.js';
import {
  handleCheckGovernance,
  handleGetPlanAuditLogs,
  handleReportPlanAdjustment,
  handleReportPlanOutcome,
  handleSyncPlans,
} from '../../src/training-agent/governance-handlers.js';
import { clearSessions, runWithSessionContext } from '../../src/training-agent/state.js';
import type { GovernanceAdjustmentType, TrainingContext } from '../../src/training-agent/types.js';
import { computeDeliveryStatementDigest } from '../../src/training-agent/governance-payload-hash.js';

const CTX: TrainingContext = { mode: 'open' };
const BUYER_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://buyer.example' };
const SELLER_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://seller.example' };
const ATTACKER_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://attacker.example' };
const PLAN = {
  plan_id: 'plan-adjustment-binding',
  brand: { domain: 'adjustment-binding.example' },
  objectives: 'Verify seller-authenticated append-only commitment adjustments.',
  budget: { total: 100, currency: 'USD', reallocation_threshold: 100 },
  flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
};

async function settle(
  amount = 100,
  accountingMode: 'gross_commitment' | 'verified_net_cost' = 'gross_commitment',
) {
  await handleSyncPlans({
    plans: [{
      ...PLAN,
      budget: { ...PLAN.budget, accounting_mode: accountingMode },
    }],
  }, BUYER_CTX);
  const intent = await handleCheckGovernance({
    plan_id: PLAN.plan_id,
    caller: BUYER_CTX.authenticatedAgentUrl,
    target_agent: SELLER_CTX.authenticatedAgentUrl,
    tool: 'create_media_buy',
    payload: { total_budget: { amount, currency: 'USD' } },
  }, BUYER_CTX) as Record<string, any>;
  const outcome = await handleReportPlanOutcome({
    plan_id: PLAN.plan_id,
    check_id: intent.check_id,
    governance_context: intent.governance_context,
    idempotency_key: `outcome_${intent.check_id}_adjustment`,
    outcome: 'completed',
    seller_response: { seller_reference: 'mb_adjustable_001', committed_budget: amount },
  }, BUYER_CTX) as Record<string, any>;
  expect(outcome.errors, JSON.stringify(outcome)).toBeUndefined();
  return { intent, outcome };
}

function adjustmentRequest(
  outcomeId: string,
  adjustmentType: GovernanceAdjustmentType,
  amount: number,
  suffix = adjustmentType,
) {
  return {
    action: 'report',
    plan_id: PLAN.plan_id,
    outcome_id: outcomeId,
    seller_reference: 'mb_adjustable_001',
    seller_adjustment_id: `seller_adjustment_${suffix}`,
    adjustment_type: adjustmentType,
    amount: { amount, currency: 'USD' },
    reason: `Seller recorded ${adjustmentType} for the governed resource.`,
    effective_at: '2027-02-01T12:00:00Z',
    evidence: {
      evidence_id: `evidence_${suffix}`,
      evidence_type: {
        decommitment: 'decommitment_agreement',
        refund: 'refund_settlement',
        credit: 'credit_note',
        makegood: 'makegood_agreement',
      }[adjustmentType],
      digest: `sha256:${'a'.repeat(64)}`,
      issued_at: '2027-02-01T11:55:00Z',
    },
    idempotency_key: `adjustment_${suffix}_0001`,
  };
}

function reviewRequest(adjustmentId: string, decision: 'accept' | 'dispute' = 'accept', suffix = decision) {
  return {
    action: 'review',
    plan_id: PLAN.plan_id,
    adjustment_id: adjustmentId,
    decision,
    reason: decision === 'dispute' ? 'Buyer evidence does not support the adjustment.' : undefined,
    idempotency_key: `adjustment_review_${suffix}_0001`,
  };
}

async function reportSellerDelivery(
  governanceContext: string,
  cumulativeSpend: number,
  suffix = 'latest',
  sequence = 1,
  reportingPeriod = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' },
) {
  const deliveryMetrics = {
    statement_id: `delivery_statement_${suffix}`,
    sequence,
    issued_at: '2027-02-01T11:00:00Z',
    reporting_period: reportingPeriod,
    cumulative_spend: cumulativeSpend,
    currency: 'USD',
  };
  return handleCheckGovernance({
    caller: SELLER_CTX.authenticatedAgentUrl,
    governance_context: governanceContext,
    phase: 'delivery',
    planned_delivery: {
      media_buy_id: 'mb_adjustable_001',
      total_budget: 100,
      currency: 'USD',
    },
    delivery_metrics: {
      ...deliveryMetrics,
      statement_digest: computeDeliveryStatementDigest('mb_adjustable_001', deliveryMetrics),
    },
  }, SELLER_CTX) as Promise<Record<string, any>>;
}

async function audit() {
  return handleGetPlanAuditLogs({
    brand: PLAN.brand,
    plan_ids: [PLAN.plan_id],
    include_entries: true,
  }, BUYER_CTX) as Promise<Record<string, any>>;
}

describe('report_plan_adjustment', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('restores headroom only for a seller-authenticated decommitment', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      const deliveryCheck = await reportSellerDelivery(intent.governance_context, 60);
      expect(deliveryCheck.verdict, JSON.stringify(deliveryCheck)).toBe('approved');
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 40),
        SELLER_CTX,
      ) as Record<string, any>;
      expect(reported).toMatchObject({ adjustment_state: 'reported', headroom_restored: 0 });
      const result = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id),
        BUYER_CTX,
      ) as Record<string, any>;
      const logs = await audit();
      const plan = logs.plans[0];
      const entry = plan.entries.find((item: any) => item.type === 'adjustment');

      expect(result).toMatchObject({
        adjustment_state: 'verified',
        adjustment_type: 'decommitment',
        amount: { amount: 40, currency: 'USD' },
        headroom_restored: 40,
        plan_summary: {
          gross_committed: 100,
          adjustments_reported: 40,
          adjustments_verified: 40,
          net_cost: 60,
          headroom_restored: 40,
          ledger_committed: 60,
          net_committed: 60,
          budget_remaining: 40,
        },
      });
      expect(plan.budget).toMatchObject({
        authorized: 100,
        gross_committed: 100,
        adjustments_reported: 40,
        adjustments_verified: 40,
        net_cost: 60,
        headroom_restored: 40,
        net_committed: 60,
        committed: 60,
        remaining: 40,
      });
      expect(plan.summary.adjustments_reported).toBe(1);
      expect(plan.governed_actions[0]).toMatchObject({
        committed: 100,
        adjustments_reported: 40,
        adjustments_verified: 40,
        net_cost: 60,
        headroom_restored: 40,
        net_committed: 60,
      });
      expect(entry).toMatchObject({
        caller: SELLER_CTX.authenticatedAgentUrl,
        outcome_id: outcome.outcome_id,
        seller_reference: 'mb_adjustable_001',
        seller_adjustment_id: 'seller_adjustment_decommitment',
        adjustment_type: 'decommitment',
        adjustment_state: 'verified',
        verified_amount: 40,
        amount: { amount: 40, currency: 'USD' },
        headroom_restored: 40,
      });
    });
  });

  it.each(['refund', 'credit', 'makegood'] as const)(
    'records %s without restoring gross-commitment headroom',
    async (adjustmentType) => {
      await runWithSessionContext(async () => {
        const { outcome } = await settle();
        const reported = await handleReportPlanAdjustment(
          adjustmentRequest(outcome.outcome_id, adjustmentType, 25),
          SELLER_CTX,
        ) as Record<string, any>;
        const result = await handleReportPlanAdjustment(
          reviewRequest(reported.adjustment_id, 'accept', adjustmentType),
          BUYER_CTX,
        ) as Record<string, any>;
        const logs = await audit();

        expect(result).toMatchObject({
          adjustment_state: 'verified',
          headroom_restored: 0,
          plan_summary: {
            gross_committed: 100,
            adjustments_reported: 25,
            adjustments_verified: adjustmentType === 'makegood' ? 0 : 25,
            net_cost: adjustmentType === 'makegood' ? 100 : 75,
            headroom_restored: 0,
            net_committed: 100,
            budget_remaining: 0,
          },
        });
        expect(logs.plans[0].budget.committed).toBe(100);
      });
    },
  );

  it.each([
    ['decommitment', true],
    ['refund', false],
    ['credit', false],
    ['makegood', false],
  ] as const)(
    'under accounting_mode verified_net_cost, %s headroom_restored/verified reflects the type',
    async (adjustmentType, needsDeliveryStatement) => {
      await runWithSessionContext(async () => {
        const { intent, outcome } = await settle(100, 'verified_net_cost');
        if (needsDeliveryStatement) {
          // Decommitment is bounded by the undelivered obligation in the
          // latest seller statement, independent of accounting_mode.
          await reportSellerDelivery(intent.governance_context, 60, `net_cost_${adjustmentType}`);
        }
        const amount = adjustmentType === 'decommitment' ? 40 : 25;
        const reported = await handleReportPlanAdjustment(
          adjustmentRequest(outcome.outcome_id, adjustmentType, amount, `net_cost_${adjustmentType}`),
          SELLER_CTX,
        ) as Record<string, any>;
        const verified = await handleReportPlanAdjustment(
          reviewRequest(reported.adjustment_id, 'accept', `net_cost_${adjustmentType}`),
          BUYER_CTX,
        ) as Record<string, any>;

        // Decommitment, refund, and credit all restore headroom under
        // verified_net_cost; makegood never restores headroom and never
        // contributes dollars to adjustments_verified, regardless of mode.
        const expectedAmount = adjustmentType === 'makegood' ? 0 : amount;
        expect(verified).toMatchObject({
          adjustment_state: 'verified',
          headroom_restored: expectedAmount,
          plan_summary: {
            accounting_mode: 'verified_net_cost',
            gross_committed: 100,
            adjustments_verified: expectedAmount,
            net_cost: 100 - expectedAmount,
            ledger_committed: 100 - expectedAmount,
            budget_remaining: expectedAmount,
          },
        });
      });
    },
  );

  it('requires the authenticated plan owner to review an adjustment', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 25, 'wrong_reviewer'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'wrong_reviewer'),
        ATTACKER_CTX,
      ) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
      expect((await audit()).plans[0].budget).toMatchObject({
        adjustments_reported: 25,
        adjustments_verified: 0,
        committed: 100,
      });
    });
  });

  it('records a buyer dispute without changing economic or ledger state', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'credit', 25, 'buyer_dispute'),
        SELLER_CTX,
      ) as Record<string, any>;
      const disputed = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'dispute', 'buyer_dispute'),
        BUYER_CTX,
      ) as Record<string, any>;

      expect(disputed).toMatchObject({
        adjustment_state: 'disputed',
        headroom_restored: 0,
        plan_summary: { adjustments_verified: 0, net_cost: 100, ledger_committed: 100 },
      });
    });
  });

  it('blocks adjustment acceptance when seller and buyer delivery evidence disagree', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 60, 'conflict');
      const statement = sellerDelivery.delivery_statement;
      // A seller_statement_copy whose digest does not match the canonical
      // statement is a dispute (the seller told two different stories),
      // unlike a buyer_measurement value difference, which is
      // measurement_variance and does not block acceptance.
      const buyerDelivery = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: sellerDelivery.check_id,
        governance_context: sellerDelivery.governance_context,
        idempotency_key: 'delivery_conflict_buyer_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'buyer_observation_conflict',
          source: 'seller_statement_copy',
          observed_at: '2027-02-01T11:05:00Z',
          reporting_period: statement.reporting_period,
          cumulative_spend: 80,
          currency: 'USD',
          seller_statement_id: statement.statement_id,
          seller_statement_digest: `sha256:${'e'.repeat(64)}`,
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(buyerDelivery.delivery_reconciliation_status).toBe('disputed');

      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 10, 'delivery_conflict'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'delivery_conflict'),
        BUYER_CTX,
      ) as Record<string, any>;
      const logs = await audit();

      expect(rejected.errors?.[0]).toMatchObject({ code: 'CONFLICT' });
      expect(logs.plans[0].governed_actions[0]).toMatchObject({
        seller_reported_spend: 60,
        buyer_observed_spend: 80,
        conservative_exposure: 80,
        delivery_reconciliation_status: 'disputed',
      });
      expect(logs.plans[0].budget.committed).toBe(100);

      const reconciled = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: sellerDelivery.check_id,
        governance_context: sellerDelivery.governance_context,
        idempotency_key: 'delivery_conflict_resolved_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'buyer_observation_reconciled',
          source: 'buyer_measurement',
          observed_at: '2027-02-01T11:10:00Z',
          reporting_period: statement.reporting_period,
          cumulative_spend: 60,
          currency: 'USD',
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(reconciled.delivery_reconciliation_status).toBe('consistent');

      const accepted = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'delivery_reconciled'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 0 });
      expect((await audit()).plans[0].governed_actions[0]).toMatchObject({
        seller_reported_spend: 60,
        buyer_observed_spend: 60,
        conservative_exposure: 60,
        delivery_reconciliation_status: 'consistent',
      });
    });
  });

  it('freezes a closed unresolved period without turning governance into billing truth', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 60, 'period_close');
      const statement = sellerDelivery.delivery_statement;
      // A seller_statement_copy with a digest that does not match the
      // canonical statement is a dispute (the seller told two different
      // stories); a buyer_measurement value difference would instead be
      // measurement_variance, which never blocks acceptance.
      const openDispute = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: sellerDelivery.check_id,
        governance_context: sellerDelivery.governance_context,
        idempotency_key: 'delivery_period_open_dispute_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'buyer_observation_period_open',
          source: 'seller_statement_copy',
          observed_at: '2027-02-01T11:05:00Z',
          reporting_period: statement.reporting_period,
          cumulative_spend: 80,
          currency: 'USD',
          seller_statement_id: statement.statement_id,
          seller_statement_digest: `sha256:${'e'.repeat(64)}`,
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(openDispute).toMatchObject({
        delivery_reconciliation_status: 'disputed',
        delivery_period_state: 'open',
      });

      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 10, 'closed_period_refund'),
        SELLER_CTX,
      ) as Record<string, any>;
      const closed = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: sellerDelivery.check_id,
        governance_context: sellerDelivery.governance_context,
        idempotency_key: 'delivery_period_close_unresolved_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'buyer_observation_period_close',
          source: 'seller_statement_copy',
          observed_at: '2027-02-02T00:00:00Z',
          reporting_period: statement.reporting_period,
          cumulative_spend: 80,
          currency: 'USD',
          seller_statement_id: statement.statement_id,
          seller_statement_digest: `sha256:${'e'.repeat(64)}`,
          period_closed: true,
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(closed).toMatchObject({
        delivery_reconciliation_status: 'closed_unresolved',
        delivery_period_state: 'closed',
      });

      const accepted = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'closed_period_refund'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 0 });

      const rewrittenBuyerEvidence = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: sellerDelivery.check_id,
        governance_context: sellerDelivery.governance_context,
        idempotency_key: 'delivery_period_rewrite_attempt_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'buyer_observation_period_rewrite',
          source: 'buyer_measurement',
          observed_at: '2027-02-02T01:00:00Z',
          reporting_period: statement.reporting_period,
          cumulative_spend: 60,
          currency: 'USD',
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(rewrittenBuyerEvidence.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      const rewrittenSellerEvidence = await reportSellerDelivery(
        sellerDelivery.governance_context,
        61,
        'closed_period_rewrite',
        2,
      );
      expect(rewrittenSellerEvidence.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      const closedAudit = await audit();
      expect(closedAudit.plans[0].entries
        .filter((entry: Record<string, unknown>) => entry.delivery_reconciliation_status)
        .map((entry: Record<string, unknown>) => entry.delivery_reconciliation_status))
        .toEqual(['disputed', 'closed_unresolved']);

      const nextPeriod = await reportSellerDelivery(
        sellerDelivery.governance_context,
        75,
        'next_period',
        2,
        { start: '2027-02-01T00:00:00Z', end: '2027-03-01T00:00:00Z' },
      );
      expect(nextPeriod.verdict, JSON.stringify(nextPeriod)).toBe('approved');
      const currentAction = (await audit()).plans[0].governed_actions[0];
      expect(currentAction).toMatchObject({
        seller_reported_spend: 75,
        delivery_reporting_period: {
          start: '2027-02-01T00:00:00Z',
          end: '2027-03-01T00:00:00Z',
        },
        delivery_reconciliation_status: 'unmatched',
        delivery_period_state: 'open',
      });
      expect(currentAction).not.toHaveProperty('buyer_observed_spend');
    });
  });

  it('rejects a decommitment larger than the latest undelivered obligation', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      await reportSellerDelivery(intent.governance_context, 80, 'decommit_bound');
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 25, 'decommit_bound'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'decommit_bound'),
        BUYER_CTX,
      ) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await audit()).plans[0].budget.committed).toBe(100);
    });
  });

  it('caps cumulative verified decommitments at the undelivered obligation', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      await reportSellerDelivery(intent.governance_context, 60, 'cumulative_decommit_bound');
      const first = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 30, 'cumulative_decommit_first'),
        SELLER_CTX,
      ) as Record<string, any>;
      expect((await handleReportPlanAdjustment(
        reviewRequest(first.adjustment_id, 'accept', 'cumulative_decommit_first'),
        BUYER_CTX,
      ) as Record<string, any>).adjustment_state).toBe('verified');

      const second = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 11, 'cumulative_decommit_second'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(second.adjustment_id, 'accept', 'cumulative_decommit_second'),
        BUYER_CTX,
      ) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await audit()).plans[0].budget).toMatchObject({
        headroom_restored: 30,
        committed: 70,
      });
    });
  });

  it('rejects seller reuse of a delivery statement ID with different evidence', async () => {
    await runWithSessionContext(async () => {
      const { intent } = await settle();
      const first = await reportSellerDelivery(intent.governance_context, 60, 'seller_equivocation');
      const conflict = await reportSellerDelivery(intent.governance_context, 61, 'seller_equivocation');

      expect(first.verdict).toBe('approved');
      expect(conflict.errors?.[0]).toMatchObject({ code: 'CONFLICT' });
      const statementEntry = (await audit()).plans[0].entries.find(
        (entry: Record<string, unknown>) => entry.delivery_statement,
      );
      expect(statementEntry.delivery_statement).toMatchObject({ cumulative_spend: 60 });
    });
  });

  it('caps cumulative adjustments at the original authoritative commitment', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      expect((await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 30, 'refund_cap'),
        SELLER_CTX,
      ) as Record<string, any>).adjustment_state).toBe('reported');

      const rejected = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 71, 'decommitment_cap'),
        SELLER_CTX,
      ) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await audit()).plans[0].budget).toMatchObject({
        adjustments_reported: 30,
        headroom_restored: 0,
        committed: 100,
      });
    });
  });

  it('rejects a caller other than the seller audience without mutation', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const rejected = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 25),
        ATTACKER_CTX,
      ) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
      expect((await audit()).plans[0].budget.committed).toBe(100);
    });
  });

  it.each([
    ['mismatched resource', { seller_reference: 'mb_other' }],
    ['mismatched currency', { amount: { amount: 25, currency: 'EUR' } }],
    ['zero amount', { amount: { amount: 0, currency: 'USD' } }],
    ['negative amount', { amount: { amount: -25, currency: 'USD' } }],
  ])('rejects %s without mutation', async (_label, patch) => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const rejected = await handleReportPlanAdjustment({
        ...adjustmentRequest(outcome.outcome_id, 'decommitment', 25),
        ...patch,
      }, SELLER_CTX) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await audit()).plans[0].budget.committed).toBe(100);
    });
  });

  it('returns the immutable cached response for an exact replay', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const request = adjustmentRequest(outcome.outcome_id, 'decommitment', 25);
      const first = await handleReportPlanAdjustment(request, SELLER_CTX) as Record<string, any>;
      const replay = await handleReportPlanAdjustment(request, SELLER_CTX) as Record<string, any>;

      expect(replay).toMatchObject({
        adjustment_id: first.adjustment_id,
        replayed: true,
        headroom_restored: 0,
      });
      expect((await audit()).plans[0].budget).toMatchObject({
        adjustments_reported: 25,
        committed: 100,
      });
    });
  });

  it('rejects idempotency and seller adjustment ID reuse with changed payloads', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const request = adjustmentRequest(outcome.outcome_id, 'decommitment', 25);
      expect((await handleReportPlanAdjustment(request, SELLER_CTX) as Record<string, any>).adjustment_state).toBe('reported');

      const idempotencyConflict = await handleReportPlanAdjustment({
        ...request,
        amount: { amount: 20, currency: 'USD' },
      }, SELLER_CTX) as Record<string, any>;
      const sellerIdConflict = await handleReportPlanAdjustment({
        ...request,
        idempotency_key: 'adjustment_distinct_0001',
        amount: { amount: 20, currency: 'USD' },
      }, SELLER_CTX) as Record<string, any>;

      expect(idempotencyConflict.errors?.[0]).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(sellerIdConflict.errors?.[0]).toMatchObject({ code: 'CONFLICT' });
      expect((await audit()).plans[0].budget.committed).toBe(100);
    });
  });

  it('rejects rebinding a seller evidence ID to another adjustment', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const first = adjustmentRequest(outcome.outcome_id, 'refund', 10, 'evidence_first');
      expect((await handleReportPlanAdjustment(first, SELLER_CTX) as Record<string, any>).adjustment_state).toBe('reported');

      const second = adjustmentRequest(outcome.outcome_id, 'refund', 10, 'evidence_second');
      second.evidence.evidence_id = first.evidence.evidence_id;
      const rejected = await handleReportPlanAdjustment(second, SELLER_CTX) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({ code: 'CONFLICT' });
      expect((await audit()).plans[0].budget.adjustments_reported).toBe(10);
    });
  });

  it('lets a seller re-report a corrected amount after the buyer disputes the original', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 60, 'dispute_then_correct_v1'),
        SELLER_CTX,
      ) as Record<string, any>;
      const disputed = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'dispute', 'dispute_then_correct_v1'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(disputed.adjustment_state).toBe('disputed');

      // A disputed adjustment is terminal and must not consume the cumulative
      // adjustment cap — the seller's corrected re-report (new IDs, same
      // outcome) succeeds even though 60 + 45 would exceed the $100 commitment.
      const corrected = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 45, 'dispute_then_correct_v2'),
        SELLER_CTX,
      ) as Record<string, any>;
      expect(corrected).toMatchObject({ adjustment_state: 'reported' });

      const accepted = await handleReportPlanAdjustment(
        reviewRequest(corrected.adjustment_id, 'accept', 'dispute_then_correct_v2'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 0 });
      expect((await audit()).plans[0].budget).toMatchObject({
        adjustments_reported: 105,
        adjustments_verified: 45,
      });
    });
  });

  it('enforces the verified-sum cap against the outcome commitment at accept time', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const refund = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 60, 'verified_sum_refund'),
        SELLER_CTX,
      ) as Record<string, any>;
      expect((await handleReportPlanAdjustment(
        reviewRequest(refund.adjustment_id, 'accept', 'verified_sum_refund'),
        BUYER_CTX,
      ) as Record<string, any>).adjustment_state).toBe('verified');

      const credit = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'credit', 40, 'verified_sum_credit'),
        SELLER_CTX,
      ) as Record<string, any>;
      const accepted = await handleReportPlanAdjustment(
        reviewRequest(credit.adjustment_id, 'accept', 'verified_sum_credit'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted).toMatchObject({
        adjustment_state: 'verified',
        plan_summary: { adjustments_verified: 100 },
      });

      // The commitment is now fully consumed by verified adjustments. Even if
      // a further report slipped past the report-time cap, the accept path's
      // independent verified-sum check must still reject it.
      const extra = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'credit', 1, 'verified_sum_overflow'),
        SELLER_CTX,
      ) as Record<string, any>;
      expect(extra.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('rejects re-reviewing an already-reviewed adjustment and replays the cached response for an exact retry', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const reportedDisputed = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'credit', 20, 're_review_disputed'),
        SELLER_CTX,
      ) as Record<string, any>;
      const disputeRequest = reviewRequest(reportedDisputed.adjustment_id, 'dispute', 're_review_disputed');
      const disputed = await handleReportPlanAdjustment(disputeRequest, BUYER_CTX) as Record<string, any>;
      expect(disputed.adjustment_state).toBe('disputed');

      const reReviewDisputed = await handleReportPlanAdjustment(
        reviewRequest(reportedDisputed.adjustment_id, 'accept', 're_review_disputed_second'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(reReviewDisputed.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      const disputeReplay = await handleReportPlanAdjustment(disputeRequest, BUYER_CTX) as Record<string, any>;
      expect(disputeReplay).toMatchObject({ adjustment_state: 'disputed', replayed: true });

      const reportedVerified = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 20, 're_review_verified'),
        SELLER_CTX,
      ) as Record<string, any>;
      const acceptRequest = reviewRequest(reportedVerified.adjustment_id, 'accept', 're_review_verified');
      const verified = await handleReportPlanAdjustment(acceptRequest, BUYER_CTX) as Record<string, any>;
      expect(verified.adjustment_state).toBe('verified');

      const reReviewVerified = await handleReportPlanAdjustment(
        reviewRequest(reportedVerified.adjustment_id, 'dispute', 're_review_verified_second'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(reReviewVerified.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      const verifiedReplay = await handleReportPlanAdjustment(acceptRequest, BUYER_CTX) as Record<string, any>;
      expect(verifiedReplay).toMatchObject({ adjustment_state: 'verified', replayed: true });
    });
  });

  it('blocks acceptance for any open disputed period across the binding, not just the latest', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      const p1 = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' };
      const p1Check = await reportSellerDelivery(intent.governance_context, 40, 'multi_period_p1', 1, p1);
      const p1Statement = p1Check.delivery_statement;
      // A seller_statement_copy with a mismatched digest is a dispute; a
      // buyer_measurement value difference would instead be
      // measurement_variance, which does not block acceptance.
      const p1Dispute = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: p1Check.check_id,
        governance_context: p1Check.governance_context,
        idempotency_key: 'multi_period_p1_dispute_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'multi_period_p1_obs',
          source: 'seller_statement_copy',
          observed_at: '2027-02-01T00:05:00Z',
          reporting_period: p1,
          cumulative_spend: 90,
          currency: 'USD',
          seller_statement_id: p1Statement.statement_id,
          seller_statement_digest: `sha256:${'e'.repeat(64)}`,
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(p1Dispute).toMatchObject({ delivery_reconciliation_status: 'disputed', delivery_period_state: 'open' });

      const p2 = { start: '2027-02-01T00:00:00Z', end: '2027-03-01T00:00:00Z' };
      const p2Check = await reportSellerDelivery(intent.governance_context, 60, 'multi_period_p2', 2, p2);
      const p2Consistent = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: p2Check.check_id,
        governance_context: p2Check.governance_context,
        idempotency_key: 'multi_period_p2_consistent_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'multi_period_p2_obs',
          source: 'buyer_measurement',
          observed_at: '2027-03-01T00:05:00Z',
          reporting_period: p2,
          cumulative_spend: 60,
          currency: 'USD',
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(p2Consistent.delivery_reconciliation_status).toBe('consistent');

      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 10, 'multi_period_refund'),
        SELLER_CTX,
      ) as Record<string, any>;
      const blocked = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'multi_period_refund'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(blocked.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      // Plan owner closes P1 — it becomes closed_unresolved and no longer blocks acceptance.
      const p1Closed = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: p1Check.check_id,
        governance_context: p1Check.governance_context,
        idempotency_key: 'multi_period_p1_close_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'multi_period_p1_obs_close',
          source: 'seller_statement_copy',
          observed_at: '2027-02-02T00:00:00Z',
          reporting_period: p1,
          cumulative_spend: 90,
          currency: 'USD',
          seller_statement_id: p1Statement.statement_id,
          seller_statement_digest: `sha256:${'e'.repeat(64)}`,
          period_closed: true,
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(p1Closed).toMatchObject({ delivery_reconciliation_status: 'closed_unresolved', delivery_period_state: 'closed' });

      const accepted = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'multi_period_refund_retry'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted.adjustment_state).toBe('verified');
    });
  });

  it('preserves accounting_mode across a re-sync that omits it', async () => {
    await runWithSessionContext(async () => {
      await handleSyncPlans({
        plans: [{ ...PLAN, budget: { ...PLAN.budget, accounting_mode: 'verified_net_cost' } }],
      }, BUYER_CTX);
      await handleSyncPlans({ plans: [PLAN] }, BUYER_CTX);
      const logs = await audit();
      expect(logs.plans[0].budget.accounting_mode).toBe('verified_net_cost');
    });
  });

  it('does not spuriously reject a boundary-exact decommitment due to float summation', async () => {
    await runWithSessionContext(async () => {
      // Remaining obligation is 100.3 - 100 = 0.3 (up to float representation
      // error). Keeping the committed budget well above zero isolates the
      // cap-boundary comparison from the separate "ledger would go negative"
      // guard, which is out of scope for this fix. Plan total is raised to
      // 200 (above 100.3) since `settle`'s shared PLAN fixture caps at 100.
      await handleSyncPlans({
        plans: [{ ...PLAN, budget: { total: 200, currency: 'USD', reallocation_threshold: 200 } }],
      }, BUYER_CTX);
      const floatBoundaryIntent = await handleCheckGovernance({
        plan_id: PLAN.plan_id,
        caller: BUYER_CTX.authenticatedAgentUrl,
        target_agent: SELLER_CTX.authenticatedAgentUrl,
        tool: 'create_media_buy',
        payload: { total_budget: { amount: 100.3, currency: 'USD' } },
      }, BUYER_CTX) as Record<string, any>;
      const outcome = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: floatBoundaryIntent.check_id,
        governance_context: floatBoundaryIntent.governance_context,
        idempotency_key: 'outcome_float_boundary_settlement_0001',
        outcome: 'completed',
        seller_response: { seller_reference: 'mb_adjustable_001', committed_budget: 100.3 },
      }, BUYER_CTX) as Record<string, any>;
      expect(outcome.errors, JSON.stringify(outcome)).toBeUndefined();
      const intent = floatBoundaryIntent;
      await reportSellerDelivery(intent.governance_context, 100, 'float_boundary');

      const first = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 0.1, 'float_boundary_first'),
        SELLER_CTX,
      ) as Record<string, any>;
      expect((await handleReportPlanAdjustment(
        reviewRequest(first.adjustment_id, 'accept', 'float_boundary_first'),
        BUYER_CTX,
      ) as Record<string, any>).adjustment_state).toBe('verified');

      const second = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 0.2, 'float_boundary_second'),
        SELLER_CTX,
      ) as Record<string, any>;
      const secondAccepted = await handleReportPlanAdjustment(
        reviewRequest(second.adjustment_id, 'accept', 'float_boundary_second'),
        BUYER_CTX,
      ) as Record<string, any>;

      // 0.1 + 0.2 !== 0.3 under IEEE 754 float arithmetic; the boundary-exact
      // decommitment must still be accepted rather than spuriously rejected.
      expect(secondAccepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 0.2 });

      // A third decommitment clearly beyond the undelivered obligation is rejected.
      const third = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 0.1, 'float_boundary_third'),
        SELLER_CTX,
      ) as Record<string, any>;
      const thirdRejected = await handleReportPlanAdjustment(
        reviewRequest(third.adjustment_id, 'accept', 'float_boundary_third'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(thirdRejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('restores full headroom for a pre-flight cancellation decommitment', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle(100, 'gross_commitment');
      await reportSellerDelivery(intent.governance_context, 0, 'preflight_cancel');
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 100, 'preflight_cancel'),
        SELLER_CTX,
      ) as Record<string, any>;
      const accepted = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'preflight_cancel'),
        BUYER_CTX,
      ) as Record<string, any>;

      expect(accepted).toMatchObject({
        adjustment_state: 'verified',
        headroom_restored: 100,
        plan_summary: { ledger_committed: 0, budget_remaining: 100 },
      });
    });
  });

  it('rejects a decommitment review when no seller delivery statement exists for the binding', async () => {
    await runWithSessionContext(async () => {
      const { outcome } = await settle();
      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 25, 'no_statement'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'no_statement'),
        BUYER_CTX,
      ) as Record<string, any>;

      expect(rejected.errors?.[0]).toMatchObject({
        code: 'CONFLICT',
        message: 'A canonical seller delivery statement is required before decommitment can be verified.',
      });
    });
  });

  it('rejects a new seller statement whose sequence does not exceed the latest for the binding', async () => {
    await runWithSessionContext(async () => {
      const { intent } = await settle();
      const first = await reportSellerDelivery(intent.governance_context, 40, 'sequence_regression', 2);
      expect(first.verdict, JSON.stringify(first)).toBe('approved');

      const equalSequence = await reportSellerDelivery(intent.governance_context, 45, 'sequence_regression_equal', 2);
      expect(equalSequence.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      const lowerSequence = await reportSellerDelivery(intent.governance_context, 46, 'sequence_regression_lower', 1);
      expect(lowerSequence.errors?.[0]).toMatchObject({ code: 'CONFLICT' });
    });
  });
});

describe('measurement_variance and the conservative decommitment ceiling', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  async function settleWithBudget(total: number, amount: number) {
    await handleSyncPlans({
      plans: [{ ...PLAN, budget: { total, currency: 'USD', reallocation_threshold: total } }],
    }, BUYER_CTX);
    const intent = await handleCheckGovernance({
      plan_id: PLAN.plan_id,
      caller: BUYER_CTX.authenticatedAgentUrl,
      target_agent: SELLER_CTX.authenticatedAgentUrl,
      tool: 'create_media_buy',
      payload: { total_budget: { amount, currency: 'USD' } },
    }, BUYER_CTX) as Record<string, any>;
    const outcome = await handleReportPlanOutcome({
      plan_id: PLAN.plan_id,
      check_id: intent.check_id,
      governance_context: intent.governance_context,
      idempotency_key: `outcome_${intent.check_id}_adjustment`,
      outcome: 'completed',
      seller_response: { seller_reference: 'mb_adjustable_001', committed_budget: amount },
    }, BUYER_CTX) as Record<string, any>;
    expect(outcome.errors, JSON.stringify(outcome)).toBeUndefined();
    return { intent, outcome };
  }

  async function reportBuyerMeasurement(
    checkResult: Record<string, any>,
    cumulativeSpend: number,
    suffix: string,
    reportingPeriod = { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' },
    periodClosed = false,
  ) {
    return handleReportPlanOutcome({
      plan_id: PLAN.plan_id,
      check_id: checkResult.check_id,
      governance_context: checkResult.governance_context,
      idempotency_key: `variance_${suffix}_0001`,
      outcome: 'delivery',
      delivery: {
        observation_id: `variance_obs_${suffix}`,
        source: 'buyer_measurement',
        observed_at: '2027-01-08T01:05:00Z',
        reporting_period: reportingPeriod,
        cumulative_spend: cumulativeSpend,
        currency: 'USD',
        ...(periodClosed ? { period_closed: true } : {}),
      },
    }, BUYER_CTX) as Promise<Record<string, any>>;
  }

  it('records measurement_variance and still allows the adjustment to be accepted', async () => {
    await runWithSessionContext(async () => {
      const { intent, outcome } = await settle();
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 60, 'variance_accept');
      const variance = await reportBuyerMeasurement(sellerDelivery, 65, 'accept');
      expect(variance).toMatchObject({
        outcome_state: 'findings',
        delivery_reconciliation_status: 'measurement_variance',
        delivery_period_state: 'open',
        findings: [{
          category_id: 'delivery_measurement_variance',
          severity: 'warning',
          details: { field: 'delivery.cumulative_spend', seller_stated: 60, buyer_observed: 65 },
        }],
      });

      const reported = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'refund', 10, 'variance_accept'),
        SELLER_CTX,
      ) as Record<string, any>;
      const accepted = await handleReportPlanAdjustment(
        reviewRequest(reported.adjustment_id, 'accept', 'variance_accept'),
        BUYER_CTX,
      ) as Record<string, any>;

      expect(accepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 0 });
    });
  });

  it('holds the conservative ceiling down to the higher buyer-observed figure', async () => {
    await runWithSessionContext(async () => {
      // Commitment 200; seller states 100; buyer observes 150. The ceiling is
      // 200 - max(100, 150) = 50, so a 100 decommitment is rejected but a 50
      // decommitment is accepted.
      const { intent, outcome } = await settleWithBudget(200, 200);
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 100, 'ceiling_buyer_higher');
      const variance = await reportBuyerMeasurement(sellerDelivery, 150, 'ceiling_buyer_higher');
      expect(variance.delivery_reconciliation_status).toBe('measurement_variance');

      const tooLarge = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 100, 'ceiling_buyer_higher_too_large'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(tooLarge.adjustment_id, 'accept', 'ceiling_buyer_higher_too_large'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });

      const withinCeiling = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 50, 'ceiling_buyer_higher_within'),
        SELLER_CTX,
      ) as Record<string, any>;
      const accepted = await handleReportPlanAdjustment(
        reviewRequest(withinCeiling.adjustment_id, 'accept', 'ceiling_buyer_higher_within'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 50 });
    });
  });

  it('does not let a lower buyer-observed figure manufacture decommitment room', async () => {
    await runWithSessionContext(async () => {
      // Commitment 200; seller states 150; buyer observes 100. The ceiling
      // stays at 200 - max(150, 100) = 50 -- the buyer's lower figure cannot
      // widen it.
      const { intent, outcome } = await settleWithBudget(200, 200);
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 150, 'ceiling_buyer_lower');
      const variance = await reportBuyerMeasurement(sellerDelivery, 100, 'ceiling_buyer_lower');
      expect(variance.delivery_reconciliation_status).toBe('measurement_variance');

      const tooLarge = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 51, 'ceiling_buyer_lower_too_large'),
        SELLER_CTX,
      ) as Record<string, any>;
      const rejected = await handleReportPlanAdjustment(
        reviewRequest(tooLarge.adjustment_id, 'accept', 'ceiling_buyer_lower_too_large'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(rejected.errors?.[0]).toMatchObject({ code: 'VALIDATION_ERROR' });

      const withinCeiling = await handleReportPlanAdjustment(
        adjustmentRequest(outcome.outcome_id, 'decommitment', 50, 'ceiling_buyer_lower_within'),
        SELLER_CTX,
      ) as Record<string, any>;
      const accepted = await handleReportPlanAdjustment(
        reviewRequest(withinCeiling.adjustment_id, 'accept', 'ceiling_buyer_lower_within'),
        BUYER_CTX,
      ) as Record<string, any>;
      expect(accepted).toMatchObject({ adjustment_state: 'verified', headroom_restored: 50 });
    });
  });

  it('freezes a measurement_variance period as closed_unresolved once the plan owner closes it', async () => {
    await runWithSessionContext(async () => {
      const { intent } = await settle();
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 60, 'variance_close');
      const variance = await reportBuyerMeasurement(sellerDelivery, 65, 'close_open');
      expect(variance).toMatchObject({ delivery_reconciliation_status: 'measurement_variance', delivery_period_state: 'open' });

      const closed = await reportBuyerMeasurement(
        sellerDelivery,
        65,
        'close_final',
        { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' },
        true,
      );
      expect(closed).toMatchObject({ delivery_reconciliation_status: 'closed_unresolved', delivery_period_state: 'closed' });
    });
  });

  it('exposes measurement_variance and the higher conservative_exposure in the audit view', async () => {
    await runWithSessionContext(async () => {
      const { intent } = await settle();
      const sellerDelivery = await reportSellerDelivery(intent.governance_context, 60, 'variance_audit');
      const variance = await reportBuyerMeasurement(sellerDelivery, 65, 'audit');
      expect(variance.delivery_reconciliation_status).toBe('measurement_variance');

      const logs = await audit();
      expect(logs.plans[0].governed_actions[0]).toMatchObject({
        seller_reported_spend: 60,
        buyer_observed_spend: 65,
        conservative_exposure: 65,
        delivery_reconciliation_status: 'measurement_variance',
      });
    });
  });
});
