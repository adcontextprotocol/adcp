/**
 * Governance tool definitions and handlers for the training agent.
 *
 * Implements sync_plans, check_governance, report_plan_outcome,
 * and get_plan_audit_logs per the AdCP campaign governance schema.
 */

import { randomUUID } from 'node:crypto';
import type {
  TrainingContext,
  GovernancePlanState,
  GovernanceDelegation,
  GovernanceCheckState,
  GovernanceOutcomeState,
  GovernanceFinding,
  GovernanceCondition,
} from './types.js';
import { getSession, sessionKeyFromArgs } from './state.js';

// ── Governance tool definitions ─────────────────────────────────

export const GOVERNANCE_TOOLS = [
  {
    name: 'sync_plans',
    description: 'Push campaign governance plans. A plan defines authorized parameters for a campaign — budget limits, channels, flight dates, and authorized markets. Call this before check_governance.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              plan_id: { type: 'string' },
              brand: { type: 'object' },
              objectives: { type: 'string' },
              budget: {
                type: 'object',
                properties: {
                  total: { type: 'number' },
                  currency: { type: 'string' },
                  authority_level: { type: 'string', enum: ['agent_full', 'agent_limited', 'human_required'] },
                  per_seller_max_pct: { type: 'number' },
                  reallocation_threshold: { type: 'number' },
                },
                required: ['total', 'currency', 'authority_level'],
              },
              channels: {
                type: 'object',
                properties: {
                  required: { type: 'array', items: { type: 'string' } },
                  allowed: { type: 'array', items: { type: 'string' } },
                  mix_targets: { type: 'object' },
                },
              },
              flight: {
                type: 'object',
                properties: {
                  start: { type: 'string', format: 'date-time' },
                  end: { type: 'string', format: 'date-time' },
                },
                required: ['start', 'end'],
              },
              countries: { type: 'array', items: { type: 'string' } },
              regions: { type: 'array', items: { type: 'string' } },
              policy_ids: { type: 'array', items: { type: 'string' } },
              custom_policies: { type: 'array', items: { type: 'string' } },
              mode: { type: 'string', enum: ['enforce', 'advisory', 'audit'], description: 'Governance enforcement mode. Defaults to enforce.' },
              approved_sellers: { type: ['array', 'null'], description: 'Seller allowlist. null = unrestricted, [] = deny all, [...urls] = only listed sellers.' },
              delegations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    agent_url: { type: 'string', format: 'uri' },
                    authority: { type: 'string', enum: ['full', 'execute_only', 'propose_only'] },
                    budget_limit: { type: 'object' },
                    markets: { type: 'array', items: { type: 'string' } },
                    expires_at: { type: 'string', format: 'date-time' },
                  },
                  required: ['agent_url', 'authority'],
                },
              },
            },
            required: ['plan_id', 'brand', 'objectives', 'budget', 'flight'],
          },
        },
      },
      required: ['plans'],
    },
  },
  {
    name: 'check_governance',
    description: 'Check whether a campaign action is authorized under the governance plan. Called by the orchestrator before sending to a seller (proposed) or by the seller before executing (committed). Returns approved, denied, conditions, or escalated.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        buyer_campaign_ref: { type: 'string' },
        binding: { type: 'string', enum: ['proposed', 'committed'] },
        caller: { type: 'string', format: 'uri' },
        tool: { type: 'string' },
        payload: { type: 'object' },
        governance_context: { type: 'object', description: 'Normalized governance fields (budget, countries, channels, flight). Preferred over parsing payload.' },
        media_buy_id: { type: 'string' },
        buyer_ref: { type: 'string' },
        phase: { type: 'string', enum: ['purchase', 'modification', 'delivery'] },
        planned_delivery: { type: 'object' },
        delivery_metrics: { type: 'object' },
        modification_summary: { type: 'string' },
      },
      required: ['plan_id', 'buyer_campaign_ref', 'binding', 'caller'],
    },
  },
  {
    name: 'report_plan_outcome',
    description: 'Report the outcome of an action to the governance agent. Called by the orchestrator after a seller responds. Links outcomes to the governance check that authorized them.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        check_id: { type: 'string' },
        buyer_campaign_ref: { type: 'string' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'delivery'] },
        seller_response: { type: 'object' },
        delivery: { type: 'object' },
        error: { type: 'object' },
      },
      required: ['plan_id', 'buyer_campaign_ref', 'outcome'],
    },
  },
  {
    name: 'get_plan_audit_logs',
    description: 'Retrieve governance state and audit trail for one or more plans. Returns budget utilization, channel allocation, campaign breakdown, and drift metrics.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        portfolio_plan_ids: { type: 'array', items: { type: 'string' } },
        buyer_campaign_ref: { type: 'string' },
        include_entries: { type: 'boolean' },
      },
    },
  },
];

// ── Governance categories resolved for every plan ───────────────

const GOVERNANCE_CATEGORIES = [
  'budget_authority',
  'geo_compliance',
  'channel_compliance',
  'flight_compliance',
  'delegation_authority',
  'seller_compliance',
  'seller_concentration',
  'delivery_pacing',
];

// ── Handler implementations ─────────────────────────────────────

export function handleSyncPlans(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const plans = args.plans as Array<Record<string, unknown>>;

  if (!plans?.length) {
    return { errors: [{ code: 'validation_error', message: 'plans array is required' }] };
  }

  const results: Record<string, unknown>[] = [];

  for (const plan of plans) {
    const planId = plan.plan_id as string;
    const budget = plan.budget as Record<string, unknown>;
    const flight = plan.flight as Record<string, unknown>;
    const channels = plan.channels as Record<string, unknown> | undefined;
    const delegations = plan.delegations as Array<Record<string, unknown>> | undefined;

    const existing = session.governancePlans.get(planId);
    const version = existing ? existing.version + 1 : 1;

    const planState: GovernancePlanState = {
      planId,
      version,
      status: 'active',
      brand: plan.brand as import('@adcp/client').BrandReference,
      objectives: plan.objectives as string,
      budget: {
        total: budget.total as number,
        currency: budget.currency as string,
        authorityLevel: budget.authority_level as string,
        perSellerMaxPct: budget.per_seller_max_pct as number | undefined,
        reallocationThreshold: budget.reallocation_threshold as number | undefined,
      },
      channels: channels ? {
        required: channels.required as string[] | undefined,
        allowed: channels.allowed as string[] | undefined,
        mixTargets: channels.mix_targets as Record<string, { min_pct?: number; max_pct?: number }> | undefined,
      } : undefined,
      flight: {
        start: flight.start as string,
        end: flight.end as string,
      },
      countries: plan.countries as string[] | undefined,
      regions: plan.regions as string[] | undefined,
      delegations: delegations?.map(d => ({
        agentUrl: d.agent_url as string,
        authority: d.authority as string,
        budgetLimit: d.budget_limit as { amount: number; currency: string } | undefined,
        markets: d.markets as string[] | undefined,
        expiresAt: d.expires_at as string | undefined,
      })),
      approvedSellers: plan.approved_sellers as string[] | null | undefined,
      policyIds: plan.policy_ids as string[] | undefined,
      customPolicies: plan.custom_policies as string[] | undefined,
      mode: (plan.mode as GovernancePlanState['mode']) || 'enforce',
      committedBudget: existing?.committedBudget ?? 0,
      syncedAt: new Date().toISOString(),
    };

    session.governancePlans.set(planId, planState);

    results.push({
      plan_id: planId,
      status: 'active',
      version,
      categories: GOVERNANCE_CATEGORIES.map(id => ({
        category_id: id,
        status: 'active' as const,
      })),
    });
  }

  return { plans: results };
}

export function handleCheckGovernance(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const planId = args.plan_id as string;
  const buyerCampaignRef = args.buyer_campaign_ref as string;
  const binding = args.binding as 'proposed' | 'committed';
  const caller = args.caller as string;
  const tool = args.tool as string | undefined;
  const payload = args.payload as Record<string, unknown> | undefined;
  const governanceContext = args.governance_context as Record<string, unknown> | undefined;
  const phase = (args.phase as string) || 'purchase';
  const plannedDelivery = args.planned_delivery as Record<string, unknown> | undefined;
  const deliveryMetrics = args.delivery_metrics as Record<string, unknown> | undefined;
  const mediaBuyId = args.media_buy_id as string | undefined;

  const plan = session.governancePlans.get(planId);
  if (!plan) {
    const checkId = `chk_${randomUUID().slice(0, 8)}`;
    const check: GovernanceCheckState = {
      checkId,
      planId,
      buyerCampaignRef,
      binding,
      status: 'denied',
      caller,
      tool,
      phase,
      findings: [{ categoryId: 'plan_lookup', severity: 'critical', explanation: `Plan not found: ${planId}` }],
      explanation: `Plan not found: ${planId}. Call sync_plans first.`,
      mode: 'enforce',
      categoriesEvaluated: ['plan_lookup'],
      policiesEvaluated: [],
      mediaBuyId,
      timestamp: new Date().toISOString(),
    };
    session.governanceChecks.set(checkId, check);
    return buildCheckResponse(check);
  }

  const findings: GovernanceFinding[] = [];
  const conditions: GovernanceCondition[] = [];
  const categoriesEvaluated: string[] = [];
  let shouldEscalate = false;

  // Delegation authority check
  categoriesEvaluated.push('delegation_authority');
  let callerDelegation: GovernanceDelegation | undefined;
  if (plan.delegations?.length) {
    callerDelegation = plan.delegations.find(d => d.agentUrl === caller);
    if (!callerDelegation) {
      findings.push({
        categoryId: 'delegation_authority',
        severity: 'critical',
        explanation: `Caller ${caller} is not in the plan's delegations list.`,
      });
    } else if (callerDelegation.expiresAt && new Date(callerDelegation.expiresAt) < new Date()) {
      findings.push({
        categoryId: 'delegation_authority',
        severity: 'critical',
        explanation: `Delegation for ${caller} expired at ${callerDelegation.expiresAt}.`,
      });
    }
  }

  // Approved sellers check
  if (plan.approvedSellers !== undefined && plan.approvedSellers !== null) {
    categoriesEvaluated.push('seller_compliance');
    if (!plan.approvedSellers.includes(caller)) {
      findings.push({
        categoryId: 'seller_compliance',
        severity: 'critical',
        explanation: `Caller ${caller} is not in the plan's approved sellers list.`,
      });
    }
  }

  // Proposed binding: validate payload against plan.
  // Delegation budget/market limits are checked here because the proposed payload
  // contains the budget and countries. For committed binding, planned_delivery
  // validation handles these constraints instead.
  // Prefer governance_context (canonical shape) over payload heuristics.
  if (binding === 'proposed' && (governanceContext || payload)) {
    const { budget: payloadBudget, budgetFieldPath, countries: payloadCountries, channels: payloadChannels, flight: payloadFlight } =
      governanceContext
        ? extractFromGovernanceContext(governanceContext)
        : extractFromPayload(payload!);

    // Delegation budget_limit enforcement
    if (callerDelegation?.budgetLimit && payloadBudget !== undefined) {
      if (payloadBudget > callerDelegation.budgetLimit.amount) {
        findings.push({
          categoryId: 'delegation_authority',
          severity: 'critical',
          explanation: `Proposed budget $${payloadBudget} exceeds delegation budget limit of $${callerDelegation.budgetLimit.amount} for ${caller}.`,
        });
      }
    }

    // Delegation markets enforcement
    if (callerDelegation?.markets?.length && payloadCountries.length > 0) {
      const delegationMarketSet = new Set(callerDelegation.markets);
      const unauthorized = payloadCountries.filter(c => !delegationMarketSet.has(c));
      if (unauthorized.length > 0) {
        findings.push({
          categoryId: 'delegation_authority',
          severity: 'critical',
          explanation: `Unauthorized markets for delegated agent ${caller}: ${unauthorized.join(', ')}. Delegation allows: ${callerDelegation.markets.join(', ')}.`,
        });
      }
    }

    // Budget compliance
    categoriesEvaluated.push('budget_authority');
    if (payloadBudget !== undefined) {
      const remaining = plan.budget.total - plan.committedBudget;
      if (payloadBudget > remaining) {
        if (payloadBudget > plan.budget.total) {
          findings.push({
            categoryId: 'budget_authority',
            severity: 'critical',
            explanation: `Requested budget $${payloadBudget} exceeds plan total $${plan.budget.total}.`,
          });
        } else {
          conditions.push({
            field: budgetFieldPath,
            requiredValue: remaining,
            reason: `Budget exceeds remaining $${remaining} (committed: $${plan.committedBudget} of $${plan.budget.total}).`,
          });
        }
      }

      // Escalation for human_required authority
      if (plan.budget.authorityLevel === 'human_required' && payloadBudget > plan.budget.total * 0.5) {
        shouldEscalate = true;
      }
    }

    // Seller concentration
    categoriesEvaluated.push('seller_concentration');
    if (plan.budget.perSellerMaxPct && payloadBudget !== undefined) {
      const maxSellerBudget = plan.budget.total * (plan.budget.perSellerMaxPct / 100);
      if (payloadBudget > maxSellerBudget) {
        conditions.push({
          field: budgetFieldPath,
          requiredValue: maxSellerBudget,
          reason: `Budget exceeds per-seller maximum of ${plan.budget.perSellerMaxPct}% ($${maxSellerBudget}).`,
        });
      }
    }

    // Geographic compliance
    categoriesEvaluated.push('geo_compliance');
    if (payloadCountries.length > 0 && plan.countries?.length) {
      const planCountrySet = new Set(plan.countries);
      const unauthorized = payloadCountries.filter(c => !planCountrySet.has(c));
      if (unauthorized.length > 0) {
        findings.push({
          categoryId: 'geo_compliance',
          severity: 'critical',
          explanation: `Unauthorized markets: ${unauthorized.join(', ')}. Plan allows: ${plan.countries.join(', ')}.`,
        });
      }
    }

    // Channel compliance
    categoriesEvaluated.push('channel_compliance');
    if (payloadChannels.length > 0 && plan.channels?.allowed?.length) {
      const allowedSet = new Set(plan.channels.allowed);
      const unauthorized = payloadChannels.filter(c => !allowedSet.has(c));
      if (unauthorized.length > 0) {
        findings.push({
          categoryId: 'channel_compliance',
          severity: 'critical',
          explanation: `Unauthorized channels: ${unauthorized.join(', ')}. Plan allows: ${plan.channels.allowed.join(', ')}.`,
        });
      }
    }

    // Channel mix targets
    if (payloadBudget !== undefined && payloadChannels.length > 0 && plan.channels?.mixTargets) {
      for (const channel of payloadChannels) {
        const target = plan.channels.mixTargets[channel];
        if (target) {
          const channelPct = (payloadBudget / plan.budget.total) * 100;
          if (target.max_pct !== undefined && channelPct > target.max_pct) {
            conditions.push({
              field: budgetFieldPath,
              requiredValue: Math.floor(plan.budget.total * (target.max_pct / 100)),
              reason: `${channel} allocation ${channelPct.toFixed(1)}% exceeds max ${target.max_pct}%.`,
            });
          }
        }
      }
    }

    // Flight compliance
    categoriesEvaluated.push('flight_compliance');
    if (payloadFlight.start || payloadFlight.end) {
      const planStart = new Date(plan.flight.start);
      const planEnd = new Date(plan.flight.end);
      if (payloadFlight.start && new Date(payloadFlight.start) < planStart) {
        findings.push({
          categoryId: 'flight_compliance',
          severity: 'critical',
          explanation: `Start date ${payloadFlight.start} is before plan flight start ${plan.flight.start}.`,
        });
      }
      if (payloadFlight.end && new Date(payloadFlight.end) > planEnd) {
        findings.push({
          categoryId: 'flight_compliance',
          severity: 'critical',
          explanation: `End date ${payloadFlight.end} is after plan flight end ${plan.flight.end}.`,
        });
      }
    }
  }

  // Committed binding: validate planned_delivery
  if (binding === 'committed' && plannedDelivery) {
    categoriesEvaluated.push('geo_compliance', 'channel_compliance', 'flight_compliance');

    const pdGeo = plannedDelivery.geo as Record<string, unknown> | undefined;
    const pdCountries = (pdGeo?.countries as string[]) || [];
    if (pdCountries.length > 0 && plan.countries?.length) {
      const planCountrySet = new Set(plan.countries);
      const unauthorized = pdCountries.filter(c => !planCountrySet.has(c));
      if (unauthorized.length > 0) {
        findings.push({
          categoryId: 'geo_compliance',
          severity: 'critical',
          explanation: `Planned delivery includes unauthorized markets: ${unauthorized.join(', ')}.`,
        });
      }
    }

    const pdChannels = (plannedDelivery.channels as string[]) || [];
    if (pdChannels.length > 0 && plan.channels?.allowed?.length) {
      const allowedSet = new Set(plan.channels.allowed);
      const unauthorized = pdChannels.filter(c => !allowedSet.has(c));
      if (unauthorized.length > 0) {
        findings.push({
          categoryId: 'channel_compliance',
          severity: 'critical',
          explanation: `Planned delivery includes unauthorized channels: ${unauthorized.join(', ')}.`,
        });
      }
    }

    const pdBudget = plannedDelivery.total_budget as number | undefined;
    if (pdBudget !== undefined) {
      categoriesEvaluated.push('budget_authority');
      const remaining = plan.budget.total - plan.committedBudget;
      if (pdBudget > remaining) {
        findings.push({
          categoryId: 'budget_authority',
          severity: 'critical',
          explanation: `Planned delivery budget $${pdBudget} exceeds remaining $${remaining}.`,
        });
      }
    }
  }

  // Delivery phase: check delivery metrics for drift
  if (phase === 'delivery' && deliveryMetrics) {
    categoriesEvaluated.push('delivery_pacing');
    const cumulativeSpend = deliveryMetrics.cumulative_spend as number | undefined;
    if (cumulativeSpend !== undefined) {
      const spendPct = (cumulativeSpend / plan.budget.total) * 100;
      if (spendPct > 95) {
        findings.push({
          categoryId: 'delivery_pacing',
          severity: 'critical',
          explanation: `Cumulative spend $${cumulativeSpend} is ${spendPct.toFixed(1)}% of plan budget — near exhaustion.`,
          confidence: 0.95,
        });
      } else if (spendPct > 80) {
        findings.push({
          categoryId: 'delivery_pacing',
          severity: 'warning',
          explanation: `Cumulative spend $${cumulativeSpend} is ${spendPct.toFixed(1)}% of plan budget.`,
          confidence: 0.9,
        });
      }
    }

    const geoDistribution = deliveryMetrics.geo_distribution as Record<string, number> | undefined;
    if (geoDistribution && plan.countries?.length) {
      const planCountrySet = new Set(plan.countries);
      for (const [country, pct] of Object.entries(geoDistribution)) {
        if (!planCountrySet.has(country) && pct > 1) {
          findings.push({
            categoryId: 'geo_compliance',
            severity: 'warning',
            explanation: `${pct}% of delivery in unauthorized market ${country}.`,
          });
        }
      }
    }
  }

  // Determine status
  const criticalFindings = findings.filter(f => f.severity === 'critical');
  let status: GovernanceCheckState['status'];

  if (shouldEscalate) {
    status = 'escalated';
  } else if (criticalFindings.length > 0) {
    status = 'denied';
  } else if (conditions.length > 0) {
    status = 'conditions';
  } else {
    status = 'approved';
  }

  // Apply governance mode
  const mode = plan.mode;
  if (mode === 'advisory' && (status === 'denied' || status === 'conditions')) {
    status = 'approved';
  } else if (mode === 'audit') {
    status = 'approved';
  }

  const now = new Date();
  const expiresAt = status === 'approved' || status === 'conditions'
    ? new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    : undefined;

  const explanation = buildExplanation(status, findings, conditions, shouldEscalate);

  const checkId = `chk_${randomUUID().slice(0, 8)}`;
  const check: GovernanceCheckState = {
    checkId,
    planId,
    buyerCampaignRef,
    binding,
    status,
    caller,
    tool,
    phase,
    findings,
    conditions: conditions.length > 0 ? conditions : undefined,
    escalation: shouldEscalate ? {
      reason: `Budget commitment exceeds 50% of plan total and authority_level is human_required.`,
      severity: 'high',
      requires_human: true,
      approval_tier: 'manager',
    } : undefined,
    explanation,
    mode,
    categoriesEvaluated: [...new Set(categoriesEvaluated)],
    policiesEvaluated: plan.policyIds || [],
    mediaBuyId,
    timestamp: now.toISOString(),
    expiresAt,
  };

  session.governanceChecks.set(checkId, check);
  return buildCheckResponse(check);
}

export function handleReportPlanOutcome(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const planId = args.plan_id as string;
  const checkId = args.check_id as string | undefined;
  const buyerCampaignRef = args.buyer_campaign_ref as string;
  const outcome = args.outcome as 'completed' | 'failed' | 'delivery';
  const sellerResponse = args.seller_response as Record<string, unknown> | undefined;
  const delivery = args.delivery as Record<string, unknown> | undefined;

  const plan = session.governancePlans.get(planId);
  if (!plan) {
    return { errors: [{ code: 'not_found', message: `Plan not found: ${planId}` }] };
  }

  let committedBudget = 0;
  const findings: GovernanceFinding[] = [];

  if (outcome === 'completed' && sellerResponse) {
    // Prefer committed_budget when present (canonical); fall back to summing packages
    if (typeof sellerResponse.committed_budget === 'number') {
      committedBudget = sellerResponse.committed_budget as number;
    } else {
      const packages = sellerResponse.packages as Array<Record<string, unknown>> | undefined;
      if (packages?.length) {
        committedBudget = packages.reduce((sum, pkg) => {
          const b = pkg.budget;
          if (typeof b === 'number') return sum + b;
          if (b && typeof b === 'object') return sum + ((b as Record<string, unknown>).total as number || 0);
          return sum;
        }, 0);
      }
    }

    plan.committedBudget += committedBudget;

    // Check if committed now exceeds authorized
    if (plan.committedBudget > plan.budget.total) {
      findings.push({
        categoryId: 'budget_authority',
        severity: 'warning',
        explanation: `Total committed $${plan.committedBudget} now exceeds authorized $${plan.budget.total}.`,
      });
    }
  }

  if (outcome === 'delivery' && delivery) {
    const spend = delivery.spend as number | undefined;
    if (spend) {
      committedBudget = spend;
      plan.committedBudget += spend;
    }
  }

  const outcomeId = `out_${randomUUID().slice(0, 8)}`;
  const outcomeState: GovernanceOutcomeState = {
    outcomeId,
    planId,
    checkId,
    buyerCampaignRef,
    outcomeType: outcome,
    committedBudget,
    mediaBuyId: sellerResponse?.media_buy_id as string | undefined ?? delivery?.media_buy_id as string | undefined,
    findings,
    timestamp: new Date().toISOString(),
  };

  session.governanceOutcomes.set(outcomeId, outcomeState);

  const result: Record<string, unknown> = {
    outcome_id: outcomeId,
    status: findings.length > 0 ? 'findings' : 'accepted',
  };

  if (committedBudget > 0) {
    result.committed_budget = committedBudget;
  }

  if (findings.length > 0) {
    result.findings = findings.map(f => ({
      category_id: f.categoryId,
      severity: f.severity,
      explanation: f.explanation,
    }));
  }

  if (outcome === 'completed' || outcome === 'failed') {
    result.plan_summary = {
      total_committed: plan.committedBudget,
      budget_remaining: plan.budget.total - plan.committedBudget,
    };
  }

  return result;
}

export function handleGetPlanAuditLogs(args: Record<string, unknown>, ctx: TrainingContext): Record<string, unknown> {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const planIds = (args.plan_ids as string[]) || [];
  const portfolioPlanIds = (args.portfolio_plan_ids as string[]) || [];
  const includeEntries = args.include_entries as boolean || false;
  const campaignFilter = args.buyer_campaign_ref as string | undefined;

  if (!planIds.length && !portfolioPlanIds.length) {
    return { errors: [{ code: 'validation_error', message: 'plan_ids or portfolio_plan_ids is required' }] };
  }

  const results: Record<string, unknown>[] = [];

  for (const planId of planIds) {
    const plan = session.governancePlans.get(planId);
    if (!plan) continue;

    // Gather checks and outcomes for this plan
    const checks = Array.from(session.governanceChecks.values())
      .filter(c => c.planId === planId && (!campaignFilter || c.buyerCampaignRef === campaignFilter));
    const outcomes = Array.from(session.governanceOutcomes.values())
      .filter(o => o.planId === planId && (!campaignFilter || o.buyerCampaignRef === campaignFilter));

    // Budget state
    const budget = {
      authorized: plan.budget.total,
      committed: plan.committedBudget,
      remaining: plan.budget.total - plan.committedBudget,
      utilization_pct: plan.budget.total > 0
        ? Math.round((plan.committedBudget / plan.budget.total) * 10000) / 100
        : 0,
    };

    // Channel allocation from outcomes
    const channelAllocation: Record<string, { committed: number; pct: number }> = {};

    // Campaign breakdown
    const campaignMap = new Map<string, { status: string; committed: number; mediaBuyIds: Set<string> }>();
    for (const check of checks) {
      if (!campaignMap.has(check.buyerCampaignRef)) {
        campaignMap.set(check.buyerCampaignRef, { status: 'active', committed: 0, mediaBuyIds: new Set() });
      }
      if (check.mediaBuyId) {
        campaignMap.get(check.buyerCampaignRef)!.mediaBuyIds.add(check.mediaBuyId);
      }
    }
    for (const outcome of outcomes) {
      const camp = campaignMap.get(outcome.buyerCampaignRef);
      if (camp) {
        camp.committed += outcome.committedBudget;
        if (outcome.mediaBuyId) camp.mediaBuyIds.add(outcome.mediaBuyId);
      }
    }

    const campaigns = Array.from(campaignMap.entries()).map(([ref, data]) => ({
      buyer_campaign_ref: ref,
      status: data.status,
      committed: data.committed,
      active_media_buys: [...data.mediaBuyIds],
    }));

    // Summary statistics
    const statusCounts = { approved: 0, denied: 0, conditions: 0, escalated: 0 };
    for (const check of checks) {
      statusCounts[check.status]++;
    }

    const totalChecks = checks.length;
    const escalationRate = totalChecks > 0 ? statusCounts.escalated / totalChecks : 0;
    const autoApprovalRate = totalChecks > 0 ? statusCounts.approved / totalChecks : 0;

    const allFindings = [
      ...checks.flatMap(c => c.findings),
      ...outcomes.flatMap(o => o.findings),
    ];
    const confidences = allFindings.filter(f => f.confidence !== undefined).map(f => f.confidence!);
    const meanConfidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : undefined;

    const escalations = checks
      .filter(c => c.status === 'escalated')
      .map(c => ({
        check_id: c.checkId,
        reason: c.escalation?.reason as string ?? 'Escalated per policy',
      }));

    const summary: Record<string, unknown> = {
      checks_performed: totalChecks,
      outcomes_reported: outcomes.length,
      statuses: statusCounts,
      findings_count: allFindings.length,
      escalations,
      drift_metrics: {
        escalation_rate: Math.round(escalationRate * 1000) / 1000,
        escalation_rate_trend: 'stable',
        auto_approval_rate: Math.round(autoApprovalRate * 1000) / 1000,
        human_override_rate: 0,
        ...(meanConfidence !== undefined && { mean_confidence: Math.round(meanConfidence * 1000) / 1000 }),
      },
    };

    const planResult: Record<string, unknown> = {
      plan_id: planId,
      plan_version: plan.version,
      status: plan.status,
      budget,
      channel_allocation: channelAllocation,
      campaigns,
      summary,
    };

    // Include entries if requested
    if (includeEntries) {
      const entries: Record<string, unknown>[] = [];

      for (const check of checks) {
        entries.push({
          id: check.checkId,
          type: 'check',
          timestamp: check.timestamp,
          caller: check.caller,
          tool: check.tool,
          status: check.status,
          binding: check.binding,
          explanation: check.explanation,
          policies_evaluated: check.policiesEvaluated,
          categories_evaluated: check.categoriesEvaluated,
          findings: check.findings.map(f => ({
            category_id: f.categoryId,
            severity: f.severity,
            explanation: f.explanation,
            ...(f.policyId && { policy_id: f.policyId }),
            ...(f.confidence !== undefined && { confidence: f.confidence }),
          })),
        });
      }

      for (const outcome of outcomes) {
        entries.push({
          id: outcome.outcomeId,
          type: 'outcome',
          timestamp: outcome.timestamp,
          outcome: outcome.outcomeType,
          committed_budget: outcome.committedBudget,
          ...(outcome.mediaBuyId && { media_buy_id: outcome.mediaBuyId }),
        });
      }

      // Sort by timestamp
      entries.sort((a, b) => (a.timestamp as string).localeCompare(b.timestamp as string));
      planResult.entries = entries;
    }

    results.push(planResult);
  }

  return { plans: results };
}

// ── Helpers ─────────────────────────────────────────────────────

interface ExtractedFields {
  budget: number | undefined;
  budgetFieldPath: string;
  countries: string[];
  channels: string[];
  flight: { start?: string; end?: string };
}

function extractFromGovernanceContext(ctx: Record<string, unknown>): ExtractedFields {
  const totalBudget = ctx.total_budget as Record<string, unknown> | undefined;
  const flight = ctx.flight as Record<string, unknown> | undefined;
  return {
    budget: totalBudget?.amount as number | undefined,
    budgetFieldPath: 'governance_context.total_budget.amount',
    countries: (ctx.countries as string[]) || [],
    channels: (ctx.channels as string[]) || [],
    flight: {
      start: flight?.start as string | undefined,
      end: flight?.end as string | undefined,
    },
  };
}

function extractFromPayload(payload: Record<string, unknown>): ExtractedFields {
  const budgetInfo = extractBudget(payload);
  return {
    budget: budgetInfo?.amount,
    budgetFieldPath: budgetInfo?.fieldPath ?? 'budget.total',
    countries: extractCountries(payload),
    channels: extractChannels(payload),
    flight: extractFlight(payload),
  };
}

function extractBudget(payload: Record<string, unknown>): { amount: number; fieldPath: string } | undefined {
  // Try total_budget.amount first
  const totalBudget = payload.total_budget as Record<string, unknown> | undefined;
  if (totalBudget?.amount !== undefined) return { amount: totalBudget.amount as number, fieldPath: 'total_budget.amount' };

  // Try total_budget as a number (planned_delivery format)
  if (typeof payload.total_budget === 'number') return { amount: payload.total_budget, fieldPath: 'total_budget' };

  // Try budget.total (common simplified format)
  const budget = payload.budget as Record<string, unknown> | undefined;
  if (budget?.total !== undefined) return { amount: budget.total as number, fieldPath: 'budget.total' };

  // Try budget as a number
  if (typeof payload.budget === 'number') return { amount: payload.budget, fieldPath: 'budget' };

  // Sum package budgets
  const packages = payload.packages as Array<Record<string, unknown>> | undefined;
  if (packages?.length) {
    const total = packages.reduce((sum, pkg) => sum + ((pkg.budget as number) || 0), 0);
    return { amount: total, fieldPath: 'packages.0.budget' };
  }
  return undefined;
}

function extractCountries(payload: Record<string, unknown>): string[] {
  // Look in geo.countries, targeting.countries, or countries
  const geo = payload.geo as Record<string, unknown> | undefined;
  if (geo?.countries) return geo.countries as string[];
  const targeting = payload.targeting as Record<string, unknown> | undefined;
  if (targeting?.countries) return targeting.countries as string[];
  if (payload.countries) return payload.countries as string[];
  return [];
}

function extractChannels(payload: Record<string, unknown>): string[] {
  if (payload.channels) return payload.channels as string[];
  // Singular channel field
  if (typeof payload.channel === 'string') return [payload.channel];
  // Look in packages for channels
  const packages = payload.packages as Array<Record<string, unknown>> | undefined;
  if (packages?.length) {
    const channels = new Set<string>();
    for (const pkg of packages) {
      const pChannels = pkg.channels as string[] | undefined;
      pChannels?.forEach(c => channels.add(c));
    }
    return [...channels];
  }
  return [];
}

function extractFlight(payload: Record<string, unknown>): { start?: string; end?: string } {
  // Try flight.start/end first, then start_time/end_time
  const flight = payload.flight as Record<string, unknown> | undefined;
  if (flight) {
    return {
      start: (flight.start as string) || (flight.start_time as string) || undefined,
      end: (flight.end as string) || (flight.end_time as string) || undefined,
    };
  }
  return {
    start: payload.start_time as string | undefined,
    end: payload.end_time as string | undefined,
  };
}

function buildExplanation(
  status: string,
  findings: GovernanceFinding[],
  conditions: GovernanceCondition[],
  escalated: boolean,
): string {
  if (escalated) {
    return 'Action escalated for human review — budget commitment exceeds threshold for human_required authority level.';
  }
  if (status === 'approved' && findings.length === 0) {
    return 'All governance checks passed.';
  }
  if (status === 'approved' && findings.length > 0) {
    return `Approved with ${findings.length} advisory finding(s).`;
  }
  if (status === 'conditions') {
    return `Conditional approval — ${conditions.length} adjustment(s) required: ${conditions.map(c => c.reason).join('; ')}`;
  }
  if (status === 'denied') {
    const reasons = findings.filter(f => f.severity === 'critical').map(f => f.explanation);
    return `Denied: ${reasons.join('; ')}`;
  }
  return `Governance check completed with status: ${status}.`;
}

function buildCheckResponse(check: GovernanceCheckState): Record<string, unknown> {
  const response: Record<string, unknown> = {
    check_id: check.checkId,
    status: check.status,
    binding: check.binding,
    plan_id: check.planId,
    buyer_campaign_ref: check.buyerCampaignRef,
    explanation: check.explanation,
    mode: check.mode,
    categories_evaluated: check.categoriesEvaluated,
    policies_evaluated: check.policiesEvaluated,
  };

  if (check.findings.length > 0) {
    response.findings = check.findings.map(f => ({
      category_id: f.categoryId,
      severity: f.severity,
      explanation: f.explanation,
      ...(f.policyId && { policy_id: f.policyId }),
      ...(f.confidence !== undefined && { confidence: f.confidence }),
      ...(f.details && { details: f.details }),
    }));
  }

  if (check.conditions?.length) {
    response.conditions = check.conditions.map(c => ({
      field: c.field,
      ...(c.requiredValue !== undefined && { required_value: c.requiredValue }),
      reason: c.reason,
    }));
  }

  if (check.escalation) {
    response.escalation = check.escalation;
  }

  if (check.expiresAt) {
    response.expires_at = check.expiresAt;
  }

  // For delivery phase, suggest next check in 24 hours
  if (check.phase === 'delivery' && check.status === 'approved') {
    response.next_check = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  return response;
}
