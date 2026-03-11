/**
 * sync_plans tool handler.
 *
 * Stores campaign plans and resolves applicable policies from the registry.
 */

import { createLogger } from '../../logger.js';
import { upsertPlan } from '../../db/governance-db.js';
import { resolvePoliciesForPlan } from '../policy-evaluator.js';

const logger = createLogger('governance:sync-plans');

interface SyncPlansRequest {
  plans: Array<{
    plan_id: string;
    brand: { domain: string; brand_id?: string };
    objectives: string;
    budget: {
      total: number;
      currency: string;
      authority_level: string;
      per_seller_max_pct?: number;
      reallocation_threshold?: number;
    };
    channels?: {
      required?: string[];
      allowed?: string[];
      mix_targets?: Record<string, { min_pct?: number; max_pct?: number }>;
    };
    flight: { start: string; end: string };
    countries?: string[];
    regions?: string[];
    approved_sellers?: string[] | null;
    ext?: Record<string, unknown>;
  }>;
}

export async function handleSyncPlans(
  accountId: string,
  request: SyncPlansRequest
): Promise<{ plans: Array<{ plan_id: string; status: string; version: number; categories: Array<{ category_id: string; status: string }>; resolved_policies?: Array<{ policy_id: string; source: string; enforcement: string; reason?: string }> }> }> {
  const results: Array<{
    plan_id: string;
    status: string;
    version: number;
    categories: Array<{ category_id: string; status: string }>;
    resolved_policies?: Array<{ policy_id: string; source: string; enforcement: string; reason?: string }>;
  }> = [];

  for (const planInput of request.plans) {
    try {
      // Resolve policies based on plan's countries and brand verticals
      // For now, auto-apply by jurisdiction. Brand compliance config integration is future work.
      const resolvedPolicies = await resolvePoliciesForPlan(
        [], // No explicit brand policies yet — future: resolve from brand.json compliance config
        planInput.countries || [],
        [] // No verticals from plan — future: resolve from brand.json
      );

      const plan = await upsertPlan(accountId, planInput, resolvedPolicies);

      logger.info({
        planId: plan.plan_id,
        version: plan.version,
        policyCount: resolvedPolicies.length,
      }, 'Plan synced');

      // Active categories for this agent
      const categories = [
        { category_id: 'budget_authority', status: 'active' },
        { category_id: 'strategic_alignment', status: 'active' },
        { category_id: 'regulatory_compliance', status: resolvedPolicies.length > 0 ? 'active' : 'inactive' },
        { category_id: 'seller_verification', status: 'active' },
        { category_id: 'brand_policy', status: 'inactive' }, // Future: activate when brand compliance config integrated
        { category_id: 'bias_fairness', status: 'inactive' }, // Future: specialized model needed
      ];

      results.push({
        plan_id: plan.plan_id,
        status: 'active',
        version: plan.version,
        categories,
        resolved_policies: resolvedPolicies,
      });
    } catch (error) {
      logger.error({ error, planId: planInput.plan_id }, 'Failed to sync plan');
      results.push({
        plan_id: planInput.plan_id,
        status: 'error',
        version: 0,
        categories: [],
      });
    }
  }

  return { plans: results };
}
