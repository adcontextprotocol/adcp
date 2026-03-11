/**
 * get_plan_audit_logs tool handler.
 *
 * Returns governance state, budget summary, campaign breakdowns, and audit trail.
 */

import { createLogger } from '../../logger.js';
import {
  getPlan,
  getBudgetSummary,
  getChecksForPlan,
  getOutcomesForPlan,
  getCheckAndOutcomeStats,
  getCampaignSummaries,
  getEscalations,
} from '../../db/governance-db.js';

const logger = createLogger('governance:get-plan-audit-logs');

interface GetPlanAuditLogsRequest {
  plan_id: string;
  buyer_campaign_ref?: string;
  include_entries?: boolean;
}

export async function handleGetPlanAuditLogs(
  accountId: string,
  request: GetPlanAuditLogsRequest
): Promise<Record<string, unknown>> {
  const plan = await getPlan(request.plan_id);
  if (!plan) {
    return { error: `Plan ${request.plan_id} not found.` };
  }

  if (plan.account_id !== accountId) {
    return { error: 'Plan does not belong to this account.' };
  }

  const [budgetSummary, stats, campaigns, escalations] = await Promise.all([
    getBudgetSummary(request.plan_id),
    getCheckAndOutcomeStats(request.plan_id, request.buyer_campaign_ref),
    getCampaignSummaries(request.plan_id),
    getEscalations(request.plan_id),
  ]);

  const response: Record<string, unknown> = {
    plan_id: plan.plan_id,
    plan_version: plan.version,
    status: plan.status,
  };

  if (budgetSummary) {
    response.budget = {
      authorized: budgetSummary.budget_total,
      committed: budgetSummary.total_committed,
      remaining: budgetSummary.budget_remaining,
      utilization_pct: budgetSummary.budget_total > 0
        ? (budgetSummary.total_committed / budgetSummary.budget_total) * 100
        : 0,
    };
  }

  response.campaigns = campaigns;
  response.summary = {
    ...stats,
    escalations,
  };

  // Include full audit trail if requested
  if (request.include_entries) {
    const [checks, outcomes] = await Promise.all([
      getChecksForPlan(request.plan_id, request.buyer_campaign_ref),
      getOutcomesForPlan(request.plan_id, request.buyer_campaign_ref),
    ]);

    type EntryType = {
      id: string;
      type: 'check' | 'outcome';
      timestamp: string;
      tool?: string;
      status?: string;
      binding?: string;
      outcome?: string;
      committed_budget?: number;
      media_buy_id?: string;
      outcome_status?: string;
    };

    const entries: EntryType[] = [
      ...checks.map(c => ({
        id: c.check_id,
        type: 'check' as const,
        timestamp: c.created_at.toISOString(),
        tool: c.tool || undefined,
        status: c.status,
        binding: c.binding,
      })),
      ...outcomes.map(o => ({
        id: o.outcome_id,
        type: 'outcome' as const,
        timestamp: o.created_at.toISOString(),
        outcome: o.outcome,
        committed_budget: o.committed_budget ?? undefined,
        media_buy_id: o.seller_response?.media_buy_id as string | undefined,
        outcome_status: o.status,
      })),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    response.entries = entries;
  }

  logger.debug({ planId: request.plan_id, entryCount: request.include_entries ? 'included' : 'skipped' }, 'Audit logs retrieved');

  return response;
}
