/**
 * Budget guardrails for the community governance agent.
 *
 * Deterministic checks — no LLM needed. Validates budget limits,
 * per-seller concentration, and authority levels.
 */

import type { GovernancePlan, BudgetSummary, Finding } from '../db/governance-db.js';

interface BudgetCheckResult {
  approved: boolean;
  findings: Finding[];
  escalate: boolean;
  explanation: string;
}

/**
 * Check budget compliance for a proposed or committed action.
 */
export function checkBudget(
  plan: GovernancePlan,
  budgetSummary: BudgetSummary,
  actionBudget: number,
  sellerId?: string,
  existingSellerSpend?: number
): BudgetCheckResult {
  const findings: Finding[] = [];
  let approved = true;
  let escalate = false;

  const remaining = budgetSummary.budget_remaining;

  // Check if action exceeds remaining budget
  if (actionBudget > remaining) {
    findings.push({
      category_id: 'budget_authority',
      severity: 'critical',
      explanation: `Action budget (${actionBudget} ${plan.budget_currency}) exceeds remaining plan budget (${remaining.toFixed(2)} ${plan.budget_currency}). Total authorized: ${plan.budget_total} ${plan.budget_currency}, committed: ${budgetSummary.total_committed.toFixed(2)} ${plan.budget_currency}.`,
    });
    approved = false;
  }

  // Check per-seller concentration
  if (plan.budget_per_seller_max_pct && sellerId) {
    const sellerTotal = (existingSellerSpend || 0) + actionBudget;
    const sellerPct = (sellerTotal / plan.budget_total) * 100;
    if (sellerPct > plan.budget_per_seller_max_pct) {
      findings.push({
        category_id: 'budget_authority',
        severity: 'warning',
        explanation: `Seller concentration would reach ${sellerPct.toFixed(1)}%, exceeding per-seller max of ${plan.budget_per_seller_max_pct}%.`,
      });
    }
  }

  // Check reallocation threshold
  if (plan.budget_reallocation_threshold && actionBudget > plan.budget_reallocation_threshold) {
    if (plan.budget_authority_level !== 'agent_full') {
      findings.push({
        category_id: 'budget_authority',
        severity: 'critical',
        explanation: `Action budget (${actionBudget} ${plan.budget_currency}) exceeds reallocation threshold (${plan.budget_reallocation_threshold} ${plan.budget_currency}). Human approval required.`,
      });
      escalate = true;
      approved = false;
    }
  }

  // Check authority level
  if (plan.budget_authority_level === 'human_required') {
    findings.push({
      category_id: 'budget_authority',
      severity: 'critical',
      explanation: 'Plan requires human approval for all budget commitments.',
    });
    escalate = true;
    approved = false;
  }

  // Utilization warning at 90%
  const utilizationAfter = ((budgetSummary.total_committed + actionBudget) / plan.budget_total) * 100;
  if (utilizationAfter > 90 && approved) {
    findings.push({
      category_id: 'budget_authority',
      severity: 'info',
      explanation: `Budget utilization would reach ${utilizationAfter.toFixed(1)}% after this action.`,
    });
  }

  const explanation = approved
    ? `Budget check passed. ${remaining.toFixed(2)} ${plan.budget_currency} remaining after this action.`
    : findings.map(f => f.explanation).join(' ');

  return { approved, findings, escalate, explanation };
}

/**
 * Extract the budget amount from a tool payload or planned delivery.
 * Returns null if no budget field can be found (distinct from 0 which means free/bonus).
 */
export function extractBudget(
  payload?: Record<string, unknown>,
  plannedDelivery?: Record<string, unknown>
): number | null {
  // From planned_delivery (committed checks)
  if (plannedDelivery) {
    if (typeof plannedDelivery.total_budget === 'number') return plannedDelivery.total_budget;
  }

  // From tool payload (proposed checks)
  if (payload) {
    // create_media_buy / update_media_buy patterns
    if (typeof payload.budget === 'number') return payload.budget;
    if (typeof payload.total_budget === 'number') return payload.total_budget;
    // Budget as object (e.g., { total: 15000, currency: "USD" } or { amount: 15000 })
    if (payload.budget && typeof payload.budget === 'object') {
      const b = payload.budget as Record<string, unknown>;
      if (typeof b.total === 'number') return b.total;
      if (typeof b.amount === 'number') return b.amount;
    }
    if (payload.packages && Array.isArray(payload.packages)) {
      return (payload.packages as Array<{ budget?: number }>)
        .reduce((sum, pkg) => sum + (pkg.budget || 0), 0);
    }
  }

  return null;
}
