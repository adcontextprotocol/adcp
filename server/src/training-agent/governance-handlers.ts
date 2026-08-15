/**
 * Governance tool definitions and handlers for the training agent.
 *
 * Implements sync_plans, check_governance, report_plan_outcome,
 * report_plan_adjustment, and get_plan_audit_logs per the AdCP campaign
 * governance schema.
 */

import { randomUUID } from 'node:crypto';
import type {
  TrainingContext,
  ToolArgs,
  GovernancePlanState,
  GovernanceDelegation,
  GovernanceCheckState,
  GovernanceOutcomeState,
  GovernanceAdjustmentState,
  GovernanceAdjustmentType,
  GovernanceFinding,
  GovernanceCondition,
  SessionState,
} from './types.js';
import type { BrandReference } from '@adcp/sdk';
import {
  getSession,
  sessionKeyFromArgs,
  findSessionMatching,
} from './state.js';
import { signGovernanceContext, type GovernancePhase, type PolicyDecision } from './governance-context.js';
import { getCanonicalBase } from './canonical-base.js';
import {
  computeDeliveryStatementDigest,
  computeGovernanceAdjustmentHash,
  computeGovernanceOutcomeHash,
  computeGovernedPayloadHash,
} from './governance-payload-hash.js';

const EXECUTION_GOVERNANCE_PHASES = new Set<GovernancePhase>(['purchase', 'modification', 'delivery']);

/**
 * Map plan-level policy_ids + current check status to per-policy outcomes
 * for the JWS `policy_decisions` claim. The training agent doesn't track
 * per-policy evaluation results separately, so derived outcomes mirror the
 * check status — `denied`/`conditions`/`allowed`. Production governance
 * agents that score each policy independently SHOULD emit the real per-
 * policy outcome here (or `policy_decision_hash` instead — see spec
 * §"Privacy considerations").
 */
function buildPolicyDecisions(
  policyIds: string[],
  status: 'approved' | 'denied' | 'conditions',
  conditions: GovernanceCondition[],
): PolicyDecision[] {
  const outcome: 'allowed' | 'conditions' | 'denied' =
    status === 'approved' ? 'allowed' : status === 'conditions' ? 'conditions' : 'denied';
  const conditionedPolicies = new Set(
    conditions.map(c => (c as { policyId?: string }).policyId).filter((x): x is string => !!x),
  );
  return policyIds.map(id => ({
    policy_id: id,
    outcome: conditionedPolicies.has(id) ? 'conditions' : outcome,
  }));
}

const VALID_PURCHASE_TYPES = new Set(['media_buy', 'rights_license', 'signal_activation', 'creative_services']);
const EXPLICIT_COMMITMENT_TOOLS = new Set([
  'update_media_buy',
  'acquire_rights',
  'update_rights',
  'activate_signal',
  'build_creative',
]);
const VALID_OUTCOME_TYPES = new Set(['completed', 'failed', 'delivery']);
const VALID_ADJUSTMENT_TYPES = new Set<GovernanceAdjustmentType>([
  'decommitment',
  'refund',
  'credit',
  'makegood',
]);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{16,255}$/;

/**
 * `plan_id` is buyer-generated and only unique within that buyer's namespace.
 * Keep the storage key owner-qualified so two authenticated buyers can reuse the
 * same opaque identifier without seeing or overwriting each other's plan state.
 */
function governancePlanStorageKey(ownerAgentUrl: string, planId: string): string {
  return JSON.stringify([ownerAgentUrl, planId]);
}

function findGovernancePlanEntry(
  session: SessionState,
  planId: string,
  ownerAgentUrl?: string,
): [string, GovernancePlanState] | undefined {
  return [...session.governancePlans.entries()].find(([, plan]) =>
    plan.planId === planId
    && (ownerAgentUrl === undefined || plan.ownerAgentUrl === ownerAgentUrl));
}

function findAccessibleGovernancePlan(
  session: SessionState,
  planId: string,
  authenticatedAgentUrl: string,
): GovernancePlanState | undefined {
  return [...session.governancePlans.values()].find(plan =>
    plan.planId === planId
    && (plan.ownerAgentUrl === authenticatedAgentUrl
      || Boolean(plan.delegations?.some(delegation =>
        delegation.agentUrl === authenticatedAgentUrl
        && (!delegation.expiresAt || new Date(delegation.expiresAt) >= new Date())))));
}

// Categories that require human oversight per GDPR Art 22 / EU AI Act Annex III.
// See static/registry/policy-categories/*.json (requires_human_review: true).
// Exported for parity tests against the registry to detect drift.
export const HUMAN_REVIEW_CATEGORIES = new Set([
  'fair_housing',
  'fair_lending',
  'fair_employment',
  'pharmaceutical_advertising',
]);

// Registry policies that carry requires_human_review: true.
// Exported for parity tests.
export const HUMAN_REVIEW_POLICY_IDS = new Set([
  'eu_ai_act_annex_iii',
]);

// Brand industries that commonly fall under Annex III even when a buyer omits policy_categories.
// Surfaced as an advisory finding, not a hard trigger — Annex III attaches to the decision, not the company.
export const HUMAN_REVIEW_INDUSTRIES = new Set([
  'consumer_finance', 'banking', 'mortgage', 'credit',
  'life_insurance', 'health_insurance', 'insurance',
  'recruitment', 'staffing',
  'real_estate', 'property_management', 'housing',
]);

/**
 * Returns the list of reasons a plan requires human review under Art 22 / Annex III.
 * Governance agents MUST set plan.human_review_required = true when this list is non-empty.
 * Buyers cannot opt out by omitting the flag — the cascade is authoritative.
 *
 * Hard triggers: policy_categories, policy_ids, custom_policies. Brand industries are
 * treated separately as an advisory signal (see annexIIIIndustrySignals) — a CPG holding
 * company with industries: ['consumer_finance'] running a corporate-branding campaign
 * shouldn't be force-escalated; Annex III attaches to the decision, not the company.
 */
function resolveHumanReviewTriggers(plan: SyncPlanInput): string[] {
  const triggers: string[] = [];

  for (const cat of plan.policy_categories ?? []) {
    if (HUMAN_REVIEW_CATEGORIES.has(cat)) {
      triggers.push(`policy_category:${cat}`);
    }
  }

  for (const pid of plan.policy_ids ?? []) {
    if (HUMAN_REVIEW_POLICY_IDS.has(pid)) {
      triggers.push(`policy_id:${pid}`);
    }
  }

  for (const cp of plan.custom_policies ?? []) {
    if (cp && typeof cp === 'object' && !Array.isArray(cp) && cp.requires_human_review === true) {
      triggers.push(`custom_policy:${cp.policy_id ?? 'unnamed'}`);
    }
  }

  return triggers;
}

/**
 * Returns brand industries that commonly fall under Annex III but should surface as
 * advisory findings rather than hard auto-flips. A buyer whose brand.industries includes
 * 'consumer_finance' running a non-lending campaign should see the warning and either
 * declare policy_categories explicitly or accept that the governance agent is flagging
 * a potentially relevant regime.
 */
function annexIIIIndustrySignals(plan: SyncPlanInput): string[] {
  const matches: string[] = [];
  for (const industry of plan.brand?.industries ?? []) {
    if (HUMAN_REVIEW_INDUSTRIES.has(industry)) {
      matches.push(industry);
    }
  }
  return matches;
}

/**
 * Capture a snapshot of the current plan state for append-only revision history.
 * Returned value is a minimal diff-friendly shape; not exposed on the wire.
 */
function snapshotRevision(state: GovernancePlanState): GovernancePlanState['revisionHistory'][number] {
  return {
    version: state.version,
    syncedAt: state.syncedAt,
    humanReviewRequired: state.humanReviewRequired,
    humanReviewAutoFlippedBy: state.humanReviewAutoFlippedBy,
    humanOverride: state.humanOverride ? {
      reason: state.humanOverride.reason,
      approver: state.humanOverride.approver,
      approvedAt: state.humanOverride.approvedAt,
    } : undefined,
    mode: state.mode,
    reallocationThreshold: state.budget.reallocationThreshold,
    reallocationUnlimited: state.budget.reallocationUnlimited,
    accountingMode: state.budget.accountingMode,
    policyCategories: state.policyCategories,
    policyIds: state.policyIds,
    planAsSupplied: state.planAsSupplied,
  };
}

interface SyncPlansInput extends ToolArgs {
  plans: SyncPlanInput[];
}

interface SyncPlanInput {
  plan_id: string;
  brand: BrandReference & { industries?: string[]; data_subject_contestation?: { url?: string; email?: string } };
  objectives: string;
  budget: {
    total: number;
    currency: string;
    reallocation_threshold?: number;
    reallocation_unlimited?: boolean;
    per_seller_max_pct?: number;
    allocations?: Record<string, { amount?: number; max_pct?: number }>;
    accounting_mode?: 'gross_commitment' | 'verified_net_cost';
  };
  human_review_required?: boolean;
  flight: { start: string; end: string };
  channels?: { required?: string[]; allowed?: string[]; mix_targets?: Record<string, { min_pct?: number; max_pct?: number }> };
  countries?: string[];
  regions?: string[];
  delegations?: Array<{ agent_url: string; authority: string; budget_limit?: { amount: number; currency: string }; markets?: string[]; expires_at?: string }>;
  approved_sellers?: string[] | null;
  policy_ids?: string[];
  policy_categories?: string[];
  custom_policies?: Array<{
    policy_id?: string;
    policy: string;
    description?: string;
    enforcement?: 'must' | 'should' | 'may';
    requires_human_review?: boolean;
  }>;
  mode?: GovernancePlanState['mode'];
  human_override?: { reason: string; approver: string; approved_at?: string };
}

interface CheckGovernanceInput extends ToolArgs {
  plan_id?: string;
  caller: string;
  target_agent?: string;
  purchase_type?: string;
  proposed_commitment?: { amount: number; currency: string };
  execution_commitment?: { amount: number; currency: string };
  tool?: string;
  payload?: CheckPayload;
  governance_context?: string;
  consultation_context?: string;
  phase?: string;
  governance_phase?: string;
  human_approval?: object;
  planned_delivery?: PlannedDeliveryInput;
  delivery_metrics?: DeliveryMetricsInput;
  modification_summary?: string;
}

interface CheckPayload {
  packages?: Array<{
    package_id?: string;
    budget?: number;
    channels?: string[];
    canceled?: boolean;
  }>;
  new_packages?: Array<{ budget?: number }>;
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
  // An update proposal may name an existing buy. Intent tokens still omit it;
  // execution checks bind their ID from the seller's planned_delivery instead.
  media_buy_id?: string;
  revision?: number;
  ext?: { governance_policy_acknowledgements?: string[] };
}

interface PlannedDeliveryInput {
  // Seller-assigned ID: optional during purchase prepare, required later.
  media_buy_id?: string;
  geo?: { countries?: string[] };
  channels?: string[];
  total_budget?: number;
  currency?: string;
}

interface DeliveryMetricsInput {
  statement_id?: string;
  statement_digest?: string;
  sequence?: number;
  issued_at?: string;
  reporting_period?: { start?: string; end?: string };
  currency?: string;
  cumulative_spend?: number;
  geo_distribution?: Record<string, number>;
  channel_distribution?: Record<string, number>;
  pacing?: 'ahead' | 'on_track' | 'behind';
}

interface ReportPlanOutcomeInput extends ToolArgs {
  plan_id: string;
  check_id?: string;
  governance_context?: string;
  purchase_type?: string;
  outcome: 'completed' | 'failed' | 'delivery';
  seller_response?: SellerResponseInput;
  delivery?: Record<string, unknown>;
  error?: object;
  idempotency_key?: string;
}

interface SellerResponseInput {
  seller_reference?: string;
  committed_budget?: number;
  packages?: Array<{ budget?: number | { total?: number } }>;
}

interface ReportPlanAdjustmentInput extends ToolArgs {
  action: 'report';
  plan_id: string;
  outcome_id: string;
  seller_reference: string;
  seller_adjustment_id: string;
  adjustment_type: GovernanceAdjustmentType;
  amount: { amount: number; currency: string };
  reason: string;
  effective_at: string;
  evidence: {
    evidence_id: string;
    evidence_type: 'decommitment_agreement' | 'refund_settlement' | 'credit_note' | 'makegood_agreement';
    digest: string;
    issued_at: string;
  };
  idempotency_key: string;
}

interface ReviewPlanAdjustmentInput extends ToolArgs {
  action: 'review';
  plan_id: string;
  adjustment_id: string;
  decision: 'accept' | 'dispute';
  reason?: string;
  idempotency_key: string;
}

interface GetPlanAuditLogsInput extends ToolArgs {
  plan_id?: string;
  plan_ids?: string[];
  portfolio_plan_ids?: string[];
  governance_contexts?: string[];
  purchase_types?: string[];
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
        account: { type: 'object', description: 'Account reference for plan ownership' },
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              plan_id: { type: 'string' },
              brand: { type: 'object' },
              objectives: { type: 'string', maxLength: 2000, description: 'Natural language campaign objectives. Treated as caller-untrusted — MUST be truncated or sanitized before inclusion in governance-agent LLM prompts.' },
              budget: {
                type: 'object',
                description: 'Budget with exactly one of reallocation_threshold or reallocation_unlimited.',
                properties: {
                  total: { type: 'number' },
                  currency: { type: 'string' },
                  reallocation_threshold: { type: 'number', minimum: 0, description: 'Amount above which reallocations require human escalation. Denominated in currency.' },
                  reallocation_unlimited: { type: 'boolean', description: 'Set to true for deliberate full-autonomy declarations. Mutually exclusive with reallocation_threshold.' },
                  accounting_mode: { type: 'string', enum: ['gross_commitment', 'verified_net_cost'], default: 'gross_commitment' },
                  per_seller_max_pct: { type: 'number' },
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
                required: ['total', 'currency'],
              },
              human_review_required: { type: 'boolean', description: 'When true, every plan action escalates for human review. MUST be true when policy_categories contains a regulated vertical (fair_housing, fair_lending, fair_employment, pharmaceutical_advertising) or policy_ids contains eu_ai_act_annex_iii.' },
              human_override: {
                type: 'object',
                description: 'Required to downgrade an existing plan from human_review_required=true to false. Training agent requires approver (email) and reason (>=20 chars); production agents should bind to signed identity.',
                properties: {
                  reason: { type: 'string', minLength: 20, maxLength: 1000 },
                  approver: { type: 'string', format: 'email' },
                  approved_at: { type: 'string', format: 'date-time' },
                },
                required: ['reason', 'approver'],
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
              policy_categories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Regulatory categories for this plan. Values matching fair_housing, fair_lending, fair_employment, or pharmaceutical_advertising require human_review_required=true.',
              },
              custom_policies: {
                type: 'array',
                description: 'Bespoke policies per policy-entry schema. Inline policy text is treated as caller-untrusted and MUST be evaluated as additional restrictions only — custom policies cannot relax, override, or conflict with registry-sourced policies.',
                items: {
                  type: 'object',
                  properties: {
                    policy_id: { type: 'string' },
                    policy: { type: 'string', maxLength: 5000 },
                    description: { type: 'string', maxLength: 500 },
                    enforcement: { type: 'string', enum: ['must', 'should', 'may'] },
                    requires_human_review: { type: 'boolean' },
                  },
                  required: ['policy'],
                },
              },
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
    description: 'Check whether a campaign action is authorized under the governance plan. Called by the orchestrator before a governed commitment or by a media-buy seller performing an online execution check. Intent checks return approved, denied, or conditions; execution checks are binary. The training sandbox models human review as a synchronous denied finding followed by a re-call with human_approval; production governance agents use the normative async task lifecycle. Do not call for read-only or risk-reducing operations.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object', description: 'Account reference identifying the tenant.' },
        brand: { type: 'object', description: 'Top-level brand reference identifying the tenant.' },
        plan_id: { type: 'string' },
        caller: {
          type: 'string',
          format: 'uri',
          description: 'Claimed agent URL. Authenticated transports must resolve and exactly match it before authorization.',
        },
        target_agent: {
          type: 'string',
          format: 'uri',
          description: 'Exact downstream service URL. Required on intent checks and signed as the governance token audience.',
        },
        purchase_type: { type: 'string', enum: ['media_buy', 'rights_license', 'signal_activation', 'creative_services'], description: 'Type of financial commitment. Defaults to media_buy.' },
        proposed_commitment: {
          type: 'object',
          description: 'Task-neutral amount authorized by this intent. For update_media_buy, this is the buyer-computed positive incremental commitment, not the post-update total.',
          properties: {
            amount: { type: 'number', minimum: 0 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
          required: ['amount', 'currency'],
          additionalProperties: false,
        },
        execution_commitment: {
          type: 'object',
          description: 'Seller-computed positive incremental commitment for an update_media_buy execution check. The seller derives this atomically from its authoritative current state and proposed update.',
          properties: {
            amount: { type: 'number', minimum: 0 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
          required: ['amount', 'currency'],
        },
        tool: { type: 'string', description: 'The AdCP tool being checked. Present on intent checks (orchestrator).' },
        payload: { type: 'object', description: 'The full tool arguments. Present on intent checks.' },
        governance_context: { type: 'string', description: 'Opaque governance context from a prior check_governance response. Pass on subsequent checks for lifecycle continuity.' },
        consultation_context: { type: 'string', description: 'Non-authorizing handle from an intent conditions response. Pass only on the adjusted intent re-check.' },

        phase: { type: 'string', enum: ['purchase', 'modification', 'delivery'] },
        governance_phase: { type: 'string', enum: ['purchase', 'modification', 'delivery'], description: 'Alias for phase' },
        human_approval: { type: 'object', description: 'Human approval data from escalation flow' },
        planned_delivery: { type: 'object', description: 'What the seller will deliver. Present on execution checks.' },
        delivery_metrics: { type: 'object' },
        modification_summary: { type: 'string' },
      },
      required: ['caller'],
      anyOf: [
        { required: ['plan_id'] },
        { required: ['governance_context'] },
      ],
    },
  },
  {
    name: 'report_plan_outcome',
    description: 'Report the outcome of an action to the governance agent. Called by the orchestrator after a seller responds. Links outcomes to the governance check that authorized them.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object', description: 'Account reference identifying the tenant.' },
        brand: { type: 'object', description: 'Top-level brand reference identifying the tenant.' },
        plan_id: { type: 'string' },
        check_id: { type: 'string' },
        governance_context: { type: 'string', description: 'Opaque governance context from check_governance. Required with check_id for all outcomes. Delivery observations bind to the exact seller delivery statement check.' },
        purchase_type: { type: 'string', enum: ['media_buy', 'rights_license', 'signal_activation', 'creative_services'], description: 'Type of financial commitment. Defaults to media_buy.' },
        idempotency_key: { type: 'string', minLength: 16, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]+$' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'delivery'] },
        seller_response: {
          type: 'object',
          properties: {
            committed_budget: { type: 'number', minimum: 0 },
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: { budget: { type: 'number', minimum: 0 } },
              },
            },
          },
        },
        delivery: {
          type: 'object',
          properties: {
            observation_id: { type: 'string', minLength: 1 },
            source: { type: 'string', enum: ['seller_statement_copy', 'buyer_measurement'] },
            observed_at: { type: 'string', format: 'date-time' },
            reporting_period: {
              type: 'object',
              properties: {
                start: { type: 'string', format: 'date-time' },
                end: { type: 'string', format: 'date-time' },
              },
              required: ['start', 'end'],
            },
            cumulative_spend: { type: 'number', minimum: 0 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            seller_statement_id: { type: 'string' },
            seller_statement_digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
            period_closed: { type: 'boolean', default: false },
          },
          required: ['observation_id', 'source', 'observed_at', 'reporting_period', 'cumulative_spend', 'currency'],
        },
        error: { type: 'object' },
      },
      required: ['plan_id', 'outcome', 'idempotency_key'],
      allOf: [
        {
          if: { properties: { outcome: { const: 'completed' } }, required: ['outcome'] },
          then: { required: ['check_id', 'governance_context', 'seller_response'] },
        },
        {
          if: { properties: { outcome: { const: 'failed' } }, required: ['outcome'] },
          then: { required: ['check_id', 'governance_context', 'error'] },
        },
        {
          if: { properties: { outcome: { const: 'delivery' } }, required: ['outcome'] },
          then: {
            required: ['check_id', 'governance_context', 'delivery'],
          },
        },
      ],
    },
  },
  {
    name: 'report_plan_adjustment',
    description: 'Report a seller adjustment or review it as the authenticated plan owner. Adjustments remain non-authoritative until the buyer accepts them.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'optional' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: { type: 'object', description: 'Account reference identifying the tenant.' },
        brand: { type: 'object', description: 'Top-level brand reference identifying the tenant.' },
        action: { type: 'string', enum: ['report', 'review'] },
        plan_id: { type: 'string' },
        adjustment_id: { type: 'string' },
        decision: { type: 'string', enum: ['accept', 'dispute'] },
        outcome_id: { type: 'string', description: 'Completed outcome whose authoritative commitment is being adjusted.' },
        seller_reference: { type: 'string', maxLength: 255, description: 'Exact seller resource identifier retained on the completed outcome.' },
        seller_adjustment_id: { type: 'string', maxLength: 255, description: 'Seller-unique immutable adjustment record identifier.' },
        adjustment_type: { type: 'string', enum: ['decommitment', 'refund', 'credit', 'makegood'] },
        amount: {
          type: 'object',
          properties: {
            amount: { type: 'number', exclusiveMinimum: 0 },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
          required: ['amount', 'currency'],
        },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
        effective_at: { type: 'string', format: 'date-time' },
        evidence: {
          type: 'object',
          properties: {
            evidence_id: { type: 'string' },
            evidence_type: { type: 'string', enum: ['decommitment_agreement', 'refund_settlement', 'credit_note', 'makegood_agreement'] },
            digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
            issued_at: { type: 'string', format: 'date-time' },
          },
          required: ['evidence_id', 'evidence_type', 'digest', 'issued_at'],
          additionalProperties: false,
        },
        idempotency_key: { type: 'string', minLength: 16, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]+$' },
      },
      required: ['action', 'plan_id', 'idempotency_key'],
      allOf: [
        {
          if: { properties: { action: { const: 'report' } }, required: ['action'] },
          then: { required: ['outcome_id', 'seller_reference', 'seller_adjustment_id', 'adjustment_type', 'amount', 'reason', 'effective_at', 'evidence'] },
        },
        {
          if: { properties: { action: { const: 'review' } }, required: ['action'] },
          then: { required: ['adjustment_id', 'decision'] },
        },
        {
          if: { properties: { action: { const: 'review' }, decision: { const: 'dispute' } }, required: ['action', 'decision'] },
          then: { required: ['reason'] },
        },
      ],
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
        account: { type: 'object', description: 'Account reference identifying the tenant.' },
        brand: { type: 'object', description: 'Top-level brand reference identifying the tenant.' },
        plan_id: { type: 'string', description: 'Single plan ID (convenience alias for plan_ids)' },
        plan_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        portfolio_plan_ids: { type: 'array', items: { type: 'string' } },
        governance_contexts: { type: 'array', items: { type: 'string' }, description: 'Filter audit entries by governance context.' },
        purchase_types: { type: 'array', items: { type: 'string', enum: ['media_buy', 'rights_license', 'signal_activation', 'creative_services'] }, description: 'Filter audit entries by purchase type.' },
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

export async function handleSyncPlans(args: ToolArgs, ctx: TrainingContext) {
  if (!ctx.authenticatedAgentUrl) {
    return { errors: [{ code: 'PERMISSION_DENIED', message: 'sync_plans requires an authenticated buyer agent.' }] };
  }
  const session = await getSession(sessionKeyFromArgs(args, ctx.mode, ctx.userId, ctx.moduleId));
  const input = args as SyncPlansInput;

  if (!input.plans?.length) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'plans array is required' }] };
  }

  const results: Array<{ plan_id: string; status: string; version: number; categories: Array<{ category_id: string; status: string }> }> = [];

  // Validate all plans before mutating session state to keep the operation atomic
  for (let i = 0; i < input.plans.length; i++) {
    const plan = input.plans[i];
    if (!plan.plan_id || !plan.brand || !plan.objectives || !plan.budget || !plan.flight) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan at index ${i} requires plan_id, brand, objectives, budget, and flight` }] };
    }
    if (plan.objectives.length > 2000) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} objectives exceeds 2000 character limit; caller-untrusted free text must be bounded` }] };
    }
    for (let j = 0; j < (plan.custom_policies?.length ?? 0); j++) {
      const cp = plan.custom_policies![j];
      if (typeof cp !== 'object' || cp === null || Array.isArray(cp)) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} custom_policies[${j}] must be an object per policy-entry schema; string form is deprecated` }] };
      }
      if (!cp.policy || typeof cp.policy !== 'string') {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} custom_policies[${j}] requires a policy string` }] };
      }
      if (cp.policy.length > 5000) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} custom_policies[${j}].policy exceeds 5000 character limit` }] };
      }
      if (cp.description != null && (typeof cp.description !== 'string' || cp.description.length > 500)) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} custom_policies[${j}].description must be a string ≤ 500 characters` }] };
      }
    }
    if (typeof plan.budget.total !== 'number' || !plan.budget.currency) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} budget requires total (number) and currency (string)` }] };
    }
    if (plan.budget.accounting_mode !== undefined
      && plan.budget.accounting_mode !== 'gross_commitment'
      && plan.budget.accounting_mode !== 'verified_net_cost') {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} budget.accounting_mode must be gross_commitment or verified_net_cost` }] };
    }
    const hasThreshold = typeof plan.budget.reallocation_threshold === 'number';
    const hasUnlimited = plan.budget.reallocation_unlimited === true;
    if (hasThreshold === hasUnlimited) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} budget must specify exactly one of reallocation_threshold (number >= 0) or reallocation_unlimited (true)` }] };
    }
    if (hasThreshold && plan.budget.reallocation_threshold! < 0) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} budget.reallocation_threshold must be >= 0` }] };
    }
    if (!plan.flight.start || !plan.flight.end) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} flight requires start and end` }] };
    }
    if (plan.budget.allocations) {
      const invalidKeys = Object.keys(plan.budget.allocations).filter(k => !VALID_PURCHASE_TYPES.has(k));
      if (invalidKeys.length > 0) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} budget.allocations has invalid keys: ${invalidKeys.join(', ')}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
      }
    }

    const existingSession = await findSessionMatching(candidate =>
      findGovernancePlanEntry(candidate, plan.plan_id, ctx.authenticatedAgentUrl) !== undefined);
    const existingPlan = existingSession
      ? findGovernancePlanEntry(existingSession, plan.plan_id, ctx.authenticatedAgentUrl)?.[1]
      : undefined;
    if (existingPlan && existingSession !== session) {
      return {
        errors: [{
          code: 'CONFLICT',
          message: `Plan ${plan.plan_id} is already bound to another immutable account or brand scope. Re-sync it using its original scope.`,
        }],
      };
    }

    // Auto-flip human_review_required from triggering policy_categories, policy_ids,
    // custom_policies, brand industries. This is the MUST rule from the obligations doc.
    const resolvedTriggers = resolveHumanReviewTriggers(plan);
    const effectiveHumanReview = plan.human_review_required === true || resolvedTriggers.length > 0;

    // Cross-field schema invariant: if policy_categories contains a regulated vertical,
    // human_review_required MUST be true. Reject explicit false.
    if (plan.human_review_required === false && resolvedTriggers.length > 0) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} declares ${resolvedTriggers.join(', ')} which require human_review_required=true; cannot set false` }] };
    }

    // Revision safety: prior plan with humanReviewRequired=true cannot be downgraded
    // to false on re-sync unless the caller provides a verified human_override artifact.
    const existing = findGovernancePlanEntry(session, plan.plan_id, ctx.authenticatedAgentUrl)?.[1];
    if (existing?.humanReviewRequired && !effectiveHumanReview) {
      if (!plan.human_override) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} previously had human_review_required=true; downgrading requires a human_override artifact` }] };
      }
      const override = plan.human_override;
      if (!override.reason || override.reason.length < 20) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} human_override.reason must be at least 20 characters describing the rationale for downgrade` }] };
      }
      if (!override.approver || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(override.approver)) {
        return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} human_override.approver must be a valid email address. Production governance agents SHOULD bind this to an authenticated identity.` }] };
      }
      if (override.approved_at) {
        const approvedAt = new Date(override.approved_at);
        if (isNaN(approvedAt.getTime())) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} human_override.approved_at must be a valid ISO 8601 timestamp` }] };
        }
        const ageMs = Date.now() - approvedAt.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} human_override.approved_at is older than 24 hours; fresh approval required for each downgrade` }] };
        }
        if (ageMs < -60 * 1000) {
          return { errors: [{ code: 'VALIDATION_ERROR', message: `plan ${plan.plan_id} human_override.approved_at is in the future` }] };
        }
      }
    }
  }

  for (const plan of input.plans) {
    const existing = findGovernancePlanEntry(session, plan.plan_id, ctx.authenticatedAgentUrl)?.[1];
    const version = existing ? existing.version + 1 : 1;

    const resolvedTriggers = resolveHumanReviewTriggers(plan);
    const effectiveHumanReview = plan.human_review_required === true || resolvedTriggers.length > 0;
    const hasUnlimited = plan.budget.reallocation_unlimited === true;
    const reallocationThreshold = hasUnlimited
      ? plan.budget.total
      : (plan.budget.reallocation_threshold as number);

    const syncedAt = new Date().toISOString();

    const planState: GovernancePlanState = {
      planId: plan.plan_id,
      ownerAgentUrl: existing?.ownerAgentUrl ?? ctx.authenticatedAgentUrl,
      version,
      status: 'active',
      brand: plan.brand,
      objectives: plan.objectives,
      budget: {
        total: plan.budget.total,
        currency: plan.budget.currency,
        reallocationThreshold,
        reallocationUnlimited: hasUnlimited,
        accountingMode: plan.budget.accounting_mode ?? 'gross_commitment',
        perSellerMaxPct: plan.budget.per_seller_max_pct,
        allocations: plan.budget.allocations ? Object.fromEntries(
          Object.entries(plan.budget.allocations).map(([k, v]) => [k, { amount: v.amount, maxPct: v.max_pct }]),
        ) : undefined,
      },
      humanReviewRequired: effectiveHumanReview,
      // Union new triggers with prior triggers so re-sync doesn't lose audit history.
      // If caller clears triggers but keeps humanReviewRequired=true (or override blocks
      // the downgrade), we preserve the original reasons for the flip.
      humanReviewAutoFlippedBy: Array.from(new Set([
        ...(existing?.humanReviewAutoFlippedBy ?? []),
        ...resolvedTriggers,
      ])),
      humanOverride: plan.human_override ? {
        reason: plan.human_override.reason,
        approver: plan.human_override.approver,
        approvedAt: plan.human_override.approved_at || syncedAt,
      } : existing?.humanOverride,
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
      policyCategories: plan.policy_categories,
      customPolicies: plan.custom_policies,
      mode: plan.mode || 'enforce',
      committedBudget: existing?.committedBudget ?? 0,
      committedByType: existing?.committedByType ?? {},
      syncedAt,
      revisionHistory: existing
        ? [...existing.revisionHistory, snapshotRevision(existing)]
        : [],
      // Persist the wire-shaped plan verbatim so the `plan_hash` claim in
      // every later `governance_context` JWS is bit-exact to what the buyer
      // sent — buyers can recompute and byte-match without round-tripping
      // through the camelCase internal representation. Deep-clone so
      // downstream code can't accidentally mutate the hash preimage.
      planAsSupplied: structuredClone(plan as unknown) as Record<string, unknown>,
    };

    session.governancePlans.set(
      governancePlanStorageKey(ctx.authenticatedAgentUrl, plan.plan_id),
      planState,
    );

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

export async function handleCheckGovernance(args: ToolArgs, ctx: TrainingContext) {
  const req = args as CheckGovernanceInput;
  let session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const governanceContext = req.governance_context;
  const consultationContext = req.consultation_context;
  let priorCheck = governanceContext
    ? [...session.governanceChecks.values()].find(check => check.governanceContext === governanceContext)
    : undefined;

  if (governanceContext && !priorCheck) {
    const contextSession = await findSessionMatching(candidate =>
      [...candidate.governanceChecks.values()].some(check => check.governanceContext === governanceContext));
    if (contextSession) {
      session = contextSession;
      priorCheck = [...session.governanceChecks.values()].find(check => check.governanceContext === governanceContext);
    }
  }

  let priorConsultationCheck = consultationContext
    ? [...session.governanceChecks.values()].find(check => check.consultationContext === consultationContext)
    : undefined;
  if (consultationContext && !priorConsultationCheck) {
    const consultationSession = await findSessionMatching(candidate =>
      [...candidate.governanceChecks.values()].some(check => check.consultationContext === consultationContext));
    if (consultationSession) {
      session = consultationSession;
      priorConsultationCheck = [...session.governanceChecks.values()]
        .find(check => check.consultationContext === consultationContext);
    }
  }

  const planId = req.plan_id ?? priorCheck?.planId ?? priorConsultationCheck?.planId;
  if (!planId) {
    return { errors: [{ code: 'PLAN_NOT_FOUND', message: 'No plan could be resolved from plan_id or governance_context.' }] };
  }
  if (req.plan_id && priorCheck && req.plan_id !== priorCheck.planId) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'plan_id does not match the governance_context binding.' }] };
  }
  if (req.plan_id && priorConsultationCheck && req.plan_id !== priorConsultationCheck.planId) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'plan_id does not match the consultation_context.' }] };
  }
  // Framework strips `account`, dropping the session to open:default.
  // When the primary lookup misses, scan every session for the plan so
  // sync_plans (which does carry account) remains reachable.
  const contextPlanOwner = priorCheck?.planOwnerAgentUrl ?? priorConsultationCheck?.planOwnerAgentUrl;
  let plan = contextPlanOwner
    ? findGovernancePlanEntry(session, planId, contextPlanOwner)?.[1]
    : ctx.authenticatedAgentUrl
      ? findAccessibleGovernancePlan(session, planId, ctx.authenticatedAgentUrl)
      : undefined;
  if (planId && !plan && ctx.authenticatedAgentUrl) {
    const fallback = await findSessionMatching(candidate => {
      return contextPlanOwner
        ? findGovernancePlanEntry(candidate, planId, contextPlanOwner) !== undefined
        : findAccessibleGovernancePlan(candidate, planId, ctx.authenticatedAgentUrl!) !== undefined;
    });
    if (fallback) {
      session = fallback;
      plan = contextPlanOwner
        ? findGovernancePlanEntry(fallback, planId, contextPlanOwner)?.[1]
        : findAccessibleGovernancePlan(fallback, planId, ctx.authenticatedAgentUrl);
    }
  }
  const claimedCaller = req.caller;
  const authenticatedCaller = ctx.authenticatedAgentUrl;
  // Authorization, audit, and signed state consume the server-resolved URL.
  // The request field is only an assertion to cross-check.
  const caller = authenticatedCaller ?? claimedCaller;
  const purchaseType = req.purchase_type || 'media_buy';
  const tool = req.tool;
  const payload = req.payload;
  const authenticatedPrincipal = ctx.principal ?? 'anonymous';
  const ext = (req as unknown as { ext?: unknown }).ext;
  const extHumanApproval = ext && typeof ext === 'object' && !Array.isArray(ext)
    ? (ext as { human_approval?: unknown }).human_approval
    : undefined;
  const humanApproval = req.human_approval ?? extHumanApproval;
  const hasHumanApproval = typeof humanApproval === 'object' && humanApproval !== null;
  const plannedDelivery = req.planned_delivery;
  const deliveryMetrics = req.delivery_metrics;

  if (req.purchase_type && !VALID_PURCHASE_TYPES.has(req.purchase_type)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid purchase_type: ${req.purchase_type}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
  }

  if (
    plannedDelivery?.total_budget !== undefined
    && (
      typeof plannedDelivery.total_budget !== 'number'
      || !Number.isFinite(plannedDelivery.total_budget)
      || plannedDelivery.total_budget < 0
    )
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'planned_delivery.total_budget must be a finite, non-negative number.',
      }],
    };
  }

  if (authenticatedCaller !== undefined && claimedCaller !== authenticatedCaller) {
    return {
      errors: [{
        code: 'PERMISSION_DENIED',
        message: 'Authenticated agent identity is required and must match caller for this governance check.',
      }],
    };
  }

  // Request shape is authoritative. A caller-supplied phase cannot turn an
  // orchestrator proposal into a seller execution check.
  const hasIntentShape = tool !== undefined && payload !== undefined;
  const hasExecutionShape = plannedDelivery !== undefined || deliveryMetrics !== undefined;
  if ((tool === undefined) !== (payload === undefined)) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'Intent governance checks require tool and payload together.',
      }],
    };
  }
  if (hasIntentShape && !req.target_agent) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'target_agent is required for intent governance checks.' }],
    };
  }
  if (req.proposed_commitment !== undefined && !hasIntentShape) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'proposed_commitment is valid only on an intent check with tool and payload.',
      }],
    };
  }
  if (req.execution_commitment !== undefined && !hasExecutionShape) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'execution_commitment is valid only on an execution check.',
      }],
    };
  }
  const binding: 'proposed' | 'committed' = hasIntentShape
    ? 'proposed'
    : hasExecutionShape
      ? 'committed'
      : 'proposed';
  const requestedExecutionPhase: GovernancePhase = EXECUTION_GOVERNANCE_PHASES.has(req.phase as GovernancePhase)
    ? (req.phase as GovernancePhase)
    : EXECUTION_GOVERNANCE_PHASES.has(req.governance_phase as GovernancePhase)
      ? (req.governance_phase as GovernancePhase)
      : 'purchase';
  const phase: GovernancePhase = binding === 'proposed' ? 'intent' : requestedExecutionPhase;
  const targetAudience = binding === 'committed'
    ? priorCheck?.targetAudience ?? ''
    : req.target_agent ?? '';

  if (consultationContext && !priorConsultationCheck) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'consultation_context is unknown or expired.' }],
    };
  }

  if (priorConsultationCheck && (
    priorConsultationCheck.consultationPrincipal !== authenticatedPrincipal
    || priorConsultationCheck.caller !== caller
    || priorConsultationCheck.tool !== tool
    || priorConsultationCheck.purchaseType !== purchaseType
    || priorConsultationCheck.consultationAudience !== targetAudience
  )) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'consultation_context does not match the authenticated principal, caller, tool, purchase type, or target audience.',
      }],
    };
  }

  if (binding === 'proposed' && governanceContext) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'Intent checks use plan_id and must not include governance_context' }],
    };
  }

  if (binding === 'committed' && consultationContext) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'consultation_context is not valid for execution governance checks' }],
    };
  }

  if (binding === 'committed' && !governanceContext) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'governance_context is required for execution governance checks' }],
    };
  }

  if (binding === 'committed' && !priorCheck) {
    return {
      errors: [{ code: 'VALIDATION_ERROR', message: 'governance_context is unknown or expired.' }],
    };
  }

  if (
    binding === 'committed'
    && (
      !priorCheck?.expiresAt
      || !Number.isFinite(Date.parse(priorCheck.expiresAt))
      || Date.parse(priorCheck.expiresAt) <= Date.now()
    )
  ) {
    return {
      errors: [{ code: 'PERMISSION_DENIED', message: 'governance_context is expired; obtain a fresh intent approval.' }],
    };
  }

  if (
    binding === 'committed'
    && (
      !priorCheck?.targetAudience
      || authenticatedCaller === undefined
      || authenticatedCaller !== priorCheck.targetAudience
      || claimedCaller !== priorCheck.targetAudience
    )
  ) {
    return {
      errors: [{
        code: 'PERMISSION_DENIED',
        message: 'Execution governance caller must authenticate as the service audience bound by the prior approved context.',
      }],
    };
  }

  if (
    binding === 'committed'
    && (phase === 'modification' || phase === 'delivery')
    && !plannedDelivery?.media_buy_id
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: `planned_delivery.media_buy_id is required for ${phase} governance checks`,
      }],
    };
  }

  let deliveryStatement: GovernanceCheckState['deliveryStatement'];
  if (phase === 'delivery') {
    if (!deliveryMetrics || !plannedDelivery?.media_buy_id) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: 'Delivery checks require planned_delivery and delivery_metrics.' }] };
    }
    if (
      typeof deliveryMetrics.statement_id !== 'string'
      || deliveryMetrics.statement_id.length === 0
      || !Number.isInteger(deliveryMetrics.sequence)
      || (deliveryMetrics.sequence ?? 0) < 1
      || typeof deliveryMetrics.issued_at !== 'string'
      || Number.isNaN(Date.parse(deliveryMetrics.issued_at))
      || typeof deliveryMetrics.reporting_period?.start !== 'string'
      || typeof deliveryMetrics.reporting_period?.end !== 'string'
      || Number.isNaN(Date.parse(deliveryMetrics.reporting_period.start))
      || Number.isNaN(Date.parse(deliveryMetrics.reporting_period.end))
      || typeof deliveryMetrics.cumulative_spend !== 'number'
      || !Number.isFinite(deliveryMetrics.cumulative_spend)
      || deliveryMetrics.cumulative_spend < 0
      || typeof deliveryMetrics.currency !== 'string'
      || !/^[A-Z]{3}$/.test(deliveryMetrics.currency)
      || typeof deliveryMetrics.statement_digest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(deliveryMetrics.statement_digest)
    ) {
      return {
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'Delivery metrics require a valid statement_id, sequence, issued_at, reporting_period, cumulative_spend, currency, and statement_digest.',
        }],
      };
    }
    if (deliveryMetrics.currency !== plan?.budget.currency) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: 'Delivery statement currency must match the plan currency.' }] };
    }
    let expectedDigest: string;
    try {
      expectedDigest = computeDeliveryStatementDigest(
        plannedDelivery.media_buy_id,
        deliveryMetrics as unknown as Record<string, unknown>,
      );
    } catch {
      return { errors: [{ code: 'VALIDATION_ERROR', message: 'Delivery statement must contain only finite canonical JSON values.' }] };
    }
    if (deliveryMetrics.statement_digest !== expectedDigest) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: 'delivery_metrics.statement_digest does not match the canonical delivery statement.' }] };
    }
    const statementSequence = deliveryMetrics.sequence as number;
    let priorStatement = [...session.governanceChecks.values()].find(check =>
      check.deliveryStatement?.statementId === deliveryMetrics.statement_id
      && check.targetAudience === authenticatedCaller);
    if (!priorStatement) {
      const priorSession = await findSessionMatching(candidate =>
        [...candidate.governanceChecks.values()].some(check =>
          check.deliveryStatement?.statementId === deliveryMetrics.statement_id
          && check.targetAudience === authenticatedCaller));
      priorStatement = priorSession
        ? [...priorSession.governanceChecks.values()].find(check =>
          check.deliveryStatement?.statementId === deliveryMetrics.statement_id
          && check.targetAudience === authenticatedCaller)
        : undefined;
    }
    if (priorStatement) {
      if (
        priorStatement.deliveryStatement?.statementDigest !== deliveryMetrics.statement_digest
        || priorStatement.governanceBindingId !== priorCheck?.governanceBindingId
      ) {
        return { errors: [{ code: 'CONFLICT', message: 'The seller reused statement_id for a different governed action or delivery statement.' }] };
      }
      return buildCheckResponse(priorStatement);
    }
    const periodAlreadyClosed = [...session.governanceOutcomes.values()].some(outcome => {
      const outcomePeriod = (outcome.delivery as {
        reporting_period?: { start?: unknown; end?: unknown };
      } | undefined)?.reporting_period;
      return outcome.governanceBindingId === priorCheck?.governanceBindingId
        && outcome.deliveryPeriodState === 'closed'
        && outcomePeriod?.start === deliveryMetrics.reporting_period?.start
        && outcomePeriod?.end === deliveryMetrics.reporting_period?.end;
    });
    if (periodAlreadyClosed) {
      return { errors: [{ code: 'CONFLICT', message: 'The governance reporting period is closed and cannot accept a new seller statement.' }] };
    }
    const latestSequence = [...session.governanceChecks.values()]
      .filter(check =>
        check.governanceBindingId === priorCheck?.governanceBindingId
        && check.deliveryStatement)
      .reduce((max, check) => Math.max(max, check.deliveryStatement?.sequence ?? 0), 0);
    if (statementSequence <= latestSequence) {
      return { errors: [{ code: 'CONFLICT', message: 'Delivery statement sequence must increase monotonically for the governed action.' }] };
    }
    deliveryStatement = {
      statementId: deliveryMetrics.statement_id,
      statementDigest: deliveryMetrics.statement_digest,
      sequence: statementSequence,
      issuedAt: deliveryMetrics.issued_at,
      sellerReference: plannedDelivery.media_buy_id,
      cumulativeSpend: deliveryMetrics.cumulative_spend,
      currency: deliveryMetrics.currency,
      reportingPeriod: {
        start: deliveryMetrics.reporting_period.start,
        end: deliveryMetrics.reporting_period.end,
      },
      canonicalPayload: {
        seller_reference: plannedDelivery.media_buy_id,
        delivery_metrics: structuredClone(deliveryMetrics) as unknown as Record<string, unknown>,
      },
    };
  }

  if (binding === 'proposed' && authenticatedCaller === undefined) {
    return {
      errors: [{ code: 'PERMISSION_DENIED', message: 'Intent governance checks require an authenticated buyer agent.' }],
    };
  }

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

  const ownerOrDelegated = authenticatedCaller === plan.ownerAgentUrl
    || Boolean(plan.delegations?.some(delegation =>
      delegation.agentUrl === authenticatedCaller
      && (!delegation.expiresAt || new Date(delegation.expiresAt) >= new Date())));
  if (binding === 'proposed' && !ownerOrDelegated) {
    return {
      errors: [{ code: 'PERMISSION_DENIED', message: 'The authenticated buyer does not own this plan and has no active delegation.' }],
    };
  }

  const originalIntentCheck = priorCheck?.binding === 'proposed'
    ? priorCheck
    : priorCheck?.governanceBindingId
      ? [...session.governanceChecks.values()].reverse().find(check =>
        check.status === 'approved'
        && check.binding === 'proposed'
        && check.governanceBindingId === priorCheck?.governanceBindingId)
      : undefined;

  if (req.proposed_commitment && (
    !Number.isFinite(req.proposed_commitment.amount)
    || req.proposed_commitment.amount < 0
    || req.proposed_commitment.currency !== plan.budget.currency
  )) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: `proposed_commitment must be finite, non-negative, and denominated in ${plan.budget.currency}.`,
      }],
    };
  }

  const payloadCommitment = payload ? extractBudget(payload)?.amount : undefined;
  if (
    payloadCommitment !== undefined
    && (!Number.isFinite(payloadCommitment) || payloadCommitment < 0)
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'The numeric commitment carried by payload must be finite and non-negative.',
      }],
    };
  }
  if (
    binding === 'proposed'
    && tool !== undefined
    && EXPLICIT_COMMITMENT_TOOLS.has(tool)
    && req.proposed_commitment === undefined
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: `proposed_commitment is required for ${tool}. For updates, send the positive incremental commitment; use amount 0 for a verified no-cost or non-increasing action.`,
      }],
    };
  }
  if (
    req.proposed_commitment
    && payloadCommitment !== undefined
    && tool !== 'update_media_buy'
    && req.proposed_commitment.amount !== payloadCommitment
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'proposed_commitment.amount must equal the numeric commitment carried by payload.',
      }],
    };
  }
  if (req.execution_commitment && (
    !Number.isFinite(req.execution_commitment.amount)
    || req.execution_commitment.amount < 0
    || req.execution_commitment.currency !== plan.budget.currency
  )) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: `execution_commitment must be finite, non-negative, and denominated in ${plan.budget.currency}.`,
      }],
    };
  }
  if (
    binding === 'committed'
    && originalIntentCheck?.tool === 'update_media_buy'
    && req.execution_commitment === undefined
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'execution_commitment is required when executing an update_media_buy intent.',
      }],
    };
  }
  if (
    binding === 'committed'
    && originalIntentCheck?.tool !== 'update_media_buy'
    && req.execution_commitment !== undefined
  ) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'execution_commitment is valid only when executing an update_media_buy intent.',
      }],
    };
  }

  const findings: GovernanceFinding[] = [];
  const conditions: GovernanceCondition[] = [];
  const categoriesEvaluated: string[] = [];
  // When a human must approve before the action can proceed, the training agent
  // records a critical human_review finding and denies the check. Human approval
  // is resolved off-protocol; the buyer then calls check_governance again with
  // human_approval in the request, which clears this branch.
  let humanReviewRequired = false;
  let humanReviewReason: string | null = null;

  // Annex III / Art 22 contestation-endpoint check.
  // When human review is required, the brand MUST expose data_subject_contestation
  // (on brand.json or inline on the plan's brand ref). Missing = critical finding.
  if (plan.humanReviewRequired) {
    categoriesEvaluated.push('data_subject_contestation');
    const brand = plan.brand as BrandReference & { data_subject_contestation?: { url?: string; email?: string } };
    const contestation = brand?.data_subject_contestation;
    if (!contestation || (!contestation.url && !contestation.email)) {
      findings.push({
        categoryId: 'data_subject_contestation',
        severity: 'critical',
        explanation: 'Plan requires human review (Annex III / Art 22) but brand does not expose data_subject_contestation. Art 22(3) requires a discoverable contact point for the data subject to request human intervention, express their view, and contest the decision. Set brand.data_subject_contestation in brand.json.',
      });
    }
  }

  // Advisory finding when brand.industries suggest Annex III but the plan did not
  // declare a triggering policy_category / policy_id. Buyers running a corporate
  // branding campaign on a regulated-industry brand see this and decide whether
  // to set policy_categories explicitly.
  if (!plan.humanReviewRequired) {
    const industryPlan = { brand: plan.brand } as SyncPlanInput;
    const signals = annexIIIIndustrySignals(industryPlan);
    if (signals.length > 0) {
      categoriesEvaluated.push('annex_iii_industry_advisory');
      findings.push({
        categoryId: 'annex_iii_industry_advisory',
        severity: 'warning',
        explanation: `brand.industries includes ${signals.join(', ')} — sectors commonly regulated under GDPR Art 22 / EU AI Act Annex III. If this campaign makes targeting decisions affecting credit, insurance pricing, recruitment, or housing access, set plan.policy_categories explicitly to trigger human_review_required. This is informational; the plan proceeds.`,
      });
    }
  }

  // Delegation authority check
  categoriesEvaluated.push('delegation_authority');
  let callerDelegation: GovernanceDelegation | undefined;
  const authorityCaller = binding === 'committed' ? originalIntentCheck?.caller : authenticatedCaller;
  if (authorityCaller !== plan.ownerAgentUrl) {
    // Delegations authorize the buyer-side principal that proposed the action.
    // A seller proving it is the token audience must not also need to appear in
    // the buyer's delegation list.
    callerDelegation = plan.delegations?.find(d => d.agentUrl === authorityCaller);
    if (!callerDelegation) {
      findings.push({
        categoryId: 'delegation_authority',
        severity: 'critical',
        explanation: `Buyer-side caller ${authorityCaller ?? '(unresolved)'} is not in the plan's delegations list.`,
      });
    } else if (callerDelegation.expiresAt && new Date(callerDelegation.expiresAt) < new Date()) {
      findings.push({
        categoryId: 'delegation_authority',
        severity: 'critical',
        explanation: `Delegation for ${authorityCaller} expired at ${callerDelegation.expiresAt}.`,
      });
    }
  }

  // Approved sellers check
  if (plan.approvedSellers !== undefined && plan.approvedSellers !== null) {
    categoriesEvaluated.push('seller_compliance');
    const sellerIdentity = binding === 'committed' ? authenticatedCaller! : targetAudience;
    if (!plan.approvedSellers.includes(sellerIdentity)) {
      findings.push({
        categoryId: 'seller_compliance',
        severity: 'critical',
        explanation: `Target seller ${sellerIdentity} is not in the plan's approved sellers list.`,
      });
    }
  }

  // Proposed binding: validate payload against plan.
  // Delegation budget/market limits are checked here because the proposed payload
  // contains the budget and countries. For committed binding, planned_delivery
  // validation handles these constraints instead.
  if (binding === 'proposed' && payload) {
    const extracted = extractFromPayload(payload);
    const payloadBudget = req.proposed_commitment?.amount ?? payloadCommitment;
    const budgetFieldPath = req.proposed_commitment
      ? 'proposed_commitment.amount'
      : tool === 'update_media_buy'
        ? 'payload.incremental_commit_delta'
        : `payload.${extracted.budgetFieldPath}`;
    const { countries: payloadCountries, channels: payloadChannels, flight: payloadFlight } = extracted;

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

      // Commitment exceeds the reallocation threshold — requires human approval.
      if (payloadBudget > plan.budget.reallocationThreshold && !hasHumanApproval) {
        humanReviewRequired = true;
        humanReviewReason =
          `Budget commitment exceeds reallocation_threshold of $${plan.budget.reallocationThreshold}.`;
      }
    }

    // Plan-level human review (Annex III / Art 22) — every action needs human approval regardless of spend.
    if (plan.humanReviewRequired && !hasHumanApproval) {
      humanReviewRequired = true;
      humanReviewReason =
        'Plan has human_review_required = true; every action requires human approval.';
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

  // Custom policies declared on the plan with `must` enforcement become intent
  // counterproposals. The buyer adjusts and re-checks; conditions never produce
  // a governance_context or authorize downstream execution.
  if (binding === 'proposed' && plan.customPolicies?.length) {
    categoriesEvaluated.push('custom_policy');
    for (const cp of plan.customPolicies) {
      if (cp.enforcement === 'may') continue;
      const isBinding = cp.enforcement === 'must' || cp.enforcement === undefined;
      const acknowledgements = payload?.ext?.governance_policy_acknowledgements ?? [];
      const acknowledged = cp.policy_id ? acknowledgements.includes(cp.policy_id) : false;
      if (isBinding && !acknowledged) {
        conditions.push({
          field: 'payload.ext.governance_policy_acknowledgements',
          ...(cp.policy_id ? { requiredValue: [...new Set([...acknowledgements, cp.policy_id])] } : {}),
          reason: cp.policy,
        });
      }
      findings.push({
        categoryId: 'custom_policy',
        severity: isBinding && !acknowledged ? 'warning' : 'info',
        explanation: cp.policy,
        ...(cp.policy_id && { policyId: cp.policy_id }),
      });
    }
  }

  const consultationAttempts = conditions.length > 0
    ? (priorConsultationCheck?.consultationAttempts ?? 0) + 1
    : 0;
  if (binding === 'proposed' && conditions.length > 0 && consultationAttempts >= 3) {
    findings.push({
      categoryId: 'consultation_retry_limit',
      severity: 'critical',
      explanation: 'Intent conditions remained unresolved after 3 consultation attempts.',
    });
  }

  let executionCommitment: number | undefined;

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
    // A delivery check reports evidence about an already-authorized
    // commitment. Treating planned_delivery.total_budget as a fresh
    // commitment here would charge the same media buy against the plan twice.
    executionCommitment = phase === 'delivery'
      ? undefined
      : originalIntentCheck?.tool === 'update_media_buy'
        ? req.execution_commitment?.amount
        : pdBudget;
    if (executionCommitment !== undefined) {
      categoriesEvaluated.push('budget_authority');
      const intentCurrency = originalIntentCheck?.authorizedCurrency;
      if (
        intentCurrency === undefined
        || plannedDelivery.currency !== intentCurrency
        || plannedDelivery.currency !== plan.budget.currency
      ) {
        findings.push({
          categoryId: 'budget_authority',
          severity: 'critical',
          explanation: intentCurrency === undefined
            ? 'The prior intent did not authorize a commitment currency; a fresh intent approval is required.'
            : `Planned delivery currency ${plannedDelivery.currency ?? '(missing)'} must match both intent currency ${intentCurrency} and current plan currency ${plan.budget.currency}.`,
        });
      }
      if (
        originalIntentCheck?.authorizedBudget === undefined
        || executionCommitment > originalIntentCheck.authorizedBudget
      ) {
        findings.push({
          categoryId: 'budget_authority',
          severity: 'critical',
          explanation: originalIntentCheck?.authorizedBudget === undefined
            ? 'The prior intent did not authorize a numeric commitment; a fresh intent approval is required.'
            : `Seller-computed execution commitment $${executionCommitment} exceeds intent-authorized commitment $${originalIntentCheck.authorizedBudget}; a fresh intent approval is required.`,
        });
      }
      const remaining = plan.budget.total - plan.committedBudget;
      if (executionCommitment > remaining) {
        findings.push({
          categoryId: 'budget_authority',
          severity: 'critical',
          explanation: `Planned delivery commitment $${executionCommitment} exceeds remaining $${remaining}.`,
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

    const pacing = deliveryMetrics.pacing;
    if (pacing === 'ahead' || pacing === 'behind') {
      findings.push({
        categoryId: 'delivery_pacing',
        severity: 'warning',
        explanation: `Pacing reported as ${pacing} — line items are drifting from the planned schedule.`,
        confidence: 0.85,
      });
    }

    const channelDistribution = deliveryMetrics.channel_distribution;
    if (channelDistribution) {
      const overweight: string[] = [];
      for (const [channel, pct] of Object.entries(channelDistribution)) {
        if (pct >= 60) overweight.push(`${channel} at ${pct}%`);
      }
      if (overweight.length > 0) {
        findings.push({
          categoryId: 'delivery_pacing',
          severity: 'warning',
          explanation: `Channel mix concentrated: ${overweight.join(', ')}. Re-evaluate against plan reallocation threshold.`,
          confidence: 0.8,
        });
      }
    }
  }

  // Human review required → add a critical finding so the derived status is 'denied'.
  // AdCP v3 has three terminal statuses (approved|denied|conditions). Human review is
  // signalled via a critical finding that the buyer resolves off-protocol, then retries
  // the check with the human's approval.
  if (humanReviewRequired) {
    categoriesEvaluated.push('human_review');
    findings.push({
      categoryId: 'human_review',
      severity: 'critical',
      explanation:
        (humanReviewReason ?? 'Action requires human approval.') +
        ' Resolve off-protocol and re-call check_governance with human_approval.',
    });
  }

  const criticalFindings = findings.filter(f => f.severity === 'critical');
  let status: GovernanceCheckState['status'];

  if (criticalFindings.length > 0) {
    status = 'denied';
  } else if (conditions.length > 0) {
    status = 'conditions';
  } else {
    status = 'approved';
  }

  // Conditions are an intent counterproposal, never an execution verdict.
  if (binding === 'committed' && status === 'conditions') {
    status = 'denied';
  }

  // Apply governance mode — but mode CANNOT neuter human_review_required.
  // Annex III / Art 22 obligations override advisory/audit downgrades.
  const mode = plan.mode;
  if (!plan.humanReviewRequired) {
    if (mode === 'advisory' && (status === 'denied' || status === 'conditions')) {
      status = 'approved';
    } else if (mode === 'audit') {
      status = 'approved';
    }
  } else if (mode !== 'enforce') {
    // In advisory/audit mode on a human-review plan, note that mode downgrade was suppressed.
    categoriesEvaluated.push('human_review_override');
    findings.push({
      categoryId: 'human_review_override',
      severity: 'info',
      explanation: `plan.mode is '${mode}' but plan.human_review_required=true — mode downgrades are disabled for Annex III / Art 22 plans. Action remains '${status}'.`,
    });
  }

  const now = new Date();
  const expiresAt = status === 'approved'
    ? new Date(now.getTime() + (binding === 'proposed'
      ? 15 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000)).toISOString()
    : undefined;

  const explanation = buildExplanation(status, findings, conditions, humanReviewRequired);

  const checkId = `chk_${randomUUID().slice(0, 8)}`;
  let authorizedPayloadHash = originalIntentCheck?.authorizedPayloadHash;
  if (binding === 'proposed' && tool && payload) {
    try {
      authorizedPayloadHash = computeGovernedPayloadHash(payload as Record<string, unknown>);
    } catch {
      return {
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'The governed task payload must be finite canonical JSON.',
        }],
      };
    }
  }
  const authorizedTask = tool ?? originalIntentCheck?.tool;
  const evaluatedBudget = binding === 'committed'
    ? executionCommitment
    : req.proposed_commitment?.amount
      ?? payloadCommitment;
  const authorizedBudget = typeof evaluatedBudget === 'number'
    && Number.isFinite(evaluatedBudget)
    && evaluatedBudget >= 0
    ? evaluatedBudget
    : undefined;
  const authorizedCurrency = authorizedBudget === undefined
    ? undefined
    : binding === 'committed'
      ? originalIntentCheck?.authorizedCurrency
      : plan.budget.currency;

  // Emit a compact JWS `governance_context` only on approved outcomes; the
  // spec requires a fresh signature on
  // every check (new jti, iat, exp, plan_hash) — never re-emit a cached
  // string across plan revisions. Denied checks carry no token; downstream
  // sellers reject a request that has no signed authorization.
  //
  // `aud` resolution is explicit and role-neutral. target_agent is routing
  // metadata on check_governance, while payload remains byte-for-byte equal
  // to the downstream task arguments whose canonical hash is signed.
  //
  // Token phase follows the already-inferred request binding. Intent checks
  // never carry a media_buy_id, even if the proposed payload happens to name
  // an existing buy. Execution checks preserve the seller's lifecycle phase
  // and bind the seller-assigned media_buy_id when supplied.
  let effectiveContext: string | undefined;
  const governanceBindingId = priorCheck?.governanceBindingId ?? `gb_${randomUUID()}`;
  if (status === 'approved') {
    const requestMediaBuyId = binding === 'committed'
      ? plannedDelivery?.media_buy_id
      : undefined;

    effectiveContext = await signGovernanceContext({
      issuer: `${getCanonicalBase()}/governance`,
      audience: targetAudience,
      bindingId: governanceBindingId,
      phase,
      caller,
      checkId,
      ...(phase !== 'intent' && requestMediaBuyId ? { mediaBuyId: requestMediaBuyId } : {}),
      ...(authorizedBudget !== undefined && authorizedCurrency !== undefined ? {
        authorizedCommitment: { amount: authorizedBudget, currency: authorizedCurrency },
      } : {}),
      ...(authorizedTask ? { authorizedTask } : {}),
      ...(authorizedPayloadHash ? { authorizedPayloadHash } : {}),
      plan: plan.planAsSupplied,
      ...(plan.policyIds?.length
        ? { policyDecisions: buildPolicyDecisions(plan.policyIds, status, []) }
        : {}),
    });
  }
  const check: GovernanceCheckState = {
    checkId,
    planId,
    planOwnerAgentUrl: plan.ownerAgentUrl,
    ...(status === 'approved' ? { governanceBindingId } : {}),
    ...(status === 'conditions' ? {
      consultationContext: priorConsultationCheck?.consultationContext ?? `consult_${randomUUID()}`,
      consultationAttempts,
      consultationPrincipal: authenticatedPrincipal,
      consultationAudience: targetAudience,
    } : {}),
    governanceContext: effectiveContext,
    binding,
    status,
    caller,
    tool: authorizedTask,
    ...(authorizedPayloadHash ? { authorizedPayloadHash } : {}),
    purchaseType,
    ...(status === 'approved' && authorizedBudget !== undefined ? { authorizedBudget } : {}),
    ...(status === 'approved' && authorizedCurrency !== undefined
      ? { authorizedCurrency }
      : {}),
    phase,
    targetAudience,
    findings,
    conditions: status === 'conditions' && conditions.length > 0 ? conditions : undefined,
    explanation,
    mode,
    categoriesEvaluated: [...new Set(categoriesEvaluated)],
    policiesEvaluated: plan.policyIds || [],
    timestamp: now.toISOString(),
    expiresAt,
    ...(deliveryStatement ? { deliveryStatement } : {}),
  };

  session.governanceChecks.set(checkId, check);
  return buildCheckResponse(check);
}

export async function handleReportPlanOutcome(args: ToolArgs, ctx: TrainingContext) {
  const req = args as ReportPlanOutcomeInput;
  let session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const planId = req.plan_id;
  const checkId = req.check_id;
  const governanceContext = req.governance_context;
  const purchaseType = req.purchase_type || 'media_buy';
  const outcome = req.outcome;
  const sellerResponse = req.seller_response;
  const delivery = req.delivery;

  if (!VALID_OUTCOME_TYPES.has(outcome)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'outcome must be completed, failed, or delivery.' }] };
  }
  if (req.purchase_type && !VALID_PURCHASE_TYPES.has(req.purchase_type)) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid purchase_type: ${req.purchase_type}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
  }
  if (typeof req.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(req.idempotency_key)) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'idempotency_key is required and must match ^[A-Za-z0-9_.:-]{16,255}$.',
      }],
    };
  }
  if (outcome === 'completed' && !sellerResponse) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'seller_response is required for a completed outcome.' }] };
  }
  if (outcome === 'failed' && !req.error) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'error is required for a failed outcome.' }] };
  }
  if (outcome === 'delivery' && !delivery) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'delivery is required for a delivery outcome.' }] };
  }
  if (outcome === 'delivery' && (!checkId || !governanceContext)) {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'A buyer delivery observation must identify the seller delivery check with check_id and governance_context.',
      }],
    };
  }
  if (outcome === 'delivery') {
    const observation = delivery as {
      observation_id?: unknown;
      source?: unknown;
      observed_at?: unknown;
      cumulative_spend?: unknown;
      currency?: unknown;
      reporting_period?: { start?: unknown; end?: unknown };
      seller_statement_id?: unknown;
      seller_statement_digest?: unknown;
      period_closed?: unknown;
    };
    const validSource = observation.source === 'seller_statement_copy'
      || observation.source === 'buyer_measurement';
    if (
      typeof observation.observation_id !== 'string'
      || observation.observation_id.length === 0
      || !validSource
      || typeof observation.observed_at !== 'string'
      || Number.isNaN(Date.parse(observation.observed_at))
      || typeof observation.cumulative_spend !== 'number'
      || !Number.isFinite(observation.cumulative_spend)
      || observation.cumulative_spend < 0
      || typeof observation.currency !== 'string'
      || !/^[A-Z]{3}$/.test(observation.currency)
      || typeof observation.reporting_period?.start !== 'string'
      || typeof observation.reporting_period?.end !== 'string'
      || Number.isNaN(Date.parse(observation.reporting_period.start))
      || Number.isNaN(Date.parse(observation.reporting_period.end))
      || (observation.period_closed !== undefined && typeof observation.period_closed !== 'boolean')
      || (
        observation.source === 'seller_statement_copy'
        && (
          typeof observation.seller_statement_id !== 'string'
          || typeof observation.seller_statement_digest !== 'string'
          || !/^sha256:[a-f0-9]{64}$/.test(observation.seller_statement_digest)
        )
      )
    ) {
      return {
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'Buyer delivery observations require identity, source, period, cumulative spend, currency, and source-specific statement evidence.',
        }],
      };
    }
  }

  let requestPayloadHash: string;
  try {
    requestPayloadHash = computeGovernanceOutcomeHash(req as unknown as Record<string, unknown>);
  } catch {
    return {
      errors: [{
        code: 'VALIDATION_ERROR',
        message: 'report_plan_outcome must contain only finite JSON numeric values.',
      }],
    };
  }

  // A successful idempotent response is immutable. Resolve it before looking
  // up mutable plan/check state so plan retirement or revision cannot turn a
  // previously accepted retry into a failure. Scope keys to the authenticated
  // buyer-side reporter so one caller cannot probe another caller's cache.
  if (ctx.authenticatedAgentUrl !== undefined) {
    let replay = [...session.governanceOutcomes.values()].find(existing =>
      existing.idempotencyKey === req.idempotency_key
      && existing.reporterCaller === ctx.authenticatedAgentUrl);
    if (!replay) {
      const replaySession = await findSessionMatching(candidate =>
        [...candidate.governanceOutcomes.values()].some(existing =>
          existing.idempotencyKey === req.idempotency_key
          && existing.reporterCaller === ctx.authenticatedAgentUrl));
      replay = replaySession
        ? [...replaySession.governanceOutcomes.values()].find(existing =>
          existing.idempotencyKey === req.idempotency_key
          && existing.reporterCaller === ctx.authenticatedAgentUrl)
        : undefined;
    }
    if (replay) {
      if (replay.requestPayloadHash !== requestPayloadHash) {
        return {
          errors: [{
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'idempotency_key was already used with a different report_plan_outcome payload.',
          }],
        };
      }
      return { ...(replay.response ?? { outcome_id: replay.outcomeId }), replayed: true };
    }
  }

  const checkPlanOwner = checkId
    ? session.governanceChecks.get(checkId)?.planOwnerAgentUrl
    : undefined;
  let plan = checkPlanOwner
    ? findGovernancePlanEntry(session, planId, checkPlanOwner)?.[1]
    : ctx.authenticatedAgentUrl
      ? findGovernancePlanEntry(session, planId, ctx.authenticatedAgentUrl)?.[1]
      : undefined;
  if (!plan) {
    // Framework-dispatch request schemas omit `account`, so the session
    // key falls to open:default while sync_plans wrote under
    // open:<brand.domain>. Fall back to a cross-session scan.
    const fallback = ctx.authenticatedAgentUrl
      ? await findSessionMatching(candidate => {
        if (!checkId) {
          return outcome === 'delivery'
            && findGovernancePlanEntry(candidate, planId, ctx.authenticatedAgentUrl)?.[1] !== undefined;
        }
        const check = candidate.governanceChecks.get(checkId);
        if (!check || check.planId !== planId) return false;
        const intent = check.binding === 'proposed'
          ? check
          : check.governanceBindingId
            ? [...candidate.governanceChecks.values()].find(item =>
              item.binding === 'proposed'
              && item.governanceBindingId === check.governanceBindingId)
            : undefined;
        return intent?.caller === ctx.authenticatedAgentUrl;
      })
      : null;
    if (fallback) {
      session = fallback;
      const owner = checkId
        ? fallback.governanceChecks.get(checkId)?.planOwnerAgentUrl
        : ctx.authenticatedAgentUrl;
      plan = owner ? findGovernancePlanEntry(fallback, planId, owner)?.[1] : undefined;
    }
  }
  if (!plan) {
    return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: `Plan not found: ${planId}` }] };
  }

  let authorizationCheck: GovernanceCheckState | undefined;
  if (outcome === 'completed' || outcome === 'failed' || (outcome === 'delivery' && checkId)) {
    authorizationCheck = checkId ? session.governanceChecks.get(checkId) : undefined;
    if (
      !authorizationCheck
      || authorizationCheck.status !== 'approved'
      || authorizationCheck.planId !== planId
      || authorizationCheck.governanceContext !== governanceContext
    ) {
      return {
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'check_id, plan_id, and governance_context must identify the same approved governance decision.',
        }],
      };
    }
  }

  const intentAuthorization = authorizationCheck?.binding === 'proposed'
    ? authorizationCheck
    : authorizationCheck?.governanceBindingId
      ? [...session.governanceChecks.values()].reverse().find(check =>
        check.status === 'approved'
        && check.binding === 'proposed'
        && check.governanceBindingId === authorizationCheck?.governanceBindingId)
      : undefined;
  if (authorizationCheck) {
    if ((authorizationCheck.purchaseType ?? 'media_buy') !== purchaseType) {
      return {
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'purchase_type must match the approved governance decision being settled.',
        }],
      };
    }
    if (!intentAuthorization || (intentAuthorization.purchaseType ?? 'media_buy') !== purchaseType) {
      return {
        errors: [{
          code: 'VALIDATION_ERROR',
          message: 'The settlement does not match an approved intent for this purchase_type.',
        }],
      };
    }
    if (
      ctx.authenticatedAgentUrl === undefined
      || ctx.authenticatedAgentUrl !== intentAuthorization.caller
    ) {
      return {
        errors: [{
          code: 'PERMISSION_DENIED',
          message: 'The authenticated outcome reporter must match the buyer-side caller authorized by the original intent.',
        }],
      };
    }
  }

  if (outcome === 'delivery' && delivery) {
    const observationId = (delivery as { observation_id?: unknown }).observation_id;
    const priorObservation = [...session.governanceOutcomes.values()].find(existing =>
      existing.planId === planId
      && existing.planOwnerAgentUrl === ctx.authenticatedAgentUrl
      && existing.outcomeType === 'delivery'
      && (existing.delivery as { observation_id?: unknown } | undefined)?.observation_id === observationId);
    if (priorObservation) {
      if (priorObservation.requestPayloadHash !== requestPayloadHash) {
        return { errors: [{ code: 'CONFLICT', message: 'The buyer reused observation_id with different delivery evidence.' }] };
      }
      return { ...(priorObservation.response ?? { outcome_id: priorObservation.outcomeId }), replayed: true };
    }
    const observationPeriod = (delivery as {
      reporting_period?: { start?: unknown; end?: unknown };
    }).reporting_period;
    const closedPeriod = [...session.governanceOutcomes.values()].find(existing => {
      const existingPeriod = (existing.delivery as {
        reporting_period?: { start?: unknown; end?: unknown };
      } | undefined)?.reporting_period;
      return existing.outcomeType === 'delivery'
        && existing.governanceBindingId === authorizationCheck?.governanceBindingId
        && existing.deliveryPeriodState === 'closed'
        && existingPeriod?.start === observationPeriod?.start
        && existingPeriod?.end === observationPeriod?.end;
    });
    if (closedPeriod) {
      return { errors: [{ code: 'CONFLICT', message: 'The governance reporting period is closed and its evidence is immutable.' }] };
    }
  }

  if ((outcome === 'completed' || outcome === 'failed') && checkId) {
    const settlementBindingId = authorizationCheck?.governanceBindingId;
    const priorSettlement = [...session.governanceOutcomes.values()].find(existing =>
      (settlementBindingId
        ? existing.governanceBindingId === settlementBindingId
        : existing.checkId === checkId)
      && (existing.outcomeType === 'completed' || existing.outcomeType === 'failed'));
    if (priorSettlement) {
      return {
        errors: [{
          code: 'CONFLICT',
          message: `Governed action for check ${checkId} was already settled by outcome ${priorSettlement.outcomeId}.`,
        }],
      };
    }
  }

  const validationError = (message: string) => ({
    errors: [{ code: 'VALIDATION_ERROR', message }],
  });

  const applyLedgerAddition = (amount: number): boolean => {
    const currentByType = plan.committedByType?.[purchaseType] ?? 0;
    const nextTotal = plan.committedBudget + amount;
    const nextByType = currentByType + amount;
    if (!Number.isFinite(nextTotal) || !Number.isFinite(nextByType)) return false;
    plan.committedBudget = nextTotal;
    plan.committedByType = plan.committedByType || {};
    plan.committedByType[purchaseType] = nextByType;
    return true;
  };

  let committedBudget = 0;
  let reportedCommittedBudget: number | undefined;
  const findings: GovernanceFinding[] = [];
  let deliveryReconciliationStatus: GovernanceOutcomeState['deliveryReconciliationStatus'];
  let deliveryPeriodState: GovernanceOutcomeState['deliveryPeriodState'];

  if (outcome === 'delivery' && delivery) {
    const sellerStatement = authorizationCheck?.deliveryStatement;
    if (!sellerStatement) {
      return validationError('check_id must identify a canonical seller delivery statement.');
    }
    const observation = delivery as {
      source: 'seller_statement_copy' | 'buyer_measurement';
      cumulative_spend: number;
      currency: string;
      reporting_period: { start: string; end: string };
      seller_statement_id?: string;
      seller_statement_digest?: string;
      period_closed?: boolean;
    };
    const statementConflict = observation.source === 'seller_statement_copy'
      && (
        observation.seller_statement_id !== sellerStatement.statementId
        || observation.seller_statement_digest !== sellerStatement.statementDigest
      );
    const valueConflict = observation.cumulative_spend !== sellerStatement.cumulativeSpend
      || observation.currency !== sellerStatement.currency
      || observation.reporting_period.start !== sellerStatement.reportingPeriod.start
      || observation.reporting_period.end !== sellerStatement.reportingPeriod.end;
    deliveryPeriodState = observation.period_closed === true ? 'closed' : 'open';
    deliveryReconciliationStatus = statementConflict || valueConflict
      ? deliveryPeriodState === 'closed' ? 'closed_unresolved' : 'disputed'
      : 'consistent';
    if (deliveryReconciliationStatus === 'disputed' || deliveryReconciliationStatus === 'closed_unresolved') {
      findings.push({
        categoryId: 'delivery_evidence_conflict',
        severity: 'critical',
        explanation: deliveryPeriodState === 'closed'
          ? 'The governance period closed with unresolved buyer and seller delivery evidence.'
          : 'Buyer-attributed delivery evidence conflicts with the seller statement retained by governance.',
        details: {
          field: 'delivery.cumulative_spend',
          expected: sellerStatement.cumulativeSpend,
          actual: observation.cumulative_spend,
        },
      });
    }
  }

  if (outcome === 'completed' && sellerResponse) {
    let packageBudgetTotal = 0;
    if (sellerResponse.packages !== undefined) {
      if (!Array.isArray(sellerResponse.packages)) {
        return validationError('seller_response.packages must be an array');
      }
      for (const [index, pkg] of sellerResponse.packages.entries()) {
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
          return validationError(`seller_response.packages[${index}] must be an object`);
        }
        const rawBudget = pkg.budget;
        let packageBudget = 0;
        if (typeof rawBudget === 'number') {
          packageBudget = rawBudget;
        } else if (
          rawBudget
          && typeof rawBudget === 'object'
          && !Array.isArray(rawBudget)
          && rawBudget.total !== undefined
        ) {
          packageBudget = rawBudget.total;
        } else if (rawBudget !== undefined) {
          return validationError(`seller_response.packages[${index}].budget must be a finite, non-negative number`);
        }
        if (!Number.isFinite(packageBudget) || packageBudget < 0) {
          return validationError(`seller_response.packages[${index}].budget must be a finite, non-negative number`);
        }
        const nextPackageTotal = packageBudgetTotal + packageBudget;
        if (!Number.isFinite(nextPackageTotal)) {
          return validationError('seller_response package budgets exceed numeric ledger limits');
        }
        packageBudgetTotal = nextPackageTotal;
      }
    }

    if (sellerResponse.committed_budget !== undefined) {
      if (
        typeof sellerResponse.committed_budget !== 'number'
        || !Number.isFinite(sellerResponse.committed_budget)
        || sellerResponse.committed_budget < 0
      ) {
        return validationError('seller_response.committed_budget must be a finite, non-negative number');
      }
      reportedCommittedBudget = sellerResponse.committed_budget;
    } else {
      reportedCommittedBudget = packageBudgetTotal;
    }

    const executionAuthorization = authorizationCheck?.governanceBindingId
      ? [...session.governanceChecks.values()].reverse().find(check =>
        check.status === 'approved'
        && check.binding === 'committed'
        && check.governanceBindingId === authorizationCheck?.governanceBindingId
        && (check.purchaseType ?? 'media_buy') === purchaseType
        && check.phase === 'purchase'
        && check.authorizedBudget !== undefined)
      : undefined;
    const authoritativeBudget = executionAuthorization?.authorizedBudget
      ?? authorizationCheck?.authorizedBudget;

    if (authoritativeBudget === undefined) {
      if ((reportedCommittedBudget ?? 0) > 0) {
        return validationError('The approved governance check has no authoritative budget to reconcile this outcome.');
      }
      committedBudget = 0;
    } else {
      if ((reportedCommittedBudget ?? 0) > authoritativeBudget) {
        return validationError(
          `Reported committed budget ${reportedCommittedBudget} exceeds the governance-authorized budget ${authoritativeBudget}.`,
        );
      }
      // The governance agent's own approved amount is ledger-authoritative.
      // A lower caller report is retained for audit but cannot restore headroom.
      committedBudget = authoritativeBudget;
      if (reportedCommittedBudget !== authoritativeBudget) {
        findings.push({
          categoryId: 'outcome_budget_reconciliation',
          severity: 'warning',
          explanation: `Caller reported ${reportedCommittedBudget ?? 0}; ledger reserved governance-authorized amount ${authoritativeBudget}.`,
          details: { expected: authoritativeBudget, actual: reportedCommittedBudget ?? 0 },
        });
      }
    }

    if (!applyLedgerAddition(committedBudget)) {
      return validationError('Governance-authorized budget exceeds numeric ledger limits');
    }

    // Check if committed now exceeds authorized
    if (plan.committedBudget > plan.budget.total) {
      findings.push({
        categoryId: 'budget_authority',
        severity: 'warning',
        explanation: `Total committed $${plan.committedBudget} now exceeds authorized $${plan.budget.total}.`,
      });
    }
  }

  // A delivery report is evidence about fulfillment of an existing obligation,
  // not a second commitment. Keep committedBudget at zero and never add spend
  // already covered by the completed outcome.

  const outcomeId = `out_${randomUUID().slice(0, 8)}`;
  const outcomeStateValue = findings.length > 0 ? 'findings' : 'accepted';
  const response: Record<string, unknown> = {
    outcome_id: outcomeId,
    outcome_state: outcomeStateValue,
    // Legacy training callers consumed `status`; retain it during 3.x while
    // the modern schema uses outcome_state to avoid envelope collisions.
    status: outcomeStateValue,
    ...(committedBudget > 0 && { committed_budget: committedBudget }),
    ...(findings.length > 0 && {
      findings: findings.map(f => ({
        category_id: f.categoryId,
        severity: f.severity,
        explanation: f.explanation,
      })),
    }),
    ...(deliveryReconciliationStatus && {
      delivery_reconciliation_status: deliveryReconciliationStatus,
    }),
    ...(deliveryPeriodState && { delivery_period_state: deliveryPeriodState }),
    ...((outcome === 'completed' || outcome === 'failed') && {
      plan_summary: {
        total_committed: plan.committedBudget,
        budget_remaining: plan.budget.total - plan.committedBudget,
      },
    }),
  };
  const outcomeState: GovernanceOutcomeState = {
    outcomeId,
    planId,
    planOwnerAgentUrl: plan.ownerAgentUrl,
    checkId,
    ...(authorizationCheck?.governanceBindingId
      ? { governanceBindingId: authorizationCheck.governanceBindingId }
      : {}),
    governanceContext,
    purchaseType,
    sellerReference: sellerResponse?.seller_reference?.slice(0, 255),
    outcomeType: outcome,
    committedBudget,
    ...(reportedCommittedBudget !== undefined ? { reportedCommittedBudget } : {}),
    ...(req.idempotency_key ? { idempotencyKey: req.idempotency_key } : {}),
    ...(ctx.authenticatedAgentUrl ? { reporterCaller: ctx.authenticatedAgentUrl } : {}),
    requestPayloadHash,
    response,
    ...(outcome === 'delivery' && delivery ? { delivery: structuredClone(delivery) } : {}),
    ...(deliveryReconciliationStatus ? { deliveryReconciliationStatus } : {}),
    ...(deliveryPeriodState ? { deliveryPeriodState } : {}),
    findings,
    timestamp: new Date().toISOString(),
  };

  session.governanceOutcomes.set(outcomeId, outcomeState);

  return response;
}

function buildAdjustmentPlanSummary(
  session: SessionState,
  plan: GovernancePlanState,
): Record<string, unknown> {
  const outcomes = [...session.governanceOutcomes.values()].filter(outcome =>
    outcome.planId === plan.planId && outcome.planOwnerAgentUrl === plan.ownerAgentUrl);
  const adjustments = [...session.governanceAdjustments.values()].filter(adjustment =>
    adjustment.planId === plan.planId && adjustment.planOwnerAgentUrl === plan.ownerAgentUrl);
  const grossCommitted = outcomes.reduce((sum, outcome) => sum + outcome.committedBudget, 0);
  const adjustmentsReported = adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);
  const adjustmentsVerified = adjustments.reduce((sum, adjustment) => sum + adjustment.verifiedAmount, 0);
  const headroomRestored = adjustments.reduce((sum, adjustment) => sum + adjustment.headroomRestored, 0);
  if (
    !Number.isFinite(grossCommitted)
    || !Number.isFinite(adjustmentsReported)
    || !Number.isFinite(adjustmentsVerified)
    || !Number.isFinite(headroomRestored)
  ) {
    throw new Error('Plan adjustment totals exceed numeric ledger limits.');
  }
  return {
    accounting_mode: plan.budget.accountingMode ?? 'gross_commitment',
    gross_committed: grossCommitted,
    adjustments_reported: adjustmentsReported,
    adjustments_verified: adjustmentsVerified,
    net_cost: grossCommitted - adjustmentsVerified,
    headroom_restored: headroomRestored,
    ledger_committed: plan.committedBudget,
    // 3.2 compatibility alias. This is the plan ledger after adjustments
    // eligible under accounting_mode, not necessarily economic net cost.
    net_committed: plan.committedBudget,
    budget_remaining: plan.budget.total - plan.committedBudget,
  };
}

export async function handleReportPlanAdjustment(args: ToolArgs, ctx: TrainingContext) {
  const req = args as ReportPlanAdjustmentInput | ReviewPlanAdjustmentInput;
  let session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const validationError = (message: string) => ({
    errors: [{ code: 'VALIDATION_ERROR', message }],
  });
  if (req.action !== 'report' && req.action !== 'review') {
    return validationError('action must be report or review.');
  }
  if (typeof req.plan_id !== 'string' || req.plan_id.length === 0) {
    return validationError('plan_id is required.');
  }
  if (typeof req.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(req.idempotency_key)) {
    return validationError('idempotency_key is required and must match ^[A-Za-z0-9_.:-]{16,255}$.');
  }
  let requestPayloadHash: string;
  try {
    requestPayloadHash = computeGovernanceAdjustmentHash(req as unknown as Record<string, unknown>);
  } catch {
    return validationError('report_plan_adjustment must contain only finite JSON numeric values.');
  }

  if (!ctx.authenticatedAgentUrl) {
    return { errors: [{ code: 'PERMISSION_DENIED', message: 'report_plan_adjustment requires an authenticated agent.' }] };
  }

  if (req.action === 'review') {
    if (typeof req.adjustment_id !== 'string' || req.adjustment_id.length === 0) {
      return validationError('adjustment_id is required for review.');
    }
    if (req.decision !== 'accept' && req.decision !== 'dispute') {
      return validationError('decision must be accept or dispute.');
    }
    if (req.reason !== undefined && (typeof req.reason !== 'string' || req.reason.length === 0 || req.reason.length > 1000)) {
      return validationError('reason must be between 1 and 1000 characters when provided.');
    }
    if (req.decision === 'dispute' && req.reason === undefined) {
      return validationError('reason is required when disputing an adjustment.');
    }
    let adjustment = session.governanceAdjustments.get(req.adjustment_id);
    if (!adjustment || adjustment.planId !== req.plan_id) {
      const found = await findSessionMatching(candidate => {
        const value = candidate.governanceAdjustments.get(req.adjustment_id);
        return value?.planId === req.plan_id;
      });
      if (found) {
        session = found;
        adjustment = found.governanceAdjustments.get(req.adjustment_id);
      }
    }
    const plan = adjustment
      ? findGovernancePlanEntry(session, req.plan_id, adjustment.planOwnerAgentUrl)?.[1]
      : undefined;
    if (!adjustment || !plan || plan.ownerAgentUrl !== ctx.authenticatedAgentUrl) {
      return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'Adjustment not found.' }] };
    }
    const duplicateReview = [...session.governanceAdjustments.values()].find(existing =>
      existing.reviewIdempotencyKey === req.idempotency_key
      && existing.adjustmentId !== req.adjustment_id);
    if (duplicateReview) {
      return { errors: [{ code: 'IDEMPOTENCY_CONFLICT', message: 'Review idempotency key was already used for another adjustment.' }] };
    }
    if (adjustment.reviewIdempotencyKey === req.idempotency_key) {
      if (adjustment.reviewPayloadHash !== requestPayloadHash) {
        return { errors: [{ code: 'IDEMPOTENCY_CONFLICT', message: 'Review idempotency key was reused with a different payload.' }] };
      }
      return { ...(adjustment.reviewResponse ?? {}), replayed: true };
    }
    if (adjustment.verificationState !== 'reported') {
      return { errors: [{ code: 'CONFLICT', message: `Adjustment is already ${adjustment.verificationState}.` }] };
    }
    const now = new Date().toISOString();
    let headroomRestored = 0;
    let verifiedAmount = 0;
    if (req.decision === 'accept') {
      const latestDeliveryReconciliation = [...session.governanceOutcomes.values()]
        .reverse()
        .find(outcome =>
          outcome.governanceBindingId === adjustment?.governanceBindingId
          && outcome.outcomeType === 'delivery');
      if (latestDeliveryReconciliation?.deliveryReconciliationStatus === 'disputed') {
        return { errors: [{ code: 'CONFLICT', message: 'Delivery evidence is disputed; reconcile it before accepting an adjustment.' }] };
      }
      if (adjustment.adjustmentType === 'decommitment') {
        const sellerStatements = [...session.governanceChecks.values()]
          .filter(check =>
            check.governanceBindingId === adjustment?.governanceBindingId
            && check.deliveryStatement)
          .sort((a, b) => (b.deliveryStatement?.sequence ?? 0) - (a.deliveryStatement?.sequence ?? 0));
        const latestStatement = sellerStatements[0]?.deliveryStatement;
        if (!latestStatement) {
          return { errors: [{ code: 'CONFLICT', message: 'A canonical seller delivery statement is required before decommitment can be verified.' }] };
        }
        const sourceOutcome = session.governanceOutcomes.get(adjustment.outcomeId);
        const remainingObligation = (sourceOutcome?.committedBudget ?? 0) - latestStatement.cumulativeSpend;
        const priorVerifiedDecommitments = [...session.governanceAdjustments.values()]
          .filter(existing =>
            existing.adjustmentId !== adjustment?.adjustmentId
            && existing.outcomeId === adjustment?.outcomeId
            && existing.adjustmentType === 'decommitment'
            && existing.verificationState === 'verified')
          .reduce((sum, existing) => sum + existing.verifiedAmount, 0);
        const cumulativeDecommitment = priorVerifiedDecommitments + adjustment.amount;
        if (
          !Number.isFinite(remainingObligation)
          || !Number.isFinite(cumulativeDecommitment)
          || cumulativeDecommitment > remainingObligation
        ) {
          return validationError('Decommitment exceeds the undelivered obligation in the latest reconciled statement.');
        }
        verifiedAmount = adjustment.amount;
        headroomRestored = adjustment.amount;
      } else if (adjustment.adjustmentType === 'refund' || adjustment.adjustmentType === 'credit') {
        verifiedAmount = adjustment.amount;
        headroomRestored = (plan.budget.accountingMode ?? 'gross_commitment') === 'verified_net_cost'
          ? adjustment.amount
          : 0;
      }
      const currentByType = plan.committedByType?.[adjustment.purchaseType] ?? 0;
      const nextCommitted = plan.committedBudget - headroomRestored;
      const nextByType = currentByType - headroomRestored;
      if (!Number.isFinite(nextCommitted) || !Number.isFinite(nextByType) || nextCommitted < 0 || nextByType < 0) {
        return validationError('Verified adjustment would make the governance ledger negative.');
      }
      plan.committedBudget = nextCommitted;
      plan.committedByType = plan.committedByType || {};
      plan.committedByType[adjustment.purchaseType] = nextByType;
      adjustment.verificationState = 'verified';
    } else {
      adjustment.verificationState = 'disputed';
    }
    adjustment.verifiedAmount = verifiedAmount;
    adjustment.headroomRestored = headroomRestored;
    adjustment.reviewIdempotencyKey = req.idempotency_key;
    adjustment.reviewPayloadHash = requestPayloadHash;
    adjustment.reviewerBuyer = ctx.authenticatedAgentUrl;
    adjustment.reviewReason = req.reason;
    adjustment.reviewedAt = now;
    const response: Record<string, unknown> = {
      adjustment_id: adjustment.adjustmentId,
      adjustment_state: adjustment.verificationState,
      adjustment_type: adjustment.adjustmentType,
      amount: { amount: adjustment.amount, currency: adjustment.currency },
      headroom_restored: headroomRestored,
      plan_summary: buildAdjustmentPlanSummary(session, plan),
    };
    adjustment.reviewResponse = response;
    return response;
  }

  if (typeof req.outcome_id !== 'string' || req.outcome_id.length === 0) return validationError('outcome_id is required.');
  if (typeof req.seller_reference !== 'string' || req.seller_reference.length === 0 || req.seller_reference.length > 255) {
    return validationError('seller_reference is required and must be at most 255 characters.');
  }
  if (typeof req.seller_adjustment_id !== 'string' || req.seller_adjustment_id.length === 0 || req.seller_adjustment_id.length > 255) {
    return validationError('seller_adjustment_id is required and must be at most 255 characters.');
  }
  if (!VALID_ADJUSTMENT_TYPES.has(req.adjustment_type)) return validationError('Invalid adjustment_type.');
  if (!req.amount || typeof req.amount.amount !== 'number' || !Number.isFinite(req.amount.amount) || req.amount.amount <= 0) {
    return validationError('amount.amount must be a finite number greater than zero.');
  }
  if (typeof req.amount.currency !== 'string' || !/^[A-Z]{3}$/.test(req.amount.currency)) {
    return validationError('amount.currency must be a three-letter uppercase currency code.');
  }
  if (typeof req.reason !== 'string' || req.reason.length === 0 || req.reason.length > 1000) {
    return validationError('reason is required and must be at most 1000 characters.');
  }
  if (typeof req.effective_at !== 'string' || Number.isNaN(Date.parse(req.effective_at))) {
    return validationError('effective_at must be a valid date-time.');
  }
  const expectedEvidenceType: Record<GovernanceAdjustmentType, GovernanceAdjustmentState['evidence']['evidenceType']> = {
    decommitment: 'decommitment_agreement',
    refund: 'refund_settlement',
    credit: 'credit_note',
    makegood: 'makegood_agreement',
  };
  if (
    !req.evidence
    || typeof req.evidence.evidence_id !== 'string'
    || req.evidence.evidence_id.length === 0
    || req.evidence.evidence_id.length > 255
    || req.evidence.evidence_type !== expectedEvidenceType[req.adjustment_type]
    || typeof req.evidence.digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(req.evidence.digest)
    || typeof req.evidence.issued_at !== 'string'
    || Number.isNaN(Date.parse(req.evidence.issued_at))
  ) {
    return validationError(`evidence must be valid and use ${expectedEvidenceType[req.adjustment_type]} for ${req.adjustment_type}.`);
  }

  const findReplay = (candidate: SessionState): GovernanceAdjustmentState | undefined =>
    [...candidate.governanceAdjustments.values()].find(existing =>
      existing.reporterSeller === ctx.authenticatedAgentUrl
      && (
        existing.idempotencyKey === req.idempotency_key
        || existing.sellerAdjustmentId === req.seller_adjustment_id
        || existing.evidence.evidenceId === req.evidence.evidence_id
      ));
  let replay = findReplay(session);
  if (!replay) {
    const replaySession = await findSessionMatching(candidate => findReplay(candidate) !== undefined);
    replay = replaySession ? findReplay(replaySession) : undefined;
  }
  if (replay) {
    if (replay.requestPayloadHash !== requestPayloadHash) {
      const keyName = replay.idempotencyKey === req.idempotency_key
        ? 'idempotency_key'
        : replay.sellerAdjustmentId === req.seller_adjustment_id
          ? 'seller_adjustment_id'
          : 'evidence.evidence_id';
      return { errors: [{ code: keyName === 'idempotency_key' ? 'IDEMPOTENCY_CONFLICT' : 'CONFLICT', message: `${keyName} was already used with a different payload.` }] };
    }
    return { ...replay.response, replayed: true };
  }

  let sourceOutcome = session.governanceOutcomes.get(req.outcome_id);
  if (!sourceOutcome || sourceOutcome.planId !== req.plan_id) {
    const found = await findSessionMatching(candidate => candidate.governanceOutcomes.get(req.outcome_id)?.planId === req.plan_id);
    if (found) {
      session = found;
      sourceOutcome = found.governanceOutcomes.get(req.outcome_id);
    }
  }
  const plan = sourceOutcome?.planOwnerAgentUrl
    ? findGovernancePlanEntry(session, req.plan_id, sourceOutcome.planOwnerAgentUrl)?.[1]
    : undefined;
  const intentCheck = sourceOutcome?.governanceBindingId
    ? [...session.governanceChecks.values()].find(check =>
      check.status === 'approved'
      && check.binding === 'proposed'
      && check.governanceBindingId === sourceOutcome?.governanceBindingId)
    : undefined;
  if (!sourceOutcome || !plan || intentCheck?.targetAudience !== ctx.authenticatedAgentUrl) {
    return { errors: [{ code: 'REFERENCE_NOT_FOUND', message: 'Completed governance outcome not found.' }] };
  }
  if (sourceOutcome.outcomeType !== 'completed' || sourceOutcome.committedBudget <= 0) {
    return validationError('Only a completed outcome with a positive authoritative commitment can be adjusted.');
  }
  if (sourceOutcome.sellerReference !== req.seller_reference) {
    return validationError('seller_reference must exactly match the source outcome.');
  }
  if (req.amount.currency !== plan.budget.currency) {
    return validationError(`amount.currency must match the plan currency ${plan.budget.currency}.`);
  }
  const priorAdjusted = [...session.governanceAdjustments.values()]
    .filter(adjustment => adjustment.outcomeId === sourceOutcome?.outcomeId)
    .reduce((sum, adjustment) => sum + adjustment.amount, 0);
  if (!Number.isFinite(priorAdjusted + req.amount.amount) || priorAdjusted + req.amount.amount > sourceOutcome.committedBudget) {
    return validationError('Cumulative adjustments exceed the original authoritative commitment.');
  }

  const adjustmentId = `adj_${randomUUID().slice(0, 8)}`;
  const state: GovernanceAdjustmentState = {
    adjustmentId,
    planId: req.plan_id,
    planOwnerAgentUrl: plan.ownerAgentUrl,
    outcomeId: sourceOutcome.outcomeId,
    ...(sourceOutcome.governanceBindingId ? { governanceBindingId: sourceOutcome.governanceBindingId } : {}),
    ...(sourceOutcome.governanceContext ? { governanceContext: sourceOutcome.governanceContext } : {}),
    purchaseType: sourceOutcome.purchaseType ?? 'media_buy',
    sellerReference: req.seller_reference,
    sellerAdjustmentId: req.seller_adjustment_id,
    adjustmentType: req.adjustment_type,
    amount: req.amount.amount,
    currency: req.amount.currency,
    headroomRestored: 0,
    verifiedAmount: 0,
    verificationState: 'reported',
    evidence: {
      evidenceId: req.evidence.evidence_id,
      evidenceType: req.evidence.evidence_type,
      digest: req.evidence.digest,
      issuedAt: req.evidence.issued_at,
    },
    reason: req.reason,
    effectiveAt: req.effective_at,
    idempotencyKey: req.idempotency_key,
    reporterSeller: ctx.authenticatedAgentUrl,
    requestPayloadHash,
    response: {},
    timestamp: new Date().toISOString(),
  };
  session.governanceAdjustments.set(adjustmentId, state);
  const response: Record<string, unknown> = {
    adjustment_id: adjustmentId,
    adjustment_state: 'reported',
    adjustment_type: req.adjustment_type,
    amount: { amount: req.amount.amount, currency: req.amount.currency },
    headroom_restored: 0,
    plan_summary: buildAdjustmentPlanSummary(session, plan),
  };
  state.response = response;
  return response;
}

export async function handleGetPlanAuditLogs(args: ToolArgs, ctx: TrainingContext) {
  const req = args as GetPlanAuditLogsInput;
  const session = await getSession(sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId));
  const planIds = [...(req.plan_ids || []), ...(req.plan_id ? [req.plan_id] : [])];
  const portfolioPlanIds = req.portfolio_plan_ids || [];
  const governanceContextsFilter = req.governance_contexts;
  const purchaseTypesFilter = req.purchase_types;
  const includeEntries = req.include_entries || false;

  if (!planIds.length && !portfolioPlanIds.length && !governanceContextsFilter?.length) {
    return { errors: [{ code: 'VALIDATION_ERROR', message: 'plan_ids, portfolio_plan_ids, or governance_contexts is required' }] };
  }
  if (!ctx.authenticatedAgentUrl) {
    return { errors: [{ code: 'PERMISSION_DENIED', message: 'get_plan_audit_logs requires an authenticated buyer agent.' }] };
  }

  if (purchaseTypesFilter?.length) {
    const invalid = purchaseTypesFilter.filter(t => !VALID_PURCHASE_TYPES.has(t));
    if (invalid.length) {
      return { errors: [{ code: 'VALIDATION_ERROR', message: `Invalid purchase_types: ${invalid.join(', ')}. Must be one of: ${[...VALID_PURCHASE_TYPES].join(', ')}` }] };
    }
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
    let planSession = session;
    let plan: GovernancePlanState | undefined = findGovernancePlanEntry(
      planSession,
      planId,
      ctx.authenticatedAgentUrl,
    )?.[1];
    if (!plan) {
      const ownedSession = await findSessionMatching(candidate =>
        findGovernancePlanEntry(candidate, planId, ctx.authenticatedAgentUrl) !== undefined);
      if (ownedSession) {
        planSession = ownedSession;
        plan = findGovernancePlanEntry(ownedSession, planId, ctx.authenticatedAgentUrl)?.[1];
      }
    }
    if (!plan || plan.ownerAgentUrl !== ctx.authenticatedAgentUrl) continue;

    // Gather checks and outcomes for this plan, optionally filtered by governance context and/or purchase type
    const ctxFilter = governanceContextsFilter?.length ? new Set(governanceContextsFilter) : undefined;
    const ptFilter = purchaseTypesFilter?.length ? new Set(purchaseTypesFilter) : undefined;
    const checks = Array.from(planSession.governanceChecks.values())
      .filter(c => c.planId === planId
        && c.planOwnerAgentUrl === plan.ownerAgentUrl
        && (!ctxFilter || (c.governanceContext && ctxFilter.has(c.governanceContext)))
        && (!ptFilter || ptFilter.has(c.purchaseType || 'media_buy')));
    const outcomes = Array.from(planSession.governanceOutcomes.values())
      .filter(o => o.planId === planId
        && o.planOwnerAgentUrl === plan.ownerAgentUrl
        && (!ctxFilter || (o.governanceContext && ctxFilter.has(o.governanceContext)))
        && (!ptFilter || ptFilter.has(o.purchaseType || 'media_buy')));
    const adjustments = Array.from(planSession.governanceAdjustments.values())
      .filter(a => a.planId === planId
        && a.planOwnerAgentUrl === plan.ownerAgentUrl
        && (!ctxFilter || (a.governanceContext && ctxFilter.has(a.governanceContext)))
        && (!ptFilter || ptFilter.has(a.purchaseType || 'media_buy')));

    // Budget state
    const grossCommitted = outcomes.reduce((sum, outcome) => sum + outcome.committedBudget, 0);
    const adjustmentsReported = adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);
    const adjustmentsVerified = adjustments.reduce((sum, adjustment) => sum + adjustment.verifiedAmount, 0);
    const headroomRestored = adjustments.reduce((sum, adjustment) => sum + adjustment.headroomRestored, 0);
    const budget = {
      authorized: plan.budget.total,
      accounting_mode: plan.budget.accountingMode ?? 'gross_commitment',
      gross_committed: grossCommitted,
      adjustments_reported: adjustmentsReported,
      adjustments_verified: adjustmentsVerified,
      net_cost: grossCommitted - adjustmentsVerified,
      headroom_restored: headroomRestored,
      ledger_committed: plan.committedBudget,
      net_committed: plan.committedBudget,
      // Legacy alias retained throughout 3.x. `committed` now reflects the
      // net obligation after verified headroom-restoring adjustments.
      committed: plan.committedBudget,
      remaining: plan.budget.total - plan.committedBudget,
      utilization_pct: plan.budget.total > 0
        ? Math.round((plan.committedBudget / plan.budget.total) * 10000) / 100
        : 0,
    };

    // Channel allocation from outcomes
    const channelAllocation: Record<string, { committed: number; pct: number }> = {};

    // Governed actions are joined by the stable opaque action binding. Each
    // lifecycle check receives a freshly signed governance_context, so using
    // that token string as the internal join key would incorrectly separate
    // seller delivery evidence from the buyer observation it is meant to
    // reconcile. The response still exposes the original intent context.
    const actionMap = new Map<string, {
      governanceContext: string;
      purchase_type: string;
      status: string;
      committed: number;
      adjustmentsReported: number;
      adjustmentsVerified: number;
      headroomRestored: number;
      checkCount: number;
      sellerReportedSpend?: number;
      buyerObservedSpend?: number;
      sellerStatementSequence?: number;
      deliveryReportingPeriod?: { start: string; end: string };
      deliveryReconciliationStatus?: GovernanceOutcomeState['deliveryReconciliationStatus'];
      deliveryPeriodState?: GovernanceOutcomeState['deliveryPeriodState'];
      seller_reference?: string;
    }>();
    for (const check of checks) {
      const actionKey = check.governanceBindingId ?? check.governanceContext;
      if (actionKey && check.governanceContext) {
        if (!actionMap.has(actionKey)) {
          actionMap.set(actionKey, {
            governanceContext: check.governanceContext,
            purchase_type: check.purchaseType || 'media_buy',
            status: 'active',
            committed: 0,
            adjustmentsReported: 0,
            adjustmentsVerified: 0,
            headroomRestored: 0,
            checkCount: 0,
          });
        }
        const entry = actionMap.get(actionKey)!;
        if (check.binding === 'proposed') entry.governanceContext = check.governanceContext;
        entry.checkCount++;
        if (
          check.deliveryStatement
          && check.deliveryStatement.sequence >= (entry.sellerStatementSequence ?? 0)
        ) {
          entry.sellerReportedSpend = check.deliveryStatement.cumulativeSpend;
          entry.sellerStatementSequence = check.deliveryStatement.sequence;
          entry.deliveryReportingPeriod = check.deliveryStatement.reportingPeriod;
          entry.buyerObservedSpend = undefined;
          entry.deliveryReconciliationStatus = 'unmatched';
          entry.deliveryPeriodState = 'open';
        }
      }
    }
    for (const outcome of outcomes) {
      const actionKey = outcome.governanceBindingId ?? outcome.governanceContext;
      if (actionKey && outcome.governanceContext) {
        const entry = actionMap.get(actionKey);
        if (entry) {
          entry.committed += outcome.committedBudget;
          if (outcome.sellerReference) entry.seller_reference = outcome.sellerReference;
          if (outcome.delivery) {
            const deliveryObservation = outcome.delivery as {
              cumulative_spend?: unknown;
              reporting_period?: { start?: unknown; end?: unknown };
            };
            const observationMatchesCurrentPeriod = entry.deliveryReportingPeriod !== undefined
              && entry.deliveryReportingPeriod.start === deliveryObservation.reporting_period?.start
              && entry.deliveryReportingPeriod?.end === deliveryObservation.reporting_period?.end;
            if (observationMatchesCurrentPeriod) {
              if (typeof deliveryObservation.cumulative_spend === 'number') {
                entry.buyerObservedSpend = deliveryObservation.cumulative_spend;
              }
              entry.deliveryReconciliationStatus = outcome.deliveryReconciliationStatus ?? 'unmatched';
              entry.deliveryPeriodState = outcome.deliveryPeriodState ?? 'open';
            }
          }
        }
      }
    }
    for (const adjustment of adjustments) {
      const actionKey = adjustment.governanceBindingId ?? adjustment.governanceContext;
      if (actionKey && adjustment.governanceContext) {
        const entry = actionMap.get(actionKey);
        if (entry) {
          entry.adjustmentsReported += adjustment.amount;
          entry.adjustmentsVerified += adjustment.verifiedAmount;
          entry.headroomRestored += adjustment.headroomRestored;
        }
      }
    }

    const governedActions = Array.from(actionMap.values()).map(data => ({
      governance_context: data.governanceContext,
      purchase_type: data.purchase_type,
      status: data.status,
      committed: data.committed,
      adjustments_reported: data.adjustmentsReported,
      adjustments_verified: data.adjustmentsVerified,
      net_cost: data.committed - data.adjustmentsVerified,
      headroom_restored: data.headroomRestored,
      net_committed: data.committed - data.headroomRestored,
      ...(data.sellerReportedSpend !== undefined && { seller_reported_spend: data.sellerReportedSpend }),
      ...(data.buyerObservedSpend !== undefined && { buyer_observed_spend: data.buyerObservedSpend }),
      ...((data.sellerReportedSpend !== undefined || data.buyerObservedSpend !== undefined) && {
        ...(data.deliveryReportingPeriod && { delivery_reporting_period: data.deliveryReportingPeriod }),
        conservative_exposure: Math.max(data.sellerReportedSpend ?? 0, data.buyerObservedSpend ?? 0),
        delivery_reconciliation_status: data.deliveryReconciliationStatus
          ?? (data.sellerReportedSpend !== undefined && data.buyerObservedSpend === undefined ? 'unmatched' : 'consistent'),
        delivery_period_state: data.deliveryPeriodState ?? 'open',
      }),
      check_count: data.checkCount,
      ...(data.seller_reference && { seller_reference: data.seller_reference }),
    }));

    // Summary statistics. v3 governance has three terminal statuses (approved|denied|conditions);
    // human review is tracked via a supplementary `human_reviewed` count (same checks as
    // denied/approved but flagged as having gone through review). We identify them by the
    // `human_review` finding category the handler attaches when a plan demands human approval.
    const statusCounts: { approved: number; denied: number; conditions: number; human_reviewed: number } = {
      approved: 0,
      denied: 0,
      conditions: 0,
      human_reviewed: 0,
    };
    for (const check of checks) {
      statusCounts[check.status]++;
      if (check.findings.some(f => f.categoryId === 'human_review')) {
        statusCounts.human_reviewed++;
      }
    }

    const totalChecks = checks.length;
    const escalationRate = totalChecks > 0 ? statusCounts.human_reviewed / totalChecks : 0;
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
      .filter(c => c.findings.some(f => f.categoryId === 'human_review'))
      .map(c => {
        const humanReviewFinding = c.findings.find(f => f.categoryId === 'human_review');
        return {
          check_id: c.checkId,
          reason: humanReviewFinding?.explanation ?? 'Escalated per policy',
        };
      });

    const summary = {
      checks_performed: totalChecks,
      outcomes_reported: outcomes.length,
      adjustments_reported: adjustments.length,
      adjustments_verified: adjustments.filter(adjustment => adjustment.verificationState === 'verified').length,
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
          check_type: check.binding === 'committed' ? 'execution' : 'intent',
          ...(check.mode && { mode: check.mode }),
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
          ...(check.deliveryStatement && {
            delivery_statement: {
              statement_id: check.deliveryStatement.statementId,
              statement_digest: check.deliveryStatement.statementDigest,
              sequence: check.deliveryStatement.sequence,
              issued_at: check.deliveryStatement.issuedAt,
              seller_reference: check.deliveryStatement.sellerReference,
              cumulative_spend: check.deliveryStatement.cumulativeSpend,
              currency: check.deliveryStatement.currency,
              reporting_period: check.deliveryStatement.reportingPeriod,
              canonical_payload: check.deliveryStatement.canonicalPayload,
            },
          }),
        });
      }

      for (const outcome of outcomes) {
        auditEntries.push({
          id: outcome.outcomeId,
          type: 'outcome',
          timestamp: outcome.timestamp,
          outcome: outcome.outcomeType,
          committed_budget: outcome.committedBudget,
          ...(outcome.reportedCommittedBudget !== undefined && {
            reported_committed_budget: outcome.reportedCommittedBudget,
          }),
          ...(outcome.purchaseType && { purchase_type: outcome.purchaseType }),
          ...(outcome.governanceContext && { governance_context: outcome.governanceContext }),
          ...(outcome.sellerReference && { seller_reference: outcome.sellerReference }),
          ...(outcome.delivery && { delivery: outcome.delivery }),
          ...(outcome.deliveryReconciliationStatus && {
            delivery_reconciliation_status: outcome.deliveryReconciliationStatus,
          }),
          ...(outcome.deliveryPeriodState && { delivery_period_state: outcome.deliveryPeriodState }),
        });
      }

      for (const adjustment of adjustments) {
        auditEntries.push({
          id: adjustment.adjustmentId,
          type: 'adjustment',
          timestamp: adjustment.timestamp,
          caller: adjustment.reporterSeller,
          outcome_id: adjustment.outcomeId,
          seller_reference: adjustment.sellerReference,
          seller_adjustment_id: adjustment.sellerAdjustmentId,
          adjustment_type: adjustment.adjustmentType,
          amount: { amount: adjustment.amount, currency: adjustment.currency },
          adjustment_state: adjustment.verificationState,
          verified_amount: adjustment.verifiedAmount,
          headroom_restored: adjustment.headroomRestored,
          evidence: {
            evidence_id: adjustment.evidence.evidenceId,
            evidence_type: adjustment.evidence.evidenceType,
            digest: adjustment.evidence.digest,
            issued_at: adjustment.evidence.issuedAt,
          },
          ...(adjustment.reviewerBuyer && { reviewed_by: adjustment.reviewerBuyer }),
          ...(adjustment.reviewedAt && { reviewed_at: adjustment.reviewedAt }),
          ...(adjustment.reviewReason && { review_reason: adjustment.reviewReason }),
          reason: adjustment.reason,
          effective_at: adjustment.effectiveAt,
          purchase_type: adjustment.purchaseType,
          ...(adjustment.governanceContext && { governance_context: adjustment.governanceContext }),
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
  humanReviewRequired: boolean,
): string {
  if (status === 'approved' && findings.length === 0) {
    return 'All governance checks passed.';
  }
  if (status === 'approved' && findings.length > 0) {
    return `Approved with ${findings.length} advisory finding(s).`;
  }
  if (status === 'conditions') {
    return `Counterproposal — ${conditions.length} adjustment(s) required before re-check: ${conditions.map(c => c.reason).join('; ')}`;
  }
  if (status === 'denied') {
    const reasons = findings.filter(f => f.severity === 'critical').map(f => f.explanation);
    const prefix = humanReviewRequired ? 'Denied pending human review' : 'Denied';
    return `${prefix}: ${reasons.join('; ')}`;
  }
  return `Governance check completed with status: ${status}.`;
}

function buildCheckResponse(check: GovernanceCheckState) {
  return {
    check_id: check.checkId,
    check_type: check.binding === 'proposed' ? 'intent' : 'execution',
    status: check.status,
    verdict: check.status,
    ...(check.binding === 'proposed' && { plan_id: check.planId }),
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
    ...(check.consultationContext && { consultation_context: check.consultationContext }),
    ...(check.expiresAt && { expires_at: check.expiresAt }),
    ...(check.phase === 'delivery' && check.status === 'approved' && {
      next_check: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
    ...(check.deliveryStatement && {
      delivery_statement: {
        statement_id: check.deliveryStatement.statementId,
        statement_digest: check.deliveryStatement.statementDigest,
        sequence: check.deliveryStatement.sequence,
        issued_at: check.deliveryStatement.issuedAt,
        seller_reference: check.deliveryStatement.sellerReference,
        reporting_period: check.deliveryStatement.reportingPeriod,
        cumulative_spend: check.deliveryStatement.cumulativeSpend,
        currency: check.deliveryStatement.currency,
        canonical_payload: check.deliveryStatement.canonicalPayload,
      },
    }),
    ...(check.governanceContext && {
      governance_context: check.governanceContext,
    }),
  };
}
