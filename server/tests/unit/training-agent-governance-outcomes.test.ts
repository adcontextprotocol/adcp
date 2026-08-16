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

describe('delivery observation binds to the canonical statement', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('rejects an observation naming a superseded seller statement and accepts one naming the corrected canonical statement', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      await report(intent, 100);
      const period = { start: '2027-01-01T00:00:00Z', end: '2027-01-08T00:00:00Z' };

      const seq1Metrics = {
        statement_id: 'stmt_canonical_seq1',
        sequence: 1,
        issued_at: '2027-01-08T01:00:00Z',
        reporting_period: period,
        cumulative_spend: 40,
        currency: 'USD',
      };
      const seq1Check = await handleCheckGovernance({
        caller: SELLER_CTX.authenticatedAgentUrl,
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_canonical', total_budget: 100, currency: 'USD' },
        delivery_metrics: {
          ...seq1Metrics,
          statement_digest: computeDeliveryStatementDigest('mb_canonical', seq1Metrics),
        },
      }, SELLER_CTX) as Record<string, any>;
      expect(seq1Check.verdict, JSON.stringify(seq1Check)).toBe('approved');

      // Seller issues a corrected, higher-sequence statement for the same open period.
      const seq2Metrics = {
        statement_id: 'stmt_canonical_seq2',
        sequence: 2,
        issued_at: '2027-01-08T02:00:00Z',
        reporting_period: period,
        cumulative_spend: 45,
        currency: 'USD',
      };
      const seq2Check = await handleCheckGovernance({
        caller: SELLER_CTX.authenticatedAgentUrl,
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_canonical', total_budget: 100, currency: 'USD' },
        delivery_metrics: {
          ...seq2Metrics,
          statement_digest: computeDeliveryStatementDigest('mb_canonical', seq2Metrics),
        },
      }, SELLER_CTX) as Record<string, any>;
      expect(seq2Check.verdict, JSON.stringify(seq2Check)).toBe('approved');

      // An observation naming the superseded seq-1 check is rejected.
      const staleObservation = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: seq1Check.check_id,
        governance_context: seq1Check.governance_context,
        idempotency_key: 'canonical_stale_observation_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'obs_canonical_stale',
          source: 'buyer_measurement',
          observed_at: '2027-01-08T02:05:00Z',
          reporting_period: period,
          cumulative_spend: 40,
          currency: 'USD',
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(staleObservation.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      // An observation naming the corrected, canonical seq-2 check compares
      // normally, and the corrected statement is the comparison target.
      const canonicalObservation = await handleReportPlanOutcome({
        plan_id: PLAN.plan_id,
        check_id: seq2Check.check_id,
        governance_context: seq2Check.governance_context,
        idempotency_key: 'canonical_observation_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'obs_canonical_current',
          source: 'buyer_measurement',
          observed_at: '2027-01-08T02:10:00Z',
          reporting_period: period,
          cumulative_spend: 45,
          currency: 'USD',
        },
      }, BUYER_CTX) as Record<string, any>;
      expect(canonicalObservation.delivery_reconciliation_status).toBe('consistent');
    });
  });
});

describe('delivery statement digest integrity', () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it('matches the golden digest vector from the check_governance documentation example', () => {
    // Verbatim from docs/governance/campaign/tasks/check_governance.mdx —
    // the "Execution check -- delivery" example. This digest was
    // independently verified against the doc; if the computed value ever
    // differs, the transcription above is wrong, not the helper.
    const deliveryMetrics = {
      statement_id: 'stmt_mb_seller_456_0001',
      statement_digest: 'sha256:4b55f1157094ed8df2635250f71568701d294cb0da57845eba886a62e5434633',
      sequence: 1,
      issued_at: '2026-03-22T01:00:00Z',
      reporting_period: {
        start: '2026-03-15T00:00:00Z',
        end: '2026-03-22T00:00:00Z',
      },
      spend: 12500,
      cumulative_spend: 12500,
      currency: 'USD',
      impressions: 850000,
      cumulative_impressions: 850000,
      geo_distribution: { US: 100 },
      channel_distribution: { olv: 100 },
      pacing: 'on_track',
      audience_distribution: {
        baseline: 'platform',
        indices: {
          'age:18-24': 0.8,
          'age:25-34': 1.4,
          'age:35-44': 1.3,
          'age:45-54': 1.1,
          'gender:female': 1.05,
          'gender:male': 0.95,
        },
        cumulative_indices: {
          'age:18-24': 0.85,
          'age:25-34': 1.35,
          'age:35-44': 1.25,
          'age:45-54': 1.1,
          'gender:female': 1.03,
          'gender:male': 0.97,
        },
      },
    };

    expect(computeDeliveryStatementDigest('mb_seller_456', deliveryMetrics))
      .toBe('sha256:4b55f1157094ed8df2635250f71568701d294cb0da57845eba886a62e5434633');
  });

  it('rejects a delivery statement whose statement_digest does not match the canonical recomputation', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupIntent(100);
      const deliveryMetrics = {
        statement_id: 'stmt_digest_mismatch_0001',
        sequence: 1,
        issued_at: '2027-01-02T01:00:00Z',
        reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' },
        cumulative_spend: 40,
        currency: 'USD',
      };
      const result = await handleCheckGovernance({
        caller: SELLER_CTX.authenticatedAgentUrl,
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_digest_mismatch', total_budget: 100, currency: 'USD' },
        delivery_metrics: {
          ...deliveryMetrics,
          statement_digest: `sha256:${'0'.repeat(64)}`,
        },
      }, SELLER_CTX) as Record<string, any>;

      expect(result.errors?.[0]).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'delivery_metrics.statement_digest does not match the canonical delivery statement.',
      });
    });
  });
});

describe('delivery observation reporting authority', () => {
  const OWNER_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://owner-f4.example' };
  const DELEGATE_CTX: TrainingContext = { ...CTX, authenticatedAgentUrl: 'https://delegate-f4.example' };
  const PLAN_F4 = {
    plan_id: 'plan-delivery-authority',
    brand: { domain: 'delivery-authority.example' },
    objectives: 'Verify plan-owner closing authority for delivery reporting periods.',
    budget: { total: 1_000, currency: 'USD', reallocation_threshold: 1_000 },
    flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
    delegations: [{ agent_url: DELEGATE_CTX.authenticatedAgentUrl, authority: 'full' as const }],
  };

  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  async function setupDelegatedIntent() {
    await handleSyncPlans({ plans: [PLAN_F4] }, OWNER_CTX);
    return handleCheckGovernance({
      plan_id: PLAN_F4.plan_id,
      caller: DELEGATE_CTX.authenticatedAgentUrl,
      target_agent: SELLER_CTX.authenticatedAgentUrl,
      tool: 'create_media_buy',
      payload: { total_budget: { amount: 100, currency: 'USD' } },
    }, DELEGATE_CTX) as Promise<Record<string, any>>;
  }

  it('rejects a delegated intent caller closing a reporting period but allows the plan owner to report and close it', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupDelegatedIntent();
      const settlement = await handleReportPlanOutcome({
        plan_id: PLAN_F4.plan_id,
        check_id: intent.check_id,
        governance_context: intent.governance_context,
        idempotency_key: 'f4_settlement_0001',
        outcome: 'completed',
        seller_response: { seller_reference: 'mb_f4', committed_budget: 100 },
      }, DELEGATE_CTX) as Record<string, any>;
      expect(settlement.errors, JSON.stringify(settlement)).toBeUndefined();

      const deliveryMetrics = {
        statement_id: 'stmt_f4_0001',
        sequence: 1,
        issued_at: '2027-01-08T01:00:00Z',
        reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-08T00:00:00Z' },
        cumulative_spend: 40,
        currency: 'USD',
      };
      const deliveryCheck = await handleCheckGovernance({
        caller: SELLER_CTX.authenticatedAgentUrl,
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_f4', total_budget: 100, currency: 'USD' },
        delivery_metrics: {
          ...deliveryMetrics,
          statement_digest: computeDeliveryStatementDigest('mb_f4', deliveryMetrics),
        },
      }, SELLER_CTX) as Record<string, any>;
      expect(deliveryCheck.verdict, JSON.stringify(deliveryCheck)).toBe('approved');

      // The delegated intent caller may report delivery, but may not close the period.
      const delegateCloseAttempt = await handleReportPlanOutcome({
        plan_id: PLAN_F4.plan_id,
        check_id: deliveryCheck.check_id,
        governance_context: deliveryCheck.governance_context,
        idempotency_key: 'f4_delegate_close_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'f4_delegate_close_obs',
          source: 'buyer_measurement',
          observed_at: '2027-01-08T01:05:00Z',
          reporting_period: deliveryMetrics.reporting_period,
          cumulative_spend: 40,
          currency: 'USD',
          period_closed: true,
        },
      }, DELEGATE_CTX) as Record<string, any>;
      expect(delegateCloseAttempt.errors?.[0]).toMatchObject({ code: 'PERMISSION_DENIED' });

      // The plan owner — who never placed the intent — may report a delivery observation.
      const ownerObservation = await handleReportPlanOutcome({
        plan_id: PLAN_F4.plan_id,
        check_id: deliveryCheck.check_id,
        governance_context: deliveryCheck.governance_context,
        idempotency_key: 'f4_owner_observation_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'f4_owner_obs',
          source: 'buyer_measurement',
          observed_at: '2027-01-08T01:10:00Z',
          reporting_period: deliveryMetrics.reporting_period,
          cumulative_spend: 40,
          currency: 'USD',
        },
      }, OWNER_CTX) as Record<string, any>;
      expect(ownerObservation.errors, JSON.stringify(ownerObservation)).toBeUndefined();

      // The plan owner may close the period.
      const ownerClose = await handleReportPlanOutcome({
        plan_id: PLAN_F4.plan_id,
        check_id: deliveryCheck.check_id,
        governance_context: deliveryCheck.governance_context,
        idempotency_key: 'f4_owner_close_0001',
        outcome: 'delivery',
        delivery: {
          observation_id: 'f4_owner_close_obs',
          source: 'buyer_measurement',
          observed_at: '2027-01-08T01:15:00Z',
          reporting_period: deliveryMetrics.reporting_period,
          cumulative_spend: 40,
          currency: 'USD',
          period_closed: true,
        },
      }, OWNER_CTX) as Record<string, any>;
      expect(ownerClose.delivery_period_state).toBe('closed');
    });
  });

  it('deduplicates delivery observations by the authenticated reporter, not the plan owner', async () => {
    await runWithSessionContext(async () => {
      const intent = await setupDelegatedIntent();
      await handleReportPlanOutcome({
        plan_id: PLAN_F4.plan_id,
        check_id: intent.check_id,
        governance_context: intent.governance_context,
        idempotency_key: 'f5_settlement_0001',
        outcome: 'completed',
        seller_response: { seller_reference: 'mb_f5', committed_budget: 100 },
      }, DELEGATE_CTX);

      const deliveryMetrics = {
        statement_id: 'stmt_f5_0001',
        sequence: 1,
        issued_at: '2027-01-08T01:00:00Z',
        reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-08T00:00:00Z' },
        cumulative_spend: 40,
        currency: 'USD',
      };
      const deliveryCheck = await handleCheckGovernance({
        caller: SELLER_CTX.authenticatedAgentUrl,
        governance_context: intent.governance_context,
        phase: 'delivery',
        planned_delivery: { media_buy_id: 'mb_f5', total_budget: 100, currency: 'USD' },
        delivery_metrics: {
          ...deliveryMetrics,
          statement_digest: computeDeliveryStatementDigest('mb_f5', deliveryMetrics),
        },
      }, SELLER_CTX) as Record<string, any>;

      const firstObservation = {
        plan_id: PLAN_F4.plan_id,
        check_id: deliveryCheck.check_id,
        governance_context: deliveryCheck.governance_context,
        idempotency_key: 'f5_delegate_obs_0001',
        outcome: 'delivery' as const,
        delivery: {
          observation_id: 'f5_dedup_obs',
          source: 'buyer_measurement' as const,
          observed_at: '2027-01-08T01:05:00Z',
          reporting_period: deliveryMetrics.reporting_period,
          cumulative_spend: 40,
          currency: 'USD',
        },
      };
      const first = await handleReportPlanOutcome(firstObservation, DELEGATE_CTX) as Record<string, any>;
      expect(first.errors, JSON.stringify(first)).toBeUndefined();

      // Same observation_id, different evidence: the authenticated reporter
      // (the delegate) is what dedup must scope to, not the plan owner.
      const conflicting = await handleReportPlanOutcome({
        ...firstObservation,
        idempotency_key: 'f5_delegate_obs_0002',
        delivery: { ...firstObservation.delivery, cumulative_spend: 41 },
      }, DELEGATE_CTX) as Record<string, any>;
      expect(conflicting.errors?.[0]).toMatchObject({ code: 'CONFLICT' });

      const replay = await handleReportPlanOutcome(firstObservation, DELEGATE_CTX) as Record<string, any>;
      expect(replay).toMatchObject({ replayed: true });
    });
  });
});
