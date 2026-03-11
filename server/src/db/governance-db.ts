/**
 * Database module for the community governance agent.
 *
 * Manages governance plans, checks, and outcomes.
 * Follows the policies-db.ts pattern: direct SQL, parameterized queries, transactions.
 */

import { query, getClient } from './client.js';
import { randomUUID } from 'crypto';

// ── Credential operations ──

/**
 * Look up a governance token hash and return the associated account_id.
 * Returns null if the token is not found or has been revoked.
 */
export async function lookupGovernanceToken(tokenHash: string): Promise<string | null> {
  const result = await query<{ account_id: string }>(
    'SELECT account_id FROM governance_credentials WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash]
  );
  return result.rows.length > 0 ? result.rows[0].account_id : null;
}

/**
 * Register a governance credential (token hash → account_id).
 */
export async function registerGovernanceToken(tokenHash: string, accountId: string): Promise<void> {
  await query(
    `INSERT INTO governance_credentials (token_hash, account_id)
     VALUES ($1, $2)
     ON CONFLICT (token_hash) DO UPDATE SET account_id = EXCLUDED.account_id, revoked_at = NULL`,
    [tokenHash, accountId]
  );
}

// ── Types ──

export interface GovernancePlan {
  plan_id: string;
  account_id: string;
  brand_domain: string;
  brand_id: string | null;
  objectives: string;
  budget_total: number;
  budget_currency: string;
  budget_authority_level: 'agent_full' | 'agent_limited' | 'human_required';
  budget_per_seller_max_pct: number | null;
  budget_reallocation_threshold: number | null;
  channels_required: string[];
  channels_allowed: string[];
  channel_mix_targets: Record<string, { min_pct?: number; max_pct?: number }>;
  flight_start: Date;
  flight_end: Date;
  countries: string[];
  regions: string[];
  approved_sellers: string[] | null;
  resolved_policies: ResolvedPolicy[];
  version: number;
  status: 'active' | 'suspended' | 'completed';
  ext: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ResolvedPolicy {
  policy_id: string;
  source: 'explicit' | 'auto_applied';
  enforcement: 'must' | 'should' | 'may';
  reason?: string;
}

export interface GovernanceCheck {
  check_id: string;
  plan_id: string;
  buyer_campaign_ref: string;
  binding: 'proposed' | 'committed';
  caller: string;
  phase: 'purchase' | 'modification' | 'delivery';
  tool: string | null;
  payload: Record<string, unknown> | null;
  media_buy_id: string | null;
  buyer_ref: string | null;
  planned_delivery: Record<string, unknown> | null;
  delivery_metrics: Record<string, unknown> | null;
  modification_summary: string | null;
  status: 'approved' | 'denied' | 'conditions' | 'escalated';
  explanation: string;
  findings: Finding[];
  conditions: Condition[] | null;
  escalation: Record<string, unknown> | null;
  expires_at: Date | null;
  next_check: Date | null;
  created_at: Date;
}

export interface Finding {
  category_id: string;
  policy_id?: string;
  severity: 'info' | 'warning' | 'critical';
  explanation: string;
  details?: Record<string, unknown>;
}

export interface Condition {
  field: string;
  required_value?: unknown;
  reason: string;
}

export interface GovernanceOutcome {
  outcome_id: string;
  plan_id: string;
  check_id: string | null;
  buyer_campaign_ref: string;
  outcome: 'completed' | 'failed' | 'delivery';
  seller_response: Record<string, unknown> | null;
  delivery: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  committed_budget: number | null;
  status: 'accepted' | 'findings';
  findings: Finding[];
  created_at: Date;
}

export interface BudgetSummary {
  plan_id: string;
  budget_total: number;
  budget_currency: string;
  total_committed: number;
  budget_remaining: number;
}

// ── Deserialization ──

function deserializePlan(row: any): GovernancePlan {
  return {
    ...row,
    budget_total: parseFloat(row.budget_total),
    budget_per_seller_max_pct: row.budget_per_seller_max_pct != null ? parseFloat(row.budget_per_seller_max_pct) : null,
    budget_reallocation_threshold: row.budget_reallocation_threshold != null ? parseFloat(row.budget_reallocation_threshold) : null,
    channels_required: row.channels_required || [],
    channels_allowed: row.channels_allowed || [],
    channel_mix_targets: row.channel_mix_targets || {},
    countries: row.countries || [],
    regions: row.regions || [],
    approved_sellers: row.approved_sellers,
    resolved_policies: row.resolved_policies || [],
    ext: row.ext,
    flight_start: new Date(row.flight_start),
    flight_end: new Date(row.flight_end),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

function deserializeCheck(row: any): GovernanceCheck {
  return {
    ...row,
    findings: row.findings || [],
    conditions: row.conditions,
    escalation: row.escalation,
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
    next_check: row.next_check ? new Date(row.next_check) : null,
    created_at: new Date(row.created_at),
  };
}

function deserializeOutcome(row: any): GovernanceOutcome {
  return {
    ...row,
    committed_budget: row.committed_budget != null ? parseFloat(row.committed_budget) : null,
    findings: row.findings || [],
    created_at: new Date(row.created_at),
  };
}

// ── Plan operations ──

export async function upsertPlan(
  accountId: string,
  plan: {
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
  },
  resolvedPolicies: ResolvedPolicy[]
): Promise<GovernancePlan> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT version, account_id FROM governance_plans WHERE plan_id = $1 FOR UPDATE',
      [plan.plan_id]
    );

    // Verify ownership — prevent Account B from overwriting Account A's plan
    if (existing.rows.length > 0 && existing.rows[0].account_id !== accountId) {
      throw new Error(`Plan ${plan.plan_id} belongs to a different account`);
    }

    const newVersion = existing.rows.length > 0 ? existing.rows[0].version + 1 : 1;

    const result = await client.query<any>(
      `INSERT INTO governance_plans (
        plan_id, account_id, brand_domain, brand_id, objectives,
        budget_total, budget_currency, budget_authority_level,
        budget_per_seller_max_pct, budget_reallocation_threshold,
        channels_required, channels_allowed, channel_mix_targets,
        flight_start, flight_end, countries, regions, approved_sellers,
        resolved_policies, version, ext, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
      ON CONFLICT (plan_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        brand_domain = EXCLUDED.brand_domain,
        brand_id = EXCLUDED.brand_id,
        objectives = EXCLUDED.objectives,
        budget_total = EXCLUDED.budget_total,
        budget_currency = EXCLUDED.budget_currency,
        budget_authority_level = EXCLUDED.budget_authority_level,
        budget_per_seller_max_pct = EXCLUDED.budget_per_seller_max_pct,
        budget_reallocation_threshold = EXCLUDED.budget_reallocation_threshold,
        channels_required = EXCLUDED.channels_required,
        channels_allowed = EXCLUDED.channels_allowed,
        channel_mix_targets = EXCLUDED.channel_mix_targets,
        flight_start = EXCLUDED.flight_start,
        flight_end = EXCLUDED.flight_end,
        countries = EXCLUDED.countries,
        regions = EXCLUDED.regions,
        approved_sellers = EXCLUDED.approved_sellers,
        resolved_policies = EXCLUDED.resolved_policies,
        version = $20,
        ext = EXCLUDED.ext,
        updated_at = NOW()
      RETURNING *`,
      [
        plan.plan_id,
        accountId,
        plan.brand.domain,
        plan.brand.brand_id || null,
        plan.objectives,
        plan.budget.total,
        plan.budget.currency,
        plan.budget.authority_level,
        plan.budget.per_seller_max_pct ?? null,
        plan.budget.reallocation_threshold ?? null,
        JSON.stringify(plan.channels?.required || []),
        JSON.stringify(plan.channels?.allowed || []),
        JSON.stringify(plan.channels?.mix_targets || {}),
        plan.flight.start,
        plan.flight.end,
        JSON.stringify(plan.countries || []),
        JSON.stringify(plan.regions || []),
        plan.approved_sellers != null ? JSON.stringify(plan.approved_sellers) : null,
        JSON.stringify(resolvedPolicies),
        newVersion,
        plan.ext ? JSON.stringify(plan.ext) : null,
      ]
    );

    await client.query('COMMIT');
    return deserializePlan(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getPlan(planId: string): Promise<GovernancePlan | null> {
  const result = await query<any>(
    'SELECT * FROM governance_plans WHERE plan_id = $1',
    [planId]
  );
  return result.rows.length > 0 ? deserializePlan(result.rows[0]) : null;
}

// ── Check operations ──

export async function insertCheck(check: {
  plan_id: string;
  buyer_campaign_ref: string;
  binding: 'proposed' | 'committed';
  caller: string;
  phase?: string;
  tool?: string;
  payload?: Record<string, unknown>;
  media_buy_id?: string;
  buyer_ref?: string;
  planned_delivery?: Record<string, unknown>;
  delivery_metrics?: Record<string, unknown>;
  modification_summary?: string;
  status: 'approved' | 'denied' | 'conditions' | 'escalated';
  explanation: string;
  findings?: Finding[];
  conditions?: Condition[];
  escalation?: Record<string, unknown>;
  expires_at?: Date;
  next_check?: Date;
}): Promise<GovernanceCheck> {
  const checkId = `chk_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const result = await query<any>(
    `INSERT INTO governance_checks (
      check_id, plan_id, buyer_campaign_ref, binding, caller, phase,
      tool, payload, media_buy_id, buyer_ref,
      planned_delivery, delivery_metrics, modification_summary,
      status, explanation, findings, conditions, escalation,
      expires_at, next_check
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING *`,
    [
      checkId,
      check.plan_id,
      check.buyer_campaign_ref,
      check.binding,
      check.caller,
      check.phase || 'purchase',
      check.tool || null,
      check.payload ? JSON.stringify(check.payload) : null,
      check.media_buy_id || null,
      check.buyer_ref || null,
      check.planned_delivery ? JSON.stringify(check.planned_delivery) : null,
      check.delivery_metrics ? JSON.stringify(check.delivery_metrics) : null,
      check.modification_summary || null,
      check.status,
      check.explanation,
      JSON.stringify(check.findings || []),
      check.conditions ? JSON.stringify(check.conditions) : null,
      check.escalation ? JSON.stringify(check.escalation) : null,
      check.expires_at || null,
      check.next_check || null,
    ]
  );

  return deserializeCheck(result.rows[0]);
}

export async function getCheck(checkId: string): Promise<GovernanceCheck | null> {
  const result = await query<any>(
    'SELECT * FROM governance_checks WHERE check_id = $1',
    [checkId]
  );
  return result.rows.length > 0 ? deserializeCheck(result.rows[0]) : null;
}

// ── Outcome operations ──

export async function insertOutcome(outcome: {
  plan_id: string;
  check_id?: string;
  buyer_campaign_ref: string;
  outcome: 'completed' | 'failed' | 'delivery';
  seller_response?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  error?: Record<string, unknown>;
  committed_budget?: number;
  status: 'accepted' | 'findings';
  findings?: Finding[];
}): Promise<GovernanceOutcome> {
  const outcomeId = `out_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const result = await query<any>(
    `INSERT INTO governance_outcomes (
      outcome_id, plan_id, check_id, buyer_campaign_ref, outcome,
      seller_response, delivery, error,
      committed_budget, status, findings
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *`,
    [
      outcomeId,
      outcome.plan_id,
      outcome.check_id || null,
      outcome.buyer_campaign_ref,
      outcome.outcome,
      outcome.seller_response ? JSON.stringify(outcome.seller_response) : null,
      outcome.delivery ? JSON.stringify(outcome.delivery) : null,
      outcome.error ? JSON.stringify(outcome.error) : null,
      outcome.committed_budget ?? null,
      outcome.status,
      JSON.stringify(outcome.findings || []),
    ]
  );

  return deserializeOutcome(result.rows[0]);
}

// ── Budget summary ──

export async function getBudgetSummary(planId: string): Promise<BudgetSummary | null> {
  const result = await query<any>(
    'SELECT * FROM governance_budget_summary WHERE plan_id = $1',
    [planId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    plan_id: row.plan_id,
    budget_total: parseFloat(row.budget_total),
    budget_currency: row.budget_currency,
    total_committed: parseFloat(row.total_committed),
    budget_remaining: parseFloat(row.budget_remaining),
  };
}

// ── Audit log queries ──

export async function getChecksForPlan(
  planId: string,
  buyerCampaignRef?: string,
  limit = 200
): Promise<GovernanceCheck[]> {
  const conditions = ['plan_id = $1'];
  const params: unknown[] = [planId];
  let paramIdx = 2;
  if (buyerCampaignRef) {
    conditions.push(`buyer_campaign_ref = $${paramIdx++}`);
    params.push(buyerCampaignRef);
  }
  params.push(limit);
  const result = await query<any>(
    `SELECT * FROM governance_checks WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT $${paramIdx}`,
    params
  );
  return result.rows.map(deserializeCheck);
}

export async function getOutcomesForPlan(
  planId: string,
  buyerCampaignRef?: string,
  limit = 200
): Promise<GovernanceOutcome[]> {
  const conditions = ['plan_id = $1'];
  const params: unknown[] = [planId];
  let paramIdx = 2;
  if (buyerCampaignRef) {
    conditions.push(`buyer_campaign_ref = $${paramIdx++}`);
    params.push(buyerCampaignRef);
  }
  params.push(limit);
  const result = await query<any>(
    `SELECT * FROM governance_outcomes WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT $${paramIdx}`,
    params
  );
  return result.rows.map(deserializeOutcome);
}

export async function getCheckAndOutcomeStats(
  planId: string,
  buyerCampaignRef?: string
): Promise<{
  checks_performed: number;
  outcomes_reported: number;
  statuses: { approved: number; denied: number; conditions: number; escalated: number };
  findings_count: number;
}> {
  const refCondition = buyerCampaignRef ? ' AND buyer_campaign_ref = $2' : '';
  const params: unknown[] = buyerCampaignRef ? [planId, buyerCampaignRef] : [planId];

  const [checkStats, outcomeStats] = await Promise.all([
    query<any>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'denied') as denied,
        COUNT(*) FILTER (WHERE status = 'conditions') as conditions_count,
        COUNT(*) FILTER (WHERE status = 'escalated') as escalated,
        SUM(jsonb_array_length(findings)) as findings_count
      FROM governance_checks WHERE plan_id = $1${refCondition}`,
      params
    ),
    query<any>(
      `SELECT COUNT(*) as total FROM governance_outcomes WHERE plan_id = $1${refCondition}`,
      params
    ),
  ]);

  const cs = checkStats.rows[0];
  return {
    checks_performed: parseInt(cs.total, 10),
    outcomes_reported: parseInt(outcomeStats.rows[0].total, 10),
    statuses: {
      approved: parseInt(cs.approved, 10),
      denied: parseInt(cs.denied, 10),
      conditions: parseInt(cs.conditions_count, 10),
      escalated: parseInt(cs.escalated, 10),
    },
    findings_count: parseInt(cs.findings_count || '0', 10),
  };
}

export async function getCampaignSummaries(planId: string): Promise<Array<{
  buyer_campaign_ref: string;
  status: string;
  committed: number;
  active_media_buys: string[];
}>> {
  const result = await query<any>(
    `SELECT
      buyer_campaign_ref,
      COALESCE(SUM(committed_budget) FILTER (WHERE outcome = 'completed'), 0) as committed,
      ARRAY_AGG(DISTINCT (seller_response->>'media_buy_id')) FILTER (WHERE seller_response->>'media_buy_id' IS NOT NULL) as active_media_buys
    FROM governance_outcomes
    WHERE plan_id = $1
    GROUP BY buyer_campaign_ref`,
    [planId]
  );

  return result.rows.map((row: any) => ({
    buyer_campaign_ref: row.buyer_campaign_ref,
    status: 'active',
    committed: parseFloat(row.committed || '0'),
    active_media_buys: (row.active_media_buys || []).filter(Boolean),
  }));
}

export async function getEscalations(planId: string): Promise<Array<{
  check_id: string;
  reason: string;
  resolution?: string;
  resolved_at?: string;
}>> {
  const result = await query<any>(
    `SELECT check_id, escalation->>'reason' as reason
    FROM governance_checks
    WHERE plan_id = $1 AND status = 'escalated'
    ORDER BY created_at DESC`,
    [planId]
  );
  return result.rows.map((row: any) => ({
    check_id: row.check_id,
    reason: row.reason || 'Requires human review',
  }));
}
