/**
 * Governance tool definitions and handlers for the training agent.
 *
 * Implements sync_plans, check_governance, report_plan_outcome,
 * and get_plan_audit_logs per the AdCP campaign governance schema.
 */

import { randomUUID } from 'node:crypto';
import type {
  TrainingContext,
  ToolArgs,
  GovernancePlanState,
  GovernanceDelegation,
  GovernanceCheckState,
  GovernanceOutcomeState,
  GovernanceFinding,
  GovernanceCondition,
} from './types.js';
import type { BrandReference } from '@adcp/client';
import { getSession, sessionKeyFromArgs } from './state.js';

const VALID_PURCHASE_TYPES = new Set(['media_buy', 'rights_license', 'signal_activation', 'creative_services']);

interface SyncPlansInput extends ToolArgs {
  plans: SyncPlanInput[];
}

interface SyncPlanInput {
  plan_id: string;
  brand: BrandReference;
  objectives: string;
  budget: { total: number; currency: string; authority_level: string; per_seller_max_pct?: number; reallocation_threshold?: number; allocations?: Record<string, { amount?: number; max_pct?: number }> };
  flight: { start: string; end: string };
  channels?: { required?: string[]; allowed?: string[]; mix_targets?: Record<string, { min_pct?: number; max_pct?: number }> };
  countries?: string[];
  regions?: string[];
  delegations?: Array<{ agent_url: string; authority: string; budget_limit?: { amount: number; currency: string }; markets?: string[]; expires_at?: string }>;
  approved_sellers?: string[] | null;
  policy_ids?: string[];
  custom_policies?: string[];
  mode?: GovernancePlanState['mode'];
}

interface CheckGovernanceInput extends ToolArgs {
  plan_id: string;
  binding?: 'proposed' | 'committed';
  caller: string;
  purchase_type?: string;
  tool?: string;
  payload?: CheckPayload;
  governance_context?: string;
  phase?: string;
  planned_delivery?: PlannedDeliveryInput;
  delivery_metrics?: DeliveryMetricsInput;
  modification_summary?: string;
}

interface CheckPayload {
  packages?: Array<{ budget?: number; channels?: string[] }>;
  budget?: number | { total?: number };
  total_budget?: number | { amount?: number };
  geo?: { countries?: string[] };
  targeting?: { countries?: string[] };
  countries?: string[];
  channels?: string[];
  channel?: string;
  start_time?: string;
  end_time?: string;
  flight?: { start?: string; end?: string; start_time?: string; end_time?: string };
  // Brand rights payload fields
  campaign?: { countries?: string[]; start_date?: string; end_date?: string };
}

interface PlannedDeliveryInput {
  geo?: { countries?: string[] };
  channels?: string[];
  total_budget?: number;
}

interface DeliveryMetricsInput {
  cumulative_spend?: number;
  geo_distribution?: Record<string, number>;
}

interface ReportPlanOutcomeInput extends ToolArgs {
  plan_id: string;
  check_id?: string;
  governance_context?: string;
  purchase_type?: string;
  outcome: 'completed' | 'failed' | 'delivery';
  seller_response?: SellerResponseInput;
  delivery?: { spend?: number };
  error?: object;
}

interface SellerResponseInput {
  committed_budget?: number;
  packages?: Array<{ budget?: number | { total?: number } }>;
}

interface GetPlanAuditLogsInput extends ToolArgs {
  plan_ids?: string[];
  portfolio_plan_ids?: string[];
  governance_contexts?: string[];
  include_entries?: boolean;
}

// ── Governance tool definitions ─────────────────────────────────

export const GOVERNANCE_TOOLS = [
  {
    name: 'sync_plans',
    description: 'Push campaign governance plans. A plan defines authorized parameters for a campaign — budget limits, channels, flight dates, and authorized markets. Call this before check_governance.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
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
                  allocations: {
                    type: 'object',
                    description: 'Optional budget partition across purchase types. Keys are purchase-type enum values.',
                    additionalProperties: {
                      type: 'object',
                      properties: {
                        amount: { type: 'number' },
                        max_pct: { type: 'number' },
                      },
                    },
                  },
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
    description: 'Check whether a campaign action is authorized under the governance plan. Called by the orchestrator before sending a purchase request (proposed) or by the seller before executing (committed). Returns approved, denied, conditions, or escalated. Do not call for read-only operations (get_products, get_signals, get_rights) — only for actions that create or modify financial commitments.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        caller: { type: 'string', format: 'uri' },
        purchase_type: { type: 'string', enum: ['media_buy', 'rights_license', 'signal_activation', 'creative_services'], description: 'Type of financial commitment. Defaults to media_buy.' },
        tool: { type: 'string', description: 'The AdCP tool being checked. Present on intent checks (orchestrator).' },
        payload: { type: 'object', description: 'The full tool arguments. Present on intent checks.' },
        governance_context: { type: 'string', description: 'Opaque governance context from a prior check_governance response. Pass on subsequent checks for lifecycle continuity.' },

        phase: { type: 'string', enum: ['purchase', 'modification', 'delivery'] },
        planned_delivery: { type: 'object', description: 'What the seller will deliver. Present on execution checks.' },
        delivery_metrics: { type: 'object' },
        modification_summary: { type: 'string' },
      },
      required: ['plan_id', 'caller'],
    },
  },
  {
    name: 'report_plan_outcome',
    description: 'Report the outcome of an action to the governance agent. Called by the orchestrator after a seller responds. Links outcomes to the governance check that authorized them.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_id: { type: 'string' },
        check_id: { type: 'string' },
        governance_context: { type: 'string', description: 'Opaque governance context from the check_governance response that authorized this action.' },
        purchase_type: { type: 'string', enum: ['media_buy', 'rights_license', 'signal_activation', 'creative_services'], description: 'Type of financial commitment. Defaults to media_buy.' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'delivery'] },
        seller_response: { type: 'object' },
        delivery: { type: 'object' },
        error: { type: 'object' },
      },
      required: ['plan_id', 'outcome', 'governance_context'],
    },
  },
  {
    name: 'get_plan_audit_logs',
    description: 'Retrieve governance state and audit trail for one or more plans. Returns budget utilization, channel allocation, campaign breakdown, and drift metrics.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        portfolio_plan_ids: { type: 'array', items: { type: 'string' } },
        governance_contexts: { type: 'array', items: { type: 'string' }, description: 'Filter audit entries by governance context.' },
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

export function handleSyncPlans(args: ToolArgs, ctx: TrainingContext) {
  const session = getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as SyncPlansInput;

  if (!input.plans?.length) {
    return { errors: [{ code: 'validation_error', message: 'plans array is required' }] };
  }

  const results: Array<{ plan_id: string; status: string; version: number; categories: Array<{ category_id: string; status: string }> }> = [];

  // Validate all plans before mutating session state to keep the operation atomic
  for (let i = 0; i < input.plans.length; i++) {
    const plan = input.plans[i];
    if (!plan.plan_id || !plan.brand || !plan.objectives || !plan.budget || !plan.flight) {
      return { errors: [{ code: 'validation_error', message: `plan at index ${i} requires plan_id, brand, objectives, budget, and flight` }] };
    }
    if (plan.budget.total == null || !plan.budget.currency || !plan.budget.authority_level) {
      return { errors: [{ code: 'validation_error', message: `plan ${plan.plan_id} budget requires total, currency, and authority_level` }] };
    }
    if (!plan.flight.start || !plan.flight.end) {
      return { errors: [{ code: 'validation_error', message: `plan ${plan.plan_id} flight requires start and end` }] };
    }
    if (plan.budget.allocations) {
      const invalidKeys = Object.keys(plan.budget.allocations).filter(k => !VALID_PURCHASE_TYPES.has(k));
      if (invalidKeys.length > 0) {
        return { errors: [{ code: 'validation_error', message: `plan ${plan.plan_id} budget.allocations has invalid keys: ${invalidKeys.join(', ')}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
      }
    }
  }

  for (const plan of input.plans) {
    const existing = session.governancePlans.get(plan.plan_id);
    const version = existing ? existing.version + 1 : 1;

    const planState: GovernancePlanState = {
      planId: plan.plan_id,
      version,
      status: 'active',
      brand: plan.brand,
      objectives: plan.objectives,
      budget: {
        total: plan.budget.total,
        currency: plan.budget.currency,
        authorityLevel: plan.budget.authority_level,
        perSellerMaxPct: plan.budget.per_seller_max_pct,
        reallocationThreshold: plan.budget.reallocation_threshold,
        allocations: plan.budget.allocations ? Object.fromEntries(
          Object.entries(plan.budget.allocations).map(([k, v]) => [k, { amount: v.amount, maxPct: v.max_pct }]),
        ) : undefined,
      },
      channels: plan.channels ? {
        required: plan.channels.required,
        allowed: plan.channels.allowed,
        mixTargets: plan.channels.mix_targets,
      } : undefined,
      flight: {
        start: plan.flight.start,
        end: plan.flight.end,
      },
      countries: plan.countries,
      regions: plan.regions,
      delegations: plan.delegations?.map(d => ({
        agentUrl: d.agent_url,
        authority: d.authority,
        budgetLimit: d.budget_limit,
        markets: d.markets,
        expiresAt: d.expires_at,
      })),
      approvedSellers: plan.approved_sellers,
      policyIds: plan.policy_ids,
      customPolicies: plan.custom_policies,
      mode: plan.mode || 'enforce',
      committedBudget: existing?.committedBudget ?? 0,
      committedByType: existing?.committedByType ?? {},
      syncedAt: new Date().toISOString(),
    };

    session.governancePlans.set(plan.plan_id, planState);

    results.push({
      plan_id: plan.plan_id,
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

export function handleCheckGovernance(args: ToolArgs, ctx: TrainingContext) {
  const req = args as CheckGovernanceInput;
  const session = getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const planId = req.plan_id;
  const caller = req.caller;
  const purchaseType = req.purchase_type || 'media_buy';
  const tool = req.tool;
  const payload = req.payload;
  const governanceContext = req.governance_context;
  const phase = req.phase || 'purchase';
  const plannedDelivery = req.planned_delivery;
  const deliveryMetrics = req.delivery_metrics;

  if (req.purchase_type && !VALID_PURCHASE_TYPES.has(req.purchase_type)) {
    return { errors: [{ code: 'validation_error', message: `Invalid purchase_type: ${req.purchase_type}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
  }

  // Infer binding from field presence per the schema spec:
  // tool+payload = intent check (proposed), governance_context+planned_delivery = execution check (committed)
  const binding: 'proposed' | 'committed' = req.binding
    || (req.governance_context && req.planned_delivery ? 'committed' : 'proposed');

  const plan = session.governancePlans.get(planId);
  if (!plan) {
    const checkId = `chk_${randomUUID().slice(0, 8)}`;
    const check: GovernanceCheckState = {
      checkId,
      planId,
      governanceContext,
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
      purchaseType,
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
  if (binding === 'proposed' && payload) {
    const { budget: payloadBudget, budgetFieldPath, countries: payloadCountries, channels: payloadChannels, flight: payloadFlight } =
      extractFromPayload(payload);

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

    // Per-type allocation check
    const typeAllocation = plan.budget.allocations?.[purchaseType];
    if (typeAllocation && payloadBudget !== undefined) {
      const typeCommitted = plan.committedByType?.[purchaseType] ?? 0;
      if (typeAllocation.amount !== undefined) {
        const typeRemaining = typeAllocation.amount - typeCommitted;
        if (payloadBudget > typeRemaining) {
          findings.push({
            categoryId: 'budget_authority',
            severity: 'critical',
            explanation: `Requested ${purchaseType} budget $${payloadBudget} exceeds remaining ${purchaseType} allocation $${typeRemaining} (committed: $${typeCommitted} of $${typeAllocation.amount}).`,
          });
        }
      }
      if (typeAllocation.maxPct !== undefined) {
        const maxTypeAmount = plan.budget.total * (typeAllocation.maxPct / 100);
        if (typeCommitted + payloadBudget > maxTypeAmount) {
          findings.push({
            categoryId: 'budget_authority',
            severity: 'critical',
            explanation: `${purchaseType} spend would reach $${typeCommitted + payloadBudget}, exceeding ${typeAllocation.maxPct}% allocation ($${maxTypeAmount}).`,
          });
        }
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

    const pdCountries = plannedDelivery.geo?.countries || [];
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

    const pdChannels = plannedDelivery.channels || [];
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

    const pdBudget = plannedDelivery.total_budget;
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
    const cumulativeSpend = deliveryMetrics.cumulative_spend;
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

    const geoDistribution = deliveryMetrics.geo_distribution;
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
    governanceContext,
    binding,
    status,
    caller,
    tool,
    purchaseType,
    phase,
    findings,
    conditions: conditions.length > 0 ? conditions : undefined,
    escalation: shouldEscalate ? {
      reason: `Budget commitment exceeds 50% of plan total and authority_level is human_required.`,
      action: 'require_human_approval',
    } : undefined,
    explanation,
    mode,
    categoriesEvaluated: [...new Set(categoriesEvaluated)],
    policiesEvaluated: plan.policyIds || [],
    timestamp: now.toISOString(),
    expiresAt,
  };

  session.governanceChecks.set(checkId, check);
  return buildCheckResponse(check);
}

export function handleReportPlanOutcome(args: ToolArgs, ctx: TrainingContext) {
  const req = args as ReportPlanOutcomeInput;
  const session = getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const planId = req.plan_id;
  const checkId = req.check_id;
  const governanceContext = req.governance_context;
  const purchaseType = req.purchase_type || 'media_buy';
  const outcome = req.outcome;
  const sellerResponse = req.seller_response;
  const delivery = req.delivery;

  if (req.purchase_type && !VALID_PURCHASE_TYPES.has(req.purchase_type)) {
    return { errors: [{ code: 'validation_error', message: `Invalid purchase_type: ${req.purchase_type}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
  }

  const plan = session.governancePlans.get(planId);
  if (!plan) {
    return { errors: [{ code: 'not_found', message: `Plan not found: ${planId}` }] };
  }

  let committedBudget = 0;
  const findings: GovernanceFinding[] = [];

  if (outcome === 'completed' && sellerResponse) {
    // Prefer committed_budget when present (canonical); fall back to summing packages
    if (sellerResponse.committed_budget !== undefined) {
      committedBudget = sellerResponse.committed_budget;
    } else if (sellerResponse.packages?.length) {
      committedBudget = sellerResponse.packages.reduce((sum, pkg) => {
        const b = pkg.budget;
        if (typeof b === 'number') return sum + b;
        if (b && typeof b === 'object') return sum + (b.total || 0);
        return sum;
      }, 0);
    }

    plan.committedBudget += committedBudget;
    plan.committedByType = plan.committedByType || {};
    plan.committedByType[purchaseType] = (plan.committedByType[purchaseType] || 0) + committedBudget;

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
    const spend = delivery.spend;
    if (spend) {
      committedBudget = spend;
      plan.committedBudget += spend;
      plan.committedByType = plan.committedByType || {};
      plan.committedByType[purchaseType] = (plan.committedByType[purchaseType] || 0) + spend;
    }
  }

  const outcomeId = `out_${randomUUID().slice(0, 8)}`;
  const outcomeState: GovernanceOutcomeState = {
    outcomeId,
    planId,
    checkId,
    governanceContext,
    purchaseType,
    outcomeType: outcome,
    committedBudget,
    findings,
    timestamp: new Date().toISOString(),
  };

  session.governanceOutcomes.set(outcomeId, outcomeState);

  return {
    outcome_id: outcomeId,
    status: findings.length > 0 ? 'findings' : 'accepted',
    ...(committedBudget > 0 && { committed_budget: committedBudget }),
    ...(findings.length > 0 && {
      findings: findings.map(f => ({
        category_id: f.categoryId,
        severity: f.severity,
        explanation: f.explanation,
      })),
    }),
    ...((outcome === 'completed' || outcome === 'failed') && {
      plan_summary: {
        total_committed: plan.committedBudget,
        budget_remaining: plan.budget.total - plan.committedBudget,
      },
    }),
  };
}

export function handleGetPlanAuditLogs(args: ToolArgs, ctx: TrainingContext) {
  const req = args as GetPlanAuditLogsInput;
  const session = getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const planIds = [...(req.plan_ids || [])];
  const portfolioPlanIds = req.portfolio_plan_ids || [];
  const governanceContextsFilter = req.governance_contexts;
  const includeEntries = req.include_entries || false;

  if (!planIds.length && !portfolioPlanIds.length && !governanceContextsFilter?.length) {
    return { errors: [{ code: 'validation_error', message: 'plan_ids, portfolio_plan_ids, or governance_contexts is required' }] };
  }

  // If filtering by governance_contexts, find the plans they belong to
  if (governanceContextsFilter?.length && !planIds.length) {
    const ctxSet = new Set(governanceContextsFilter);
    for (const [, check] of session.governanceChecks) {
      if (check.governanceContext && ctxSet.has(check.governanceContext) && !planIds.includes(check.planId)) {
        planIds.push(check.planId);
      }
    }
  }

  const results: Array<{
    plan_id: string;
    plan_version: number;
    status: string;
    budget: object;
    channel_allocation: object;
    governed_actions: object;
    summary: object;
    entries?: Array<{ id: string; type: string; timestamp: string; [key: string]: unknown }>;
  }> = [];

  for (const planId of planIds) {
    const plan = session.governancePlans.get(planId);
    if (!plan) continue;

    // Gather checks and outcomes for this plan, optionally filtered by governance context
    const ctxFilter = governanceContextsFilter?.length ? new Set(governanceContextsFilter) : undefined;
    const checks = Array.from(session.governanceChecks.values())
      .filter(c => c.planId === planId && (!ctxFilter || (c.governanceContext && ctxFilter.has(c.governanceContext))));
    const outcomes = Array.from(session.governanceOutcomes.values())
      .filter(o => o.planId === planId && (!ctxFilter || (o.governanceContext && ctxFilter.has(o.governanceContext))));

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

    // Governed actions breakdown (grouped by governance_context)
    const actionMap = new Map<string, { purchase_type: string; status: string; committed: number; checkCount: number }>();
    for (const check of checks) {
      if (check.governanceContext) {
        if (!actionMap.has(check.governanceContext)) {
          actionMap.set(check.governanceContext, { purchase_type: check.purchaseType || 'media_buy', status: 'active', committed: 0, checkCount: 0 });
        }
        actionMap.get(check.governanceContext)!.checkCount++;
      }
    }
    for (const outcome of outcomes) {
      if (outcome.governanceContext) {
        const entry = actionMap.get(outcome.governanceContext);
        if (entry) {
          entry.committed += outcome.committedBudget;
        }
      }
    }

    const governedActions = Array.from(actionMap.entries()).map(([ctx, data]) => ({
      governance_context: ctx,
      purchase_type: data.purchase_type,
      status: data.status,
      committed: data.committed,
      check_count: data.checkCount,
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

    const summary = {
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

    // Build entries array when requested
    let auditEntries: Array<{ id: string; type: string; timestamp: string; [key: string]: unknown }> | undefined;
    if (includeEntries) {
      auditEntries = [];

      for (const check of checks) {
        auditEntries.push({
          id: check.checkId,
          type: 'check',
          timestamp: check.timestamp,
          caller: check.caller,
          tool: check.tool,
          purchase_type: check.purchaseType || 'media_buy',
          ...(check.governanceContext && { governance_context: check.governanceContext }),
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
        auditEntries.push({
          id: outcome.outcomeId,
          type: 'outcome',
          timestamp: outcome.timestamp,
          outcome: outcome.outcomeType,
          committed_budget: outcome.committedBudget,
          ...(outcome.purchaseType && { purchase_type: outcome.purchaseType }),
          ...(outcome.governanceContext && { governance_context: outcome.governanceContext }),
        });
      }

      // Sort by timestamp
      auditEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    results.push({
      plan_id: planId,
      plan_version: plan.version,
      status: plan.status,
      budget,
      channel_allocation: channelAllocation,
      governed_actions: governedActions,
      summary,
      ...(auditEntries && { entries: auditEntries }),
    });
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

function extractFromPayload(payload: CheckPayload): ExtractedFields {
  const budgetInfo = extractBudget(payload);
  return {
    budget: budgetInfo?.amount,
    budgetFieldPath: budgetInfo?.fieldPath ?? 'budget.total',
    countries: payload.geo?.countries || payload.targeting?.countries || payload.countries || payload.campaign?.countries || [],
    channels: extractChannels(payload),
    flight: extractFlight(payload),
  };
}

function extractBudget(payload: CheckPayload): { amount: number; fieldPath: string } | undefined {
  // Try total_budget.amount first, then total_budget as bare number
  if (payload.total_budget !== undefined) {
    if (typeof payload.total_budget === 'number') return { amount: payload.total_budget, fieldPath: 'total_budget' };
    if (payload.total_budget.amount !== undefined) return { amount: payload.total_budget.amount, fieldPath: 'total_budget.amount' };
  }

  // Try budget.total (common simplified format) or budget as number
  if (payload.budget !== undefined) {
    if (typeof payload.budget === 'number') return { amount: payload.budget, fieldPath: 'budget' };
    if (payload.budget.total !== undefined) return { amount: payload.budget.total, fieldPath: 'budget.total' };
  }

  // Sum package budgets
  if (payload.packages?.length) {
    const total = payload.packages.reduce((sum, pkg) => sum + (pkg.budget || 0), 0);
    return { amount: total, fieldPath: 'packages.0.budget' };
  }
  return undefined;
}

function extractChannels(payload: CheckPayload): string[] {
  if (payload.channels) return payload.channels;
  if (payload.channel) return [payload.channel];
  if (payload.packages?.length) {
    const channels = new Set<string>();
    for (const pkg of payload.packages) {
      pkg.channels?.forEach(c => channels.add(c));
    }
    if (channels.size > 0) return [...channels];
  }
  return [];
}

function extractFlight(payload: CheckPayload): { start?: string; end?: string } {
  if (payload.flight) {
    return {
      start: payload.flight.start || payload.flight.start_time,
      end: payload.flight.end || payload.flight.end_time,
    };
  }
  // Brand rights payloads use campaign.start_date/end_date
  if (payload.campaign?.start_date || payload.campaign?.end_date) {
    return { start: payload.campaign.start_date, end: payload.campaign.end_date };
  }
  return { start: payload.start_time, end: payload.end_time };
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

function buildCheckResponse(check: GovernanceCheckState) {
  return {
    check_id: check.checkId,
    status: check.status,
    binding: check.binding,
    plan_id: check.planId,
    explanation: check.explanation,
    mode: check.mode,
    categories_evaluated: check.categoriesEvaluated,
    policies_evaluated: check.policiesEvaluated,
    ...(check.findings.length > 0 && {
      findings: check.findings.map(f => ({
        category_id: f.categoryId,
        severity: f.severity,
        explanation: f.explanation,
        ...(f.policyId && { policy_id: f.policyId }),
        ...(f.confidence !== undefined && { confidence: f.confidence }),
        ...(f.details && { details: f.details }),
      })),
    }),
    ...(check.conditions?.length && {
      conditions: check.conditions.map(c => ({
        field: c.field,
        ...(c.requiredValue !== undefined && { required_value: c.requiredValue }),
        reason: c.reason,
      })),
    }),
    ...(check.escalation && { escalation: check.escalation }),
    ...(check.expiresAt && { expires_at: check.expiresAt }),
    ...(check.phase === 'delivery' && check.status === 'approved' && {
      next_check: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
    ...((check.status === 'approved' || check.status === 'conditions') && {
      governance_context: randomUUID(),
    }),
  };
}
