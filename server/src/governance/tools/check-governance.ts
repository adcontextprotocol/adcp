/**
 * check_governance tool handler.
 *
 * Validates actions against campaign plans using:
 * 1. Budget guardrails (deterministic)
 * 2. Geo/channel/flight alignment (deterministic)
 * 3. Seller authorization (deterministic)
 * 4. Policy compliance (Claude-based evaluation)
 */

import { createLogger } from '../../logger.js';
import { getPlan, getBudgetSummary, insertCheck, type Finding } from '../../db/governance-db.js';
import { checkBudget, extractBudget } from '../budget-guard.js';
import {
  checkGeoAlignment,
  checkChannelAlignment,
  checkFlightAlignment,
  checkSellerAuthorization,
  extractActionContext,
} from '../alignment-checks.js';
import { evaluatePolicies } from '../policy-evaluator.js';

const logger = createLogger('governance:check-governance');

interface CheckGovernanceRequest {
  plan_id: string;
  buyer_campaign_ref: string;
  binding: 'proposed' | 'committed';
  caller: string;
  tool?: string;
  payload?: Record<string, unknown>;
  media_buy_id?: string;
  buyer_ref?: string;
  phase?: string;
  planned_delivery?: Record<string, unknown>;
  delivery_metrics?: Record<string, unknown>;
  modification_summary?: string;
}

export async function handleCheckGovernance(
  accountId: string,
  request: CheckGovernanceRequest
): Promise<Record<string, unknown>> {
  const plan = await getPlan(request.plan_id);
  if (!plan) {
    return {
      check_id: '',
      status: 'denied',
      binding: request.binding,
      plan_id: request.plan_id,
      buyer_campaign_ref: request.buyer_campaign_ref,
      explanation: `Plan ${request.plan_id} not found.`,
      findings: [{ category_id: 'budget_authority', severity: 'critical', explanation: `Plan ${request.plan_id} not found.` }],
    };
  }

  // Verify account ownership
  if (plan.account_id !== accountId) {
    return {
      check_id: '',
      status: 'denied',
      binding: request.binding,
      plan_id: request.plan_id,
      buyer_campaign_ref: request.buyer_campaign_ref,
      explanation: 'Plan does not belong to this account.',
      findings: [{ category_id: 'seller_verification', severity: 'critical', explanation: 'Plan does not belong to this account.' }],
    };
  }

  const allFindings: Finding[] = [];
  let escalate = false;
  const phase = request.phase || 'purchase';

  // 1. Budget checks (for purchase and modification phases)
  if (phase === 'purchase' || phase === 'modification') {
    const budgetSummary = await getBudgetSummary(request.plan_id);
    if (budgetSummary) {
      const actionBudget = extractBudget(request.payload, request.planned_delivery);
      if (actionBudget != null && actionBudget >= 0) {
        const budgetResult = checkBudget(plan, budgetSummary, actionBudget);
        allFindings.push(...budgetResult.findings);
        if (budgetResult.escalate) escalate = true;
      } else if (actionBudget == null && (request.tool === 'create_media_buy' || request.tool === 'update_media_buy')) {
        allFindings.push({
          category_id: 'budget_authority',
          severity: 'warning',
          explanation: 'Could not extract budget from action payload. Manual review recommended.',
        });
      }
    }
  }

  // 2. Geo/channel/flight alignment
  const actionCtx = extractActionContext(request.payload, request.planned_delivery);
  allFindings.push(...checkGeoAlignment(plan, actionCtx.countries, actionCtx.regions));
  allFindings.push(...checkChannelAlignment(plan, actionCtx.channels));
  allFindings.push(...checkFlightAlignment(plan, actionCtx.startTime, actionCtx.endTime));

  // 3. Seller authorization (for proposed checks)
  if (request.binding === 'proposed' && actionCtx.sellerUrl) {
    allFindings.push(...checkSellerAuthorization(plan, actionCtx.sellerUrl));
  }

  // 4. Policy compliance (Claude-based, for plans with resolved policies)
  if (plan.resolved_policies.length > 0) {
    const policyIds = plan.resolved_policies.map(p => p.policy_id);
    const policyEval = await evaluatePolicies(policyIds, {
      plan: {
        plan_id: plan.plan_id,
        objectives: plan.objectives,
        countries: plan.countries,
        regions: plan.regions,
        channels_required: plan.channels_required,
        channels_allowed: plan.channels_allowed,
      },
      action: {
        tool: request.tool,
        payload: request.payload,
        planned_delivery: request.planned_delivery,
        delivery_metrics: request.delivery_metrics,
      },
      binding: request.binding,
      phase,
    });
    allFindings.push(...policyEval.findings);
  }

  // Determine status from findings
  const hasCritical = allFindings.some(f => f.severity === 'critical');
  let status: 'approved' | 'denied' | 'escalated';
  if (escalate) {
    status = 'escalated';
  } else if (hasCritical) {
    status = 'denied';
  } else {
    status = 'approved';
  }

  const explanation = status === 'approved'
    ? `Action ${request.binding === 'proposed' ? 'pre-approved' : 'approved'} against plan ${plan.plan_id}.${allFindings.length > 0 ? ` ${allFindings.length} advisory finding(s).` : ''}`
    : allFindings.filter(f => f.severity === 'critical').map(f => f.explanation).join(' ');

  // Set expiry for approved checks (1 hour for proposed, 24 hours for committed)
  const expiresAt = status === 'approved'
    ? new Date(Date.now() + (request.binding === 'proposed' ? 3600000 : 86400000))
    : undefined;

  // Store the check
  const check = await insertCheck({
    plan_id: request.plan_id,
    buyer_campaign_ref: request.buyer_campaign_ref,
    binding: request.binding,
    caller: request.caller,
    phase,
    tool: request.tool,
    payload: request.payload,
    media_buy_id: request.media_buy_id,
    buyer_ref: request.buyer_ref,
    planned_delivery: request.planned_delivery,
    delivery_metrics: request.delivery_metrics,
    modification_summary: request.modification_summary,
    status,
    explanation,
    findings: allFindings,
    escalation: escalate ? { reason: explanation, severity: 'critical', requires_human: true } : undefined,
    expires_at: expiresAt,
  });

  logger.info({
    checkId: check.check_id,
    planId: request.plan_id,
    binding: request.binding,
    status,
    findingCount: allFindings.length,
  }, 'Governance check completed');

  const response: Record<string, unknown> = {
    check_id: check.check_id,
    status,
    binding: request.binding,
    plan_id: request.plan_id,
    buyer_campaign_ref: request.buyer_campaign_ref,
    explanation,
  };

  if (allFindings.length > 0) response.findings = allFindings;
  if (expiresAt) response.expires_at = expiresAt.toISOString();
  if (escalate) response.escalation = { reason: explanation, severity: 'critical', requires_human: true };

  return response;
}
