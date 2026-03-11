/**
 * report_plan_outcome tool handler.
 *
 * Reports action outcomes, updates budget state, and detects discrepancies
 * between planned and actual delivery.
 */

import { createLogger } from '../../logger.js';
import {
  getPlan,
  getCheck,
  getBudgetSummary,
  insertOutcome,
  type Finding,
} from '../../db/governance-db.js';

const logger = createLogger('governance:report-plan-outcome');

interface ReportPlanOutcomeRequest {
  plan_id: string;
  check_id?: string;
  buyer_campaign_ref: string;
  outcome: 'completed' | 'failed' | 'delivery';
  seller_response?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export async function handleReportPlanOutcome(
  accountId: string,
  request: ReportPlanOutcomeRequest
): Promise<Record<string, unknown>> {
  const plan = await getPlan(request.plan_id);
  if (!plan) {
    return { outcome_id: '', status: 'findings', findings: [{ category_id: 'budget_authority', severity: 'critical', explanation: `Plan ${request.plan_id} not found.` }] };
  }

  if (plan.account_id !== accountId) {
    return { outcome_id: '', status: 'findings', findings: [{ category_id: 'seller_verification', severity: 'critical', explanation: 'Plan does not belong to this account.' }] };
  }

  const findings: Finding[] = [];
  let committedBudget: number | undefined;

  if (request.outcome === 'completed') {
    if (!request.check_id) {
      findings.push({
        category_id: 'seller_verification',
        severity: 'warning',
        explanation: 'Completed outcome reported without a governance check reference.',
      });
    }
    // Validate check_id exists
    if (request.check_id) {
      const check = await getCheck(request.check_id);
      if (!check) {
        findings.push({
          category_id: 'seller_verification',
          severity: 'warning',
          explanation: `Referenced check ${request.check_id} not found.`,
        });
      } else if (check.plan_id !== request.plan_id) {
        findings.push({
          category_id: 'seller_verification',
          severity: 'critical',
          explanation: `Check ${request.check_id} belongs to plan ${check.plan_id}, not ${request.plan_id}.`,
        });
      } else if (check.status !== 'approved') {
        findings.push({
          category_id: 'seller_verification',
          severity: 'critical',
          explanation: `Referenced check ${request.check_id} was not approved (status: ${check.status}).`,
        });
      }
    }

    // Extract committed budget from seller response
    const sellerResponse = request.seller_response;
    if (sellerResponse) {
      const pd = sellerResponse.planned_delivery as Record<string, unknown> | undefined;
      if (pd && typeof pd.total_budget === 'number') {
        committedBudget = pd.total_budget;
      } else if (typeof sellerResponse.total_budget === 'number') {
        committedBudget = sellerResponse.total_budget;
      } else if (sellerResponse.packages && Array.isArray(sellerResponse.packages)) {
        committedBudget = (sellerResponse.packages as Array<{ budget?: number }>)
          .reduce((sum, pkg) => sum + (pkg.budget || 0), 0);
      }
    }
  }

  if (request.outcome === 'delivery') {
    // Validate delivery metrics
    const delivery = request.delivery;
    if (delivery) {
      // Check pacing
      if (delivery.pacing === 'behind') {
        findings.push({
          category_id: 'strategic_alignment',
          severity: 'warning',
          explanation: 'Delivery is pacing behind schedule.',
        });
      }

      // Check cumulative spend against budget
      if (typeof delivery.cumulative_spend === 'number' || typeof delivery.spend === 'number') {
        const budgetSummary = await getBudgetSummary(request.plan_id);
        if (budgetSummary) {
          const totalSpent = (delivery.cumulative_spend as number) || (delivery.spend as number) || 0;
          const pct = (totalSpent / plan.budget_total) * 100;
          if (pct > 100) {
            findings.push({
              category_id: 'budget_authority',
              severity: 'critical',
              explanation: `Cumulative spend (${totalSpent} ${plan.budget_currency}) exceeds plan budget (${plan.budget_total} ${plan.budget_currency}).`,
            });
          }
        }
      }
    }
  }

  const outcomeStatus = findings.some(f => f.severity === 'critical') ? 'findings' : 'accepted';

  const outcome = await insertOutcome({
    plan_id: request.plan_id,
    check_id: request.check_id,
    buyer_campaign_ref: request.buyer_campaign_ref,
    outcome: request.outcome,
    seller_response: request.seller_response,
    delivery: request.delivery,
    error: request.error,
    committed_budget: committedBudget,
    status: outcomeStatus,
    findings,
  });

  logger.info({
    outcomeId: outcome.outcome_id,
    planId: request.plan_id,
    outcome: request.outcome,
    committedBudget,
    status: outcomeStatus,
  }, 'Outcome reported');

  const response: Record<string, unknown> = {
    outcome_id: outcome.outcome_id,
    status: outcomeStatus,
  };

  if (committedBudget !== undefined) response.committed_budget = committedBudget;
  if (findings.length > 0) response.findings = findings;

  // Include plan summary for completed/failed outcomes
  if (request.outcome === 'completed' || request.outcome === 'failed') {
    const budgetSummary = await getBudgetSummary(request.plan_id);
    if (budgetSummary) {
      response.plan_summary = {
        total_committed: budgetSummary.total_committed,
        budget_remaining: budgetSummary.budget_remaining,
      };
    }
  }

  return response;
}
