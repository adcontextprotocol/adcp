import type { PoolClient } from 'pg';
import { getPool, query } from './client.js';
import {
  getStripeSubscriptionInfo,
  listCustomersWithOrgIds,
  listAllStripeCustomers,
  listCustomerIdsWithLiveSubscriptions,
  type StripeCustomerSummary,
} from '../billing/stripe-client.js';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { CompanyTypeValue } from '../config/company-types.js';
import type { Agreement } from '../types.js';
import { OrgKnowledgeDatabase } from './org-knowledge-db.js';

// Re-export Agreement for backwards compatibility
export type { Agreement };

const logger = createLogger('organization-db');
const orgKnowledgeDb = new OrgKnowledgeDatabase();

/**
 * Error thrown when trying to link a Stripe customer that's already linked to another organization
 */
export class StripeCustomerConflictError extends Error {
  constructor(
    public stripeCustomerId: string,
    public targetOrgId: string,
    public existingOrgId: string,
    public existingOrgName: string
  ) {
    super(
      `Stripe customer ${stripeCustomerId} is already linked to organization "${existingOrgName}" (${existingOrgId}). ` +
      `Cannot link to ${targetOrgId}. Use force option or resolve the conflict manually.`
    );
    this.name = 'StripeCustomerConflictError';
  }
}

export type CompanyType = CompanyTypeValue;
export type RevenueTier = 'under_1m' | '1m_5m' | '5m_50m' | '50m_250m' | '250m_1b' | '1b_plus';
export type MembershipTier = 'individual_professional' | 'individual_academic' | 'company_standard' | 'company_icl' | 'company_leader';
export type SeatType = 'contributor' | 'community_only';

/**
 * Stripe subscription statuses that represent a paid relationship.
 * Tier should be preserved during payment retries (past_due) and trials.
 */
export const TIER_PRESERVING_STATUSES = ['active', 'past_due', 'trialing'] as const;

export interface SeatLimits {
  contributor: number;
  community: number; // -1 = unlimited
}

export const SEAT_LIMITS: Record<string, SeatLimits> = {
  individual_professional: { contributor: 1, community: 0 },
  individual_academic:     { contributor: 0, community: 1 },
  company_standard:        { contributor: 5, community: 5 },
  company_icl:             { contributor: 10, community: 50 },
  company_leader:          { contributor: 20, community: -1 },
};

export const DEFAULT_SEAT_LIMITS: SeatLimits = { contributor: 0, community: 1 };

/**
 * Valid revenue tier values for runtime validation
 */
export const VALID_REVENUE_TIERS: readonly RevenueTier[] = [
  'under_1m',
  '1m_5m',
  '5m_50m',
  '50m_250m',
  '250m_1b',
  '1b_plus',
] as const;

/**
 * Valid membership tier values for runtime validation
 */
export const VALID_MEMBERSHIP_TIERS: readonly MembershipTier[] = [
  'individual_professional',
  'individual_academic',
  'company_standard',
  'company_icl',
  'company_leader',
] as const;

/**
 * Membership tiers with API access (contributor seats > 0).
 * Explorer (individual_academic) is intentionally excluded.
 * Used to gate features like public agent listing and the members-only
 * discovery pool.
 */
export const API_ACCESS_TIERS: readonly MembershipTier[] = [
  'individual_professional',
  'company_standard',
  'company_icl',
  'company_leader',
] as const;

/**
 * True when the tier grants API access (and therefore the ability to set
 * agents as publicly listed and to view the members-only discovery pool).
 */
export function hasApiAccess(tier: MembershipTier | null | undefined): boolean {
  if (!tier) return false;
  return (API_ACCESS_TIERS as readonly string[]).includes(tier);
}

export interface Organization {
  workos_organization_id: string;
  name: string;
  is_personal: boolean;
  company_type: CompanyType | null; // Deprecated: use company_types
  company_types: CompanyType[] | null;
  revenue_tier: RevenueTier | null;
  membership_tier: MembershipTier | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  agreement_signed_at: Date | null;
  agreement_version: string | null;
  pending_agreement_version: string | null;
  pending_agreement_accepted_at: Date | null;
  pending_agreement_user_id: string | null;
  subscription_status: string | null;
  subscription_current_period_end: Date | null;
  subscription_product_id: string | null;
  subscription_product_name: string | null;
  subscription_price_id: string | null;
  subscription_price_lookup_key: string | null;
  subscription_amount: number | null;
  subscription_currency: string | null;
  subscription_interval: string | null;
  subscription_canceled_at: Date | null;
  subscription_metadata: any | null;
  discount_percent: number | null;
  discount_amount_cents: number | null;
  discount_reason: string | null;
  discount_granted_by: string | null;
  discount_granted_at: Date | null;
  stripe_coupon_id: string | null;
  stripe_promotion_code: string | null;
  billing_address: BillingAddress | null;
  auto_provision_verified_domain: boolean;
  auto_provision_brand_hierarchy_children: boolean;
  auto_provision_hierarchy_enabled_at: Date | null;
  auto_provision_hierarchy_disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

export interface SubscriptionInfo {
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'none';
  product_id?: string;
  product_name?: string;
  lookup_key?: string;
  amount_cents?: number;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
}

export interface AuditLogEntry {
  workos_organization_id: string;
  workos_user_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, any>;
  /** The actual authenticated WorkOS user when id-swap is in effect (non-primary binding). Merged into details automatically by recordAuditLog. */
  auth_workos_user_id?: string;
}

/**
 * Get seat limits for a membership tier.
 */
export function getSeatLimits(tier: string | null): SeatLimits {
  if (!tier) return DEFAULT_SEAT_LIMITS;
  return SEAT_LIMITS[tier] || DEFAULT_SEAT_LIMITS;
}

/**
 * Map Stripe price lookup key to membership tier.
 *
 * Covers both current tier products (Explorer, Professional, Builder, Partner, Leader)
 * and legacy founding-member products (individual, individual_discounted, corporate_*,
 * industry_council_leader). Sorted by descending prefix length so that more-specific
 * keys (e.g. "individual_discounted") match before shorter ones ("individual").
 */
const LOOKUP_KEY_TIERS: [prefix: string, tier: MembershipTier][] = ([
  // Current tier products
  ['aao_membership_explorer', 'individual_academic'],
  ['aao_membership_professional', 'individual_professional'],
  ['aao_membership_builder', 'company_standard'],
  ['aao_membership_member', 'company_icl'],
  ['aao_membership_partner', 'company_icl'],
  ['aao_membership_leader', 'company_leader'],
  // Legacy founding-member products
  ['aao_membership_individual_discounted', 'individual_academic'],
  ['aao_membership_individual', 'individual_professional'],
  ['aao_membership_corporate_under5m', 'company_standard'],
  ['aao_membership_corporate', 'company_icl'],
  ['aao_membership_industry_council_leader', 'company_leader'],
] as [string, MembershipTier][]).sort((a, b) => b[0].length - a[0].length);

/**
 * Resolve tier from a Stripe price lookup key.
 * Matches the tier portion of keys like "aao_membership_professional_250".
 */
export function tierFromLookupKey(lookupKey: string | null | undefined): MembershipTier | null {
  if (!lookupKey) return null;
  for (const [prefix, tier] of LOOKUP_KEY_TIERS) {
    if (lookupKey.startsWith(prefix)) return tier;
  }
  return null;
}

/**
 * Input shape for `resolveMembershipTier`. Kept as a named type so the
 * companion SQL helpers below can declare a matching row type, and so
 * a future resolver change that needs a new column surfaces every
 * consumer via TS.
 */
export interface MembershipTierRow {
  membership_tier: string | null;
  subscription_price_lookup_key?: string | null;
  subscription_status: string | null;
  subscription_amount: number | null;
  subscription_interval: string | null;
  is_personal: boolean;
}

/**
 * Column list the resolver requires from the `organizations` table.
 * Single source of truth for handlers that issue their own SELECT
 * (typically inside a transaction) and then hand the row to
 * `resolveMembershipTier`. Extending the resolver to consider a new
 * column means adding it here AND to `MembershipTierRow` — TS will
 * then surface every call site that needs to be updated.
 */
export const MEMBERSHIP_TIER_COLUMNS = [
  'membership_tier',
  'subscription_price_lookup_key',
  'subscription_status',
  'subscription_amount',
  'subscription_interval',
  'is_personal',
] as const;

/**
 * Resolve the effective membership tier for an organization.
 * Fallback chain: cached tier → stored lookup key → amount inference.
 * Only falls back for tier-preserving statuses (active, past_due, trialing).
 */
export function resolveMembershipTier(org: MembershipTierRow | null | undefined): MembershipTier | null {
  if (!org) return null;
  if (org.membership_tier) return org.membership_tier as MembershipTier;
  if (!(TIER_PRESERVING_STATUSES as readonly string[]).includes(org.subscription_status ?? '')) return null;
  return tierFromLookupKey(org.subscription_price_lookup_key)
    ?? inferMembershipTier(org.subscription_amount, org.subscription_interval, org.is_personal);
}

/**
 * Read + resolve the current membership tier for `orgId` using a
 * caller-held pg client. Prefer this to inline SQL when the read
 * must share a transaction with subsequent writes (e.g.,
 * `applyAgentVisibility` re-reads the tier under `FOR UPDATE` after
 * locking `member_profiles`). Pass `{ forUpdate: true }` when the
 * caller needs to lock the organizations row as well.
 */
export async function readMembershipTierFromClient(
  client: PoolClient,
  orgId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<MembershipTier | null> {
  const lockSuffix = opts.forUpdate ? ' FOR UPDATE' : '';
  const sql = `SELECT ${MEMBERSHIP_TIER_COLUMNS.join(', ')} FROM organizations WHERE workos_organization_id = $1${lockSuffix}`;
  const result = await client.query<MembershipTierRow>(sql, [orgId]);
  return resolveMembershipTier(result.rows[0] ?? null);
}

/**
 * Infer membership tier from subscription amount and organization type.
 * Used as a fallback when no lookup key is available (e.g., legacy founding
 * member products). Amounts are in cents. Monthly amounts are annualized.
 *
 * Thresholds are set ~4% below the nominal annual price to account for
 * integer-cent rounding on monthly billing. For example, $250/yr billed
 * monthly is $20.83/mo = 2083¢. Annualized: 2083 × 12 = 24 996¢, which
 * falls short of an exact 25 000¢ threshold.
 *
 * Tier mapping (annual):
 *   Individual: Explorer ($50) → individual_academic, Professional ($250+) → individual_professional
 *   Company:    Builder ($2.5K+) → company_standard, Partner ($7K+) → company_icl, Leader ($50K+) → company_leader
 */
export function inferMembershipTier(
  amountCents: number | null,
  interval: string | null,
  isPersonal: boolean
): MembershipTier | null {
  if (amountCents == null || amountCents === 0) return null;

  const annualCents = interval === 'month' ? amountCents * 12 : amountCents;

  if (isPersonal) {
    if (annualCents >= 24000) return 'individual_professional';
    if (annualCents >= 4500) return 'individual_academic';
    return null;
  }

  if (annualCents >= 4900000) return 'company_leader';
  if (annualCents >= 700000) return 'company_icl';
  return 'company_standard';
}

/**
 * Fields to write when syncing subscription data from Stripe.
 * Built by `buildSubscriptionUpdate()` so all write paths store identical data.
 */
export interface SubscriptionUpdatePayload {
  subscription_status: string;
  stripe_subscription_id: string;
  subscription_current_period_end: Date | null;
  subscription_amount: number | null;
  subscription_currency: string | null;
  subscription_interval: string | null;
  subscription_canceled_at: Date | null;
  subscription_product_id: string | null;
  subscription_product_name: string | null;
  subscription_price_id: string | null;
  subscription_price_lookup_key: string | null;
  membership_tier: MembershipTier | null;
}

/**
 * Extract subscription fields from a Stripe subscription object.
 * Single source of truth for tier resolution — all write paths should use this.
 */
export function buildSubscriptionUpdate(
  subscription: {
    status: string;
    id: string;
    current_period_end: number | null;
    canceled_at: number | null;
    items: { data: Array<{ price: {
      unit_amount: number | null;
      currency: string;
      recurring: { interval: string } | null;
      id: string;
      product: string | { id: string; name?: string };
      lookup_key: string | null;
    } }> };
  },
  isPersonal: boolean,
): SubscriptionUpdatePayload {
  const priceData = subscription.items?.data?.[0]?.price;
  const amount = priceData?.unit_amount ?? null;
  const currency = priceData?.currency ?? null;
  const interval = priceData?.recurring?.interval ?? null;
  const lookupKey = priceData?.lookup_key ?? null;
  const productRef = priceData?.product;
  const productId = typeof productRef === 'string' ? productRef : productRef?.id ?? null;
  const productName = typeof productRef === 'object' ? productRef?.name ?? null : null;

  const membershipTier = (TIER_PRESERVING_STATUSES as readonly string[]).includes(subscription.status)
    ? (tierFromLookupKey(lookupKey) ?? inferMembershipTier(amount, interval, isPersonal))
    : null;

  return {
    subscription_status: subscription.status,
    stripe_subscription_id: subscription.id,
    subscription_current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000) : null,
    subscription_amount: amount,
    subscription_currency: currency,
    subscription_interval: interval,
    subscription_canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000) : null,
    subscription_product_id: productId,
    subscription_product_name: productName,
    subscription_price_id: priceData?.id ?? null,
    subscription_price_lookup_key: lookupKey,
    membership_tier: membershipTier,
  };
}

/**
 * Count current seat usage by type for an organization.
 * A member is a contributor if any of:
 *   - admin assigned seat_type = 'contributor'
 *   - they have a mapped Slack account
 *   - they are an active member of a working group
 */
export async function getSeatUsage(orgId: string): Promise<{ contributor: number; community_only: number }> {
  const pool = getPool();
  const result = await pool.query<{ total: string; contributor: string }>(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE
         om.seat_type = 'contributor'
         OR EXISTS (SELECT 1 FROM slack_user_mappings sm WHERE sm.workos_user_id = om.workos_user_id AND sm.mapping_status = 'mapped')
         OR EXISTS (SELECT 1 FROM working_group_memberships wgm WHERE wgm.workos_user_id = om.workos_user_id AND wgm.status = 'active')
       ) as contributor
     FROM organization_memberships om
     WHERE om.workos_organization_id = $1`,
    [orgId]
  );
  const total = parseInt(result.rows[0]?.total ?? '0', 10);
  const contributor = parseInt(result.rows[0]?.contributor ?? '0', 10);
  return { contributor, community_only: total - contributor };
}

/**
 * Check whether a new seat of the given type can be added to an organization.
 * Uses SELECT FOR UPDATE on the org row to serialize concurrent seat checks,
 * and counts pending invitations as reserved seats.
 */
export async function canAddSeat(
  orgId: string,
  seatType: SeatType
): Promise<{ allowed: boolean; reason?: string }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the org row to serialize concurrent seat checks and resolve
    // the tier from the same (locked) read.
    const tier = await readMembershipTierFromClient(client, orgId, { forUpdate: true });
    const limits = getSeatLimits(tier);

    // Count active members (contributor = admin-assigned OR Slack-mapped OR in working group)
    const memberResult = await client.query<{ total: string; contributor: string }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE
           om.seat_type = 'contributor'
           OR EXISTS (SELECT 1 FROM slack_user_mappings sm WHERE sm.workos_user_id = om.workos_user_id AND sm.mapping_status = 'mapped')
           OR EXISTS (SELECT 1 FROM working_group_memberships wgm WHERE wgm.workos_user_id = om.workos_user_id AND wgm.status = 'active')
         ) as contributor
       FROM organization_memberships om
       WHERE om.workos_organization_id = $1`,
      [orgId]
    );
    const total = parseInt(memberResult.rows[0]?.total ?? '0', 10);
    const contributors = parseInt(memberResult.rows[0]?.contributor ?? '0', 10);

    // Pending invitations also reserve seats
    const pendingResult = await client.query<{ seat_type: string; count: string }>(
      `SELECT seat_type, COUNT(*) as count FROM invitation_seat_types WHERE workos_organization_id = $1 GROUP BY seat_type`,
      [orgId]
    );
    let pendingContributors = 0;
    let pendingCommunity = 0;
    for (const row of pendingResult.rows) {
      if (row.seat_type === 'contributor') pendingContributors = parseInt(row.count, 10);
      if (row.seat_type === 'community_only') pendingCommunity = parseInt(row.count, 10);
    }

    const usage = {
      contributor: contributors + pendingContributors,
      community_only: (total - contributors) + pendingCommunity,
    };

    await client.query('COMMIT');

    const limit = seatType === 'contributor' ? limits.contributor : limits.community;
    const used = seatType === 'contributor' ? usage.contributor : usage.community_only;

    if (limit === -1) return { allowed: true };
    if (limit === 0) return { allowed: false, reason: `Your membership tier does not include ${seatType === 'contributor' ? 'contributor' : 'community'} seats. Upgrade at /membership.` };
    if (used >= limit) return { allowed: false, reason: `All ${limit} ${seatType === 'contributor' ? 'contributor' : 'community'} seats are in use. Upgrade at /membership to add more.` };
    return { allowed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get a user's effective seat type. A user is a contributor if any of:
 *   - admin assigned seat_type = 'contributor'
 *   - they have a mapped Slack account
 *   - they are an active member of a working group
 */
export async function getUserSeatType(userId: string): Promise<SeatType | null> {
  const pool = getPool();
  const result = await pool.query<{ is_contributor: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM organization_memberships WHERE workos_user_id = $1 AND seat_type = 'contributor')
       OR EXISTS (SELECT 1 FROM slack_user_mappings WHERE workos_user_id = $1 AND mapping_status = 'mapped')
       OR EXISTS (SELECT 1 FROM working_group_memberships WHERE workos_user_id = $1 AND status = 'active')
     ) as is_contributor
     FROM organization_memberships WHERE workos_user_id = $1 LIMIT 1`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0]?.is_contributor ? 'contributor' : 'community_only';
}

// ==================== Seat Warning Threshold Management ====================

export interface SeatWarningResult {
  shouldNotify: boolean;
  threshold: 80 | 100;
}

/**
 * Check whether seat usage has crossed a notification threshold and atomically
 * update the stored threshold to prevent duplicate notifications.
 *
 * Uses hysteresis: the 80% threshold re-arms when usage drops below 60%.
 * Individual tiers (1-seat plans) are excluded from percentage-based warnings.
 *
 * Returns null if no notification needed, or the threshold to notify at.
 */
export async function checkAndUpdateSeatWarning(
  orgId: string,
  seatType: 'contributor' | 'community',
  usage: number,
  limit: number,
  tier: string | null
): Promise<SeatWarningResult | null> {
  // Skip individual tiers (percentage-based warnings are meaningless for 1 seat)
  if (tier?.startsWith('individual_')) return null;

  // Skip unlimited or zero-limit seat types
  if (limit <= 0) return null;

  const VALID_COLUMNS = ['last_contributor_seat_warning', 'last_community_seat_warning'] as const;
  const column = seatType === 'contributor' ? VALID_COLUMNS[0] : VALID_COLUMNS[1];

  const percentage = (usage / limit) * 100;
  const pool = getPool();

  // If at or above 100%, try to upgrade threshold to 100
  if (percentage >= 100) {
    const result = await pool.query(
      `UPDATE organizations SET ${column} = 100, updated_at = NOW()
       WHERE workos_organization_id = $1 AND ${column} < 100
       RETURNING workos_organization_id`,
      [orgId]
    );
    if (result.rows.length > 0) {
      return { shouldNotify: true, threshold: 100 };
    }
    return null;
  }

  // If at or above 80%, try to upgrade threshold to 80
  if (percentage >= 80) {
    const result = await pool.query(
      `UPDATE organizations SET ${column} = 80, updated_at = NOW()
       WHERE workos_organization_id = $1 AND ${column} < 80
       RETURNING workos_organization_id`,
      [orgId]
    );
    if (result.rows.length > 0) {
      return { shouldNotify: true, threshold: 80 };
    }
    return null;
  }

  // If below 60%, re-arm the threshold (hysteresis)
  if (percentage < 60) {
    await pool.query(
      `UPDATE organizations SET ${column} = 0, updated_at = NOW()
       WHERE workos_organization_id = $1 AND ${column} > 0`,
      [orgId]
    );
  }

  return null;
}

/**
 * Reset seat warning threshold when a seat frees up.
 * Returns the previous threshold so callers know whether to send a "seat freed" notification.
 */
export async function resetSeatWarningIfNeeded(
  orgId: string,
  seatType: 'contributor' | 'community',
  newUsage: number,
  limit: number
): Promise<number> {
  if (limit <= 0) return 0;

  const column = seatType === 'contributor'
    ? 'last_contributor_seat_warning'
    : 'last_community_seat_warning';

  const percentage = (newUsage / limit) * 100;

  // Compute new threshold with hysteresis: preserve current value in the 60-79% band
  // so re-adding a member after removal doesn't re-trigger the 80% warning
  let newThreshold: number;
  if (percentage >= 100) newThreshold = 100;
  else if (percentage >= 80) newThreshold = 80;
  else if (percentage < 60) newThreshold = 0;
  else {
    // 60-79% band: preserve current threshold (hysteresis)
    const current = await query<{ val: number }>(
      `SELECT ${column} AS val FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    );
    newThreshold = current.rows[0]?.val ?? 0;
  }

  // Capture old value via CTE before updating
  const result = await query<{ old_threshold: number }>(
    `WITH old AS (
       SELECT ${column} AS val FROM organizations WHERE workos_organization_id = $1
     )
     UPDATE organizations
     SET ${column} = $2, updated_at = NOW()
     WHERE workos_organization_id = $1
     RETURNING (SELECT val FROM old) AS old_threshold`,
    [orgId, newThreshold]
  );

  return result.rows[0]?.old_threshold ?? 0;
}

// ==================== Seat Upgrade Requests ====================

export interface SeatUpgradeRequest {
  id: string;
  workos_organization_id: string;
  workos_user_id: string;
  requested_seat_type: string;
  resource_type: string;
  resource_id: string | null;
  resource_name: string | null;
  status: 'pending' | 'approved' | 'denied';
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  admin_reminder_sent_at: Date | null;
  member_timeout_notified_at: Date | null;
}

export async function createSeatUpgradeRequest(data: {
  orgId: string;
  userId: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
}): Promise<SeatUpgradeRequest> {
  const pool = getPool();
  const result = await pool.query<SeatUpgradeRequest>(
    `INSERT INTO seat_upgrade_requests (workos_organization_id, workos_user_id, resource_type, resource_id, resource_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.orgId, data.userId, data.resourceType, data.resourceId || '', data.resourceName || null]
  );
  return result.rows[0];
}

export async function getSeatUpgradeRequest(requestId: string): Promise<SeatUpgradeRequest | null> {
  const pool = getPool();
  const result = await pool.query<SeatUpgradeRequest>(
    'SELECT * FROM seat_upgrade_requests WHERE id = $1',
    [requestId]
  );
  return result.rows[0] || null;
}

export async function listSeatUpgradeRequests(
  orgId: string,
  options?: { userId?: string; status?: string }
): Promise<SeatUpgradeRequest[]> {
  const pool = getPool();
  const conditions = ['workos_organization_id = $1'];
  const params: any[] = [orgId];

  if (options?.userId) {
    conditions.push(`workos_user_id = $${params.length + 1}`);
    params.push(options.userId);
  }
  if (options?.status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(options.status);
  }

  const result = await pool.query<SeatUpgradeRequest>(
    `SELECT * FROM seat_upgrade_requests WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

export async function resolveSeatUpgradeRequest(
  requestId: string,
  status: 'approved' | 'denied',
  resolvedBy: string
): Promise<SeatUpgradeRequest | null> {
  const pool = getPool();
  const result = await pool.query<SeatUpgradeRequest>(
    `UPDATE seat_upgrade_requests
     SET status = $1, resolved_at = NOW(), resolved_by = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING *`,
    [status, resolvedBy, requestId]
  );
  return result.rows[0] || null;
}

export async function hasPendingSeatRequest(
  orgId: string,
  userId: string,
  resourceType: string,
  resourceId?: string
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM seat_upgrade_requests
       WHERE workos_organization_id = $1
         AND workos_user_id = $2
         AND resource_type = $3
         AND COALESCE(resource_id, '') = COALESCE($4, '')
         AND status = 'pending'
     ) as exists`,
    [orgId, userId, resourceType, resourceId || '']
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Find stale pending requests for sending reminders/timeout notifications.
 */
export async function findStaleSeatRequests(): Promise<{
  needsAdminReminder: SeatUpgradeRequest[];
  needsMemberTimeout: SeatUpgradeRequest[];
}> {
  const pool = getPool();

  const [adminResult, memberResult] = await Promise.all([
    pool.query<SeatUpgradeRequest>(
      `SELECT * FROM seat_upgrade_requests
       WHERE status = 'pending'
         AND admin_reminder_sent_at IS NULL
         AND created_at < NOW() - INTERVAL '48 hours'
       LIMIT 100`
    ),
    pool.query<SeatUpgradeRequest>(
      `SELECT * FROM seat_upgrade_requests
       WHERE status = 'pending'
         AND member_timeout_notified_at IS NULL
         AND created_at < NOW() - INTERVAL '7 days'
       LIMIT 100`
    ),
  ]);

  return {
    needsAdminReminder: adminResult.rows,
    needsMemberTimeout: memberResult.rows,
  };
}

export async function markAdminReminderSent(requestId: string): Promise<void> {
  await query(
    'UPDATE seat_upgrade_requests SET admin_reminder_sent_at = NOW() WHERE id = $1',
    [requestId]
  );
}

export async function markMemberTimeoutNotified(requestId: string): Promise<void> {
  await query(
    'UPDATE seat_upgrade_requests SET member_timeout_notified_at = NOW() WHERE id = $1',
    [requestId]
  );
}

export class OrganizationDatabase {
  /**
   * Create a new organization record (for billing/agreements)
   * Note: The WorkOS organization should already exist
   * Billing info comes from Stripe, not stored here
   */
  async createOrganization(data: {
    workos_organization_id: string;
    name: string;
    is_personal?: boolean;
    company_type?: CompanyType;
    revenue_tier?: RevenueTier;
    membership_tier?: MembershipTier;
  }): Promise<Organization> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, is_personal, company_type, revenue_tier, membership_tier)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.workos_organization_id,
        data.name,
        data.is_personal || false,
        data.company_type || null,
        data.revenue_tier || null,
        data.membership_tier || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get organization by WorkOS organization ID
   */
  async getOrganization(workos_organization_id: string): Promise<Organization | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM organizations WHERE workos_organization_id = $1',
      [workos_organization_id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update organization billing/agreement info
   * Uses explicit column mapping to prevent SQL injection
   */
  async updateOrganization(
    workos_organization_id: string,
    updates: Partial<Omit<Organization, 'workos_organization_id' | 'created_at' | 'updated_at'>>
  ): Promise<Organization> {
    // Explicit column mapping - keys are validated property names, values are SQL column names
    const COLUMN_MAP: Record<string, string> = {
      name: 'name',
      is_personal: 'is_personal',
      company_type: 'company_type',
      revenue_tier: 'revenue_tier',
      membership_tier: 'membership_tier',
      stripe_customer_id: 'stripe_customer_id',
      agreement_signed_at: 'agreement_signed_at',
      agreement_version: 'agreement_version',
      pending_agreement_version: 'pending_agreement_version',
      pending_agreement_accepted_at: 'pending_agreement_accepted_at',
      pending_agreement_user_id: 'pending_agreement_user_id',
      subscription_current_period_end: 'subscription_current_period_end',
      subscription_product_id: 'subscription_product_id',
      subscription_product_name: 'subscription_product_name',
      subscription_price_id: 'subscription_price_id',
      subscription_price_lookup_key: 'subscription_price_lookup_key',
      subscription_amount: 'subscription_amount',
      subscription_currency: 'subscription_currency',
      subscription_interval: 'subscription_interval',
      subscription_canceled_at: 'subscription_canceled_at',
      subscription_metadata: 'subscription_metadata',
      discount_percent: 'discount_percent',
      discount_amount_cents: 'discount_amount_cents',
      discount_reason: 'discount_reason',
      discount_granted_by: 'discount_granted_by',
      discount_granted_at: 'discount_granted_at',
      stripe_coupon_id: 'stripe_coupon_id',
      stripe_promotion_code: 'stripe_promotion_code',
      billing_address: 'billing_address',
      auto_provision_verified_domain: 'auto_provision_verified_domain',
      auto_provision_brand_hierarchy_children: 'auto_provision_brand_hierarchy_children',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key];
      if (!columnName) {
        throw new Error(`Invalid update field: ${key}`);
      }
      // Use the mapped column name (never user input)
      setClauses.push(`${columnName} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(workos_organization_id);

    const pool = getPool();
    const result = await pool.query(
      `UPDATE organizations
       SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE workos_organization_id = $${paramIndex}
       RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Get all organizations (for admin purposes)
   */
  async listOrganizations(): Promise<Organization[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM organizations ORDER BY created_at DESC'
    );
    return result.rows;
  }

  /**
   * Search organizations by name
   * Used for the "find your company" feature in onboarding
   * Returns non-personal organizations matching the search query
   */
  async searchOrganizations(options: {
    query?: string;
    excludeOrgIds?: string[];
    limit?: number;
  }): Promise<Array<{
    workos_organization_id: string;
    name: string;
    company_type: CompanyType | null;
    logo_url: string | null;
    tagline: string | null;
  }>> {
    const pool = getPool();
    const conditions: string[] = ['o.is_personal = false'];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Text search on organization name
    if (options.query && options.query.trim()) {
      // Escape special LIKE characters
      const escapedQuery = options.query.trim().replace(/[%_\\]/g, '\\$&');
      conditions.push(`o.name ILIKE $${paramIndex}`);
      params.push(`%${escapedQuery}%`);
      paramIndex++;
    }

    // Exclude specific orgs (e.g., orgs user is already a member of)
    if (options.excludeOrgIds && options.excludeOrgIds.length > 0) {
      conditions.push(`o.workos_organization_id != ALL($${paramIndex})`);
      params.push(options.excludeOrgIds);
      paramIndex++;
    }

    const limit = options.limit || 10;
    params.push(limit);

    const result = await pool.query(
      `SELECT
        o.workos_organization_id,
        o.name,
        o.company_type,
        COALESCE(hb.brand_json->'brands'->0->'logos'->0->>'url', hb.brand_json->'logos'->0->>'url') AS logo_url,
        mp.tagline
       FROM organizations o
       LEFT JOIN member_profiles mp ON mp.workos_organization_id = o.workos_organization_id
       LEFT JOIN LATERAL (
         SELECT brand_manifest AS brand_json FROM brands WHERE domain = mp.primary_brand_domain LIMIT 1
       ) hb ON true
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.name ASC
       LIMIT $${paramIndex}`,
      params
    );

    return result.rows;
  }

  /**
   * Delete an organization and all associated data
   */
  async deleteOrganization(workos_organization_id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      'DELETE FROM organizations WHERE workos_organization_id = $1',
      [workos_organization_id]
    );
  }

  // Agreement Management

  /**
   * Get the current (latest) agreement
   */
  async getCurrentAgreement(): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM agreements
       ORDER BY effective_date DESC,
         string_to_array(version, '.')::int[] DESC
       LIMIT 1`
    );
    return result.rows[0] || null;
  }

  /**
   * Get a specific agreement version
   */
  async getAgreement(version: string): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM agreements WHERE version = $1',
      [version]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new agreement version
   */
  async createAgreement(data: {
    version: string;
    text: string;
    effective_date: Date;
  }): Promise<Agreement> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO agreements (version, text, effective_date)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.version, data.text, data.effective_date]
    );
    return result.rows[0];
  }

  // Audit Log

  /**
   * Record an audit log entry
   */
  async recordAuditLog(entry: AuditLogEntry): Promise<void> {
    const pool = getPool();
    const details = entry.auth_workos_user_id
      ? { ...entry.details, auth_workos_user_id: entry.auth_workos_user_id }
      : entry.details;
    await pool.query(
      `INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.workos_organization_id,
        entry.workos_user_id,
        entry.action,
        entry.resource_type,
        entry.resource_id,
        JSON.stringify(details),
      ]
    );
  }

  /**
   * Get audit log entries with filtering and pagination
   */
  async getAuditLogs(options: {
    workos_organization_id?: string;
    action?: string;
    resource_type?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    entries: Array<{
      id: string;
      workos_organization_id: string;
      workos_user_id: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>;
    total: number;
  }> {
    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.workos_organization_id) {
      conditions.push(`workos_organization_id = $${paramIndex}`);
      params.push(options.workos_organization_id);
      paramIndex++;
    }

    if (options.action) {
      conditions.push(`action = $${paramIndex}`);
      params.push(options.action);
      paramIndex++;
    }

    if (options.resource_type) {
      conditions.push(`resource_type = $${paramIndex}`);
      params.push(options.resource_type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as count FROM registry_audit_log ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get entries
    const result = await pool.query(
      `SELECT id, workos_organization_id, workos_user_id, action, resource_type, resource_id, details, created_at
       FROM registry_audit_log
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      entries: result.rows,
      total,
    };
  }

  // Billing Methods

  /**
   * Set Stripe customer ID for an organization.
   * Checks for conflicts before setting - throws StripeCustomerConflictError if customer is already linked to another org.
   * @param options.force - If true, unlinks from existing org first (use with caution)
   */
  async setStripeCustomerId(
    workos_organization_id: string,
    stripe_customer_id: string,
    options?: { force?: boolean }
  ): Promise<void> {
    // Check if this customer ID is already assigned to another org
    const existingOrg = await this.getOrganizationByStripeCustomerId(stripe_customer_id);
    if (existingOrg && existingOrg.workos_organization_id !== workos_organization_id) {
      if (options?.force) {
        // Unlink from existing org first
        logger.warn(
          { stripeCustomerId: stripe_customer_id, fromOrgId: existingOrg.workos_organization_id, toOrgId: workos_organization_id },
          'Force-unlinking Stripe customer from existing organization'
        );
        await this.unlinkStripeCustomer(existingOrg.workos_organization_id);
      } else {
        throw new StripeCustomerConflictError(
          stripe_customer_id,
          workos_organization_id,
          existingOrg.workos_organization_id,
          existingOrg.name
        );
      }
    }

    const pool = getPool();
    await pool.query(
      'UPDATE organizations SET stripe_customer_id = $1, updated_at = NOW() WHERE workos_organization_id = $2',
      [stripe_customer_id, workos_organization_id]
    );
  }

  /**
   * Atomically get or create a Stripe customer for an organization.
   * Uses a conditional UPDATE (WHERE stripe_customer_id IS NULL) to prevent
   * concurrent customer creation without holding a transaction open during
   * the external Stripe API call.
   */
  async getOrCreateStripeCustomer(
    workos_organization_id: string,
    createFn: () => Promise<string | null>
  ): Promise<string | null> {
    const pool = getPool();

    const checkResult = await pool.query(
      `SELECT stripe_customer_id FROM organizations
       WHERE workos_organization_id = $1`,
      [workos_organization_id]
    );

    if (checkResult.rows.length === 0) {
      return null;
    }

    const existingCustomerId = checkResult.rows[0].stripe_customer_id;
    if (existingCustomerId) {
      return existingCustomerId;
    }

    const newCustomerId = await createFn();

    if (!newCustomerId) {
      return null;
    }

    try {
      const updateResult = await pool.query(
        `UPDATE organizations SET stripe_customer_id = $1, updated_at = NOW()
         WHERE workos_organization_id = $2 AND stripe_customer_id IS NULL
         RETURNING stripe_customer_id`,
        [newCustomerId, workos_organization_id]
      );

      if (updateResult.rows.length === 0) {
        logger.warn({ workos_organization_id, orphanedCustomerId: newCustomerId },
          'Stripe customer race: another request set stripe_customer_id first');
        const current = await pool.query(
          `SELECT stripe_customer_id FROM organizations
           WHERE workos_organization_id = $1`,
          [workos_organization_id]
        );
        return current.rows[0]?.stripe_customer_id ?? null;
      }

      return newCustomerId;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === '23505') {
        logger.warn({
          workos_organization_id,
          error: String(error),
        }, 'Stripe customer already linked to a different organization');
        return null;
      }
      throw error;
    }
  }

  /**
   * Unlink Stripe customer from an organization (set to null)
   */
  async unlinkStripeCustomer(workos_organization_id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      'UPDATE organizations SET stripe_customer_id = NULL, updated_at = NOW() WHERE workos_organization_id = $1',
      [workos_organization_id]
    );
  }

  /**
   * Find all Stripe customer ID conflicts between Stripe metadata and local DB.
   * Returns cases where Stripe says customer belongs to org A but DB has it linked to org B.
   */
  async findStripeCustomerConflicts(): Promise<Array<{
    stripe_customer_id: string;
    stripe_says_org_id: string;
    stripe_says_org_name: string | null;
    db_has_org_id: string;
    db_has_org_name: string;
  }>> {
    const conflicts: Array<{
      stripe_customer_id: string;
      stripe_says_org_id: string;
      stripe_says_org_name: string | null;
      db_has_org_id: string;
      db_has_org_name: string;
    }> = [];

    // Get all Stripe customers with org metadata
    const stripeCustomers = await listCustomersWithOrgIds();

    for (const { stripeCustomerId, workosOrgId } of stripeCustomers) {
      const dbOrg = await this.getOrganizationByStripeCustomerId(stripeCustomerId);
      if (dbOrg && dbOrg.workos_organization_id !== workosOrgId) {
        // Conflict: Stripe says org A, DB says org B
        const stripeOrg = await this.getOrganization(workosOrgId);
        conflicts.push({
          stripe_customer_id: stripeCustomerId,
          stripe_says_org_id: workosOrgId,
          stripe_says_org_name: stripeOrg?.name || null,
          db_has_org_id: dbOrg.workos_organization_id,
          db_has_org_name: dbOrg.name,
        });
      }
    }

    return conflicts;
  }

  /**
   * Find Stripe customers that look like duplicates of an org's linked customer.
   *
   * Three signals, in priority order:
   *   1. metadata — orphan customer's `metadata.workos_organization_id`
   *      points at the org (the original signal).
   *   2. email    — orphan customer shares email (case-insensitive) with the
   *      org's linked customer.
   *   3. name     — orphan customer shares name (trimmed, lower-cased) with
   *      the org's linked customer AND has a live (active/trialing/past_due)
   *      subscription.
   *
   * The ResponsiveAds case (#3200) had two customers with identical name and
   * email: one linked + one orphan with an active sub generating a duplicate
   * \$2,500 invoice. Metadata-only detection didn't surface it.
   *
   * Each mismatch carries `match_reason` so the resolver can pick the right
   * unwind (metadata-linked orphans typically merge cleanly; email/name
   * orphans may need manual sub cancel + invoice void in Stripe first).
   *
   * One mismatch per (org, orphan) pair — if the same orphan matches by
   * multiple signals, the first signal in priority order wins.
   */
  async findStripeCustomerMismatches(): Promise<Array<{
    org_id: string;
    org_name: string;
    db_customer_id: string;
    stripe_metadata_customer_id: string;
    match_reason: 'metadata' | 'email' | 'name';
  }>> {
    type Mismatch = {
      org_id: string;
      org_name: string;
      db_customer_id: string;
      stripe_metadata_customer_id: string;
      match_reason: 'metadata' | 'email' | 'name';
    };

    const allCustomers = await listAllStripeCustomers();
    const liveSubCustomerIds = await listCustomerIdsWithLiveSubscriptions();

    const customerById = new Map<string, StripeCustomerSummary>();
    for (const c of allCustomers) customerById.set(c.id, c);

    // For each org with a linked Stripe customer, collect candidate orphans
    // by metadata, email, and name and emit one mismatch per (org, orphan)
    // pair. `seenPairs` keys "<orgId>:<orphanId>" so we don't emit duplicates
    // when an orphan matches by multiple signals.
    const linkedOrgsResult = await getPool().query<{
      workos_organization_id: string;
      name: string;
      stripe_customer_id: string;
    }>(
      `SELECT workos_organization_id, name, stripe_customer_id
       FROM organizations
       WHERE stripe_customer_id IS NOT NULL
       ORDER BY workos_organization_id`
    );

    // Set of every Stripe customer that is some org's linked customer.
    // We use this to avoid reporting another org's linked customer as an
    // "orphan" of *this* org — that situation is a metadata conflict, not
    // a duplicate, and is already surfaced by findStripeCustomerConflicts.
    const allLinkedCustomerIds = new Set(
      linkedOrgsResult.rows.map((r) => r.stripe_customer_id),
    );

    const mismatches: Mismatch[] = [];
    const seenPairs = new Set<string>();

    const recordPair = (
      org: { workos_organization_id: string; name: string; stripe_customer_id: string },
      orphan: StripeCustomerSummary,
      reason: 'metadata' | 'email' | 'name',
    ) => {
      const key = `${org.workos_organization_id}:${orphan.id}`;
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      mismatches.push({
        org_id: org.workos_organization_id,
        org_name: org.name,
        db_customer_id: org.stripe_customer_id,
        stripe_metadata_customer_id: orphan.id,
        match_reason: reason,
      });
    };

    for (const org of linkedOrgsResult.rows) {
      const linkedCustomer = customerById.get(org.stripe_customer_id);

      // Pass 1: metadata — orphan customer's metadata points at this org.
      // This pass runs even when the linked customer is missing from Stripe
      // (e.g., deleted) — the legacy detector worked that way too.
      // Skip candidates that are another org's linked customer; that's a
      // metadata conflict (handled by findStripeCustomerConflicts), not a
      // duplicate, and reporting it here would double-flag the row.
      for (const candidate of allCustomers) {
        if (
          candidate.metadataWorkosOrgId === org.workos_organization_id &&
          candidate.id !== org.stripe_customer_id &&
          !allLinkedCustomerIds.has(candidate.id)
        ) {
          recordPair(org, candidate, 'metadata');
        }
      }

      // Email/name passes need the linked customer's profile — without it
      // we can't look for shared email/name. Skip cleanly.
      if (!linkedCustomer || linkedCustomer.deleted) continue;

      const linkedEmail = linkedCustomer.email?.toLowerCase().trim() ?? null;
      const linkedName = linkedCustomer.name?.toLowerCase().trim() ?? null;

      for (const candidate of allCustomers) {
        if (candidate.id === linkedCustomer.id || candidate.deleted) continue;
        // Same exclusion as the metadata pass: another org's linked customer
        // is not an orphan of this org.
        if (allLinkedCustomerIds.has(candidate.id)) continue;

        // Pass 2: email match (case-insensitive, trimmed).
        if (
          linkedEmail &&
          candidate.email &&
          candidate.email.toLowerCase().trim() === linkedEmail
        ) {
          recordPair(org, candidate, 'email');
          continue;
        }

        // Pass 3: name match + candidate has a live subscription. We require
        // the active-sub signal here because shared names are far more common
        // than shared emails (e.g., two unrelated personal orgs both named
        // "Test"), so we'd false-positive without it.
        if (
          linkedName &&
          candidate.name &&
          candidate.name.toLowerCase().trim() === linkedName &&
          liveSubCustomerIds.has(candidate.id)
        ) {
          recordPair(org, candidate, 'name');
        }
      }
    }

    return mismatches;
  }

  /**
   * Get subscription info for an organization
   * Checks both Stripe and local DB fields, preferring active status from either source.
   * Local DB is authoritative for invoice-based payments (no Stripe subscription).
   */
  async getSubscriptionInfo(workos_organization_id: string): Promise<SubscriptionInfo | null> {
    const org = await this.getOrganization(workos_organization_id);

    if (!org) {
      return { status: 'none' };
    }

    // Build local DB info first (source of truth for invoice-based payments)
    const localInfo: SubscriptionInfo | null = org.subscription_status
      ? {
          status: org.subscription_status as SubscriptionInfo['status'],
          product_name: org.subscription_product_name || undefined,
          product_id: org.subscription_product_id || undefined,
          amount_cents: org.subscription_amount ?? undefined,
          current_period_end: org.subscription_current_period_end
            ? Math.floor(org.subscription_current_period_end.getTime() / 1000)
            : undefined,
          cancel_at_period_end: org.subscription_canceled_at !== null,
        }
      : null;

    // If we have a Stripe customer ID, check for active subscription
    if (org.stripe_customer_id) {
      const stripeInfo = await getStripeSubscriptionInfo(org.stripe_customer_id);

      // If Stripe has an active subscription, use that
      if (stripeInfo && stripeInfo.status !== 'none') {
        return stripeInfo;
      }

      // Stripe has no subscription - prefer local DB if it shows active
      // This handles invoice-based payments where there's no Stripe subscription
      if (localInfo && localInfo.status === 'active') {
        return localInfo;
      }

      // Return Stripe's response (which may be 'none')
      if (stripeInfo) {
        return stripeInfo;
      }
    }

    // No Stripe customer - use local DB or return 'none'
    return localInfo || { status: 'none' };
  }

  /**
   * Check if an organization has an active subscription.
   * Simple boolean helper that checks both Stripe and local DB.
   */
  async hasActiveSubscription(workos_organization_id: string): Promise<boolean> {
    const info = await this.getSubscriptionInfo(workos_organization_id);
    return info?.status === 'active' || info?.status === 'trialing';
  }

  // Agreement Methods

  /**
   * Get current agreement by type
   */
  async getCurrentAgreementByType(type: string): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM agreements
       WHERE agreement_type = $1
       ORDER BY effective_date DESC,
         string_to_array(version, '.')::int[] DESC
       LIMIT 1`,
      [type]
    );
    return result.rows[0] || null;
  }

  /**
   * Get specific agreement by type and version
   */
  async getAgreementByTypeAndVersion(type: string, version: string): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM agreements WHERE agreement_type = $1 AND version = $2',
      [type, version]
    );
    return result.rows[0] || null;
  }

  /**
   * Record user agreement acceptance
   */
  async recordUserAgreementAcceptance(data: {
    workos_user_id: string;
    email: string;
    agreement_type: string;
    agreement_version: string;
    ip_address?: string;
    user_agent?: string;
    workos_organization_id?: string;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO user_agreement_acceptances
       (workos_user_id, email, agreement_type, agreement_version, ip_address, user_agent, workos_organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workos_user_id, agreement_type, agreement_version) DO NOTHING`,
      [
        data.workos_user_id,
        data.email,
        data.agreement_type,
        data.agreement_version,
        data.ip_address,
        data.user_agent,
        data.workos_organization_id,
      ]
    );
  }

  /**
   * Get organization by stripe_customer_id
   */
  async getOrganizationByStripeCustomerId(stripeCustomerId: string): Promise<Organization | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM organizations WHERE stripe_customer_id = $1',
      [stripeCustomerId]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if user has accepted specific agreement
   */
  async hasUserAcceptedAgreement(
    workos_user_id: string,
    agreement_type: string
  ): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM user_agreement_acceptances
       WHERE workos_user_id = $1 AND agreement_type = $2
       LIMIT 1`,
      [workos_user_id, agreement_type]
    );
    return result.rows.length > 0;
  }

  /**
   * Check if user has accepted specific version of an agreement
   */
  async hasUserAcceptedAgreementVersion(
    workos_user_id: string,
    agreement_type: string,
    agreement_version: string
  ): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM user_agreement_acceptances
       WHERE workos_user_id = $1 AND agreement_type = $2 AND agreement_version = $3
       LIMIT 1`,
      [workos_user_id, agreement_type, agreement_version]
    );
    return result.rows.length > 0;
  }

  /**
   * Get all agreement acceptances for a user
   */
  async getUserAgreementAcceptances(workos_user_id: string): Promise<Array<{
    agreement_type: string;
    agreement_version: string;
    accepted_at: Date;
    ip_address: string | null;
    user_agent: string | null;
  }>> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT agreement_type, agreement_version, accepted_at, ip_address, user_agent
       FROM user_agreement_acceptances
       WHERE workos_user_id = $1
       ORDER BY accepted_at DESC`,
      [workos_user_id]
    );
    return result.rows;
  }

  /**
   * Sync organizations from WorkOS to local database.
   * This should be called during server startup to ensure all WorkOS orgs exist locally.
   * Only creates missing orgs - does not update existing ones.
   */
  async syncFromWorkOS(workos: WorkOS): Promise<{ synced: number; existing: number }> {
    let synced = 0;
    let existing = 0;

    try {
      // Paginate through all organizations from WorkOS (limit is per-page max)
      let after: string | undefined;
      do {
        const orgs = await workos.organizations.listOrganizations({
          limit: 100,
          after,
        });

        for (const workosOrg of orgs.data) {
          const localOrg = await this.getOrganization(workosOrg.id);

          if (!localOrg) {
            // organizations.name is VARCHAR(255); a few WorkOS orgs have
            // longer names and would crash the whole sync on INSERT.
            const name = workosOrg.name.slice(0, 255);
            await this.createOrganization({
              workos_organization_id: workosOrg.id,
              name,
            });
            synced++;
            logger.info({ orgId: workosOrg.id, name }, 'Synced organization from WorkOS');
          } else {
            existing++;
          }
        }

        after = orgs.listMetadata?.after ?? undefined;
      } while (after);

      if (synced > 0) {
        logger.info({ synced, existing }, 'WorkOS organization sync complete');
      }

      return { synced, existing };
    } catch (error) {
      logger.error({ error }, 'Failed to sync organizations from WorkOS');
      throw error;
    }
  }

  /**
   * Ensure a local organizations row exists for a WorkOS organization.
   * Fetches the org from WorkOS (for its name) and creates the local row if missing.
   * Safe to call on every login — cheap no-op when the row already exists.
   */
  async ensureOrganizationExists(
    workos: WorkOS,
    workos_organization_id: string
  ): Promise<Organization> {
    const existing = await this.getOrganization(workos_organization_id);
    if (existing) return existing;

    const workosOrg = await workos.organizations.getOrganization(workos_organization_id);
    try {
      const name = workosOrg.name.slice(0, 255);
      const created = await this.createOrganization({
        workos_organization_id,
        name,
      });
      logger.info(
        { orgId: workos_organization_id, name },
        'Lazily created local organization row from WorkOS'
      );
      return created;
    } catch (error) {
      // Race: another request may have created it between our check and insert.
      const afterRace = await this.getOrganization(workos_organization_id);
      if (afterRace) return afterRace;
      throw error;
    }
  }

  /**
   * Sync Stripe customer IDs to local organization records.
   * This should be called during server startup after WorkOS sync.
   * Only updates orgs that exist locally but are missing stripe_customer_id.
   */
  async syncStripeCustomers(): Promise<{ synced: number; skipped: number; conflicts: number }> {
    let synced = 0;
    let skipped = 0;
    let conflicts = 0;

    // Get all Stripe customers with WorkOS org IDs in metadata
    const customers = await listCustomersWithOrgIds();

    for (const { stripeCustomerId, workosOrgId } of customers) {
      const localOrg = await this.getOrganization(workosOrgId);

      if (!localOrg) {
        // Org doesn't exist locally - skip (WorkOS sync should have created it)
        skipped++;
        continue;
      }

      if (localOrg.stripe_customer_id === stripeCustomerId) {
        // Already synced
        continue;
      }

      if (localOrg.stripe_customer_id && localOrg.stripe_customer_id !== stripeCustomerId) {
        // Different customer ID - don't overwrite (counts captured in sync summary)
        logger.debug(
          { orgId: workosOrgId, existingCustomerId: localOrg.stripe_customer_id, newCustomerId: stripeCustomerId },
          'Organization has different Stripe customer ID - not overwriting'
        );
        skipped++;
        continue;
      }

      // Try to set the Stripe customer ID (setStripeCustomerId checks for conflicts)
      try {
        await this.setStripeCustomerId(workosOrgId, stripeCustomerId);
        synced++;
        logger.debug({ orgId: workosOrgId, stripeCustomerId }, 'Synced Stripe customer ID to organization');
      } catch (error) {
        if (error instanceof StripeCustomerConflictError) {
          logger.debug(
            { stripeCustomerId, targetOrgId: workosOrgId, existingOrgId: error.existingOrgId, existingOrgName: error.existingOrgName },
            'Stripe customer ID already assigned to different organization - skipping'
          );
          conflicts++;
        } else {
          throw error;
        }
      }
    }

    if (synced > 0 || conflicts > 0) {
      logger.info({ synced, skipped, conflicts }, 'Stripe customer sync complete');
    }

    return { synced, skipped, conflicts };
  }

  // ========================================
  // ENGAGEMENT TRACKING
  // ========================================

  /**
   * Record a user login for engagement tracking
   * Uses org_activities table with activity_type = 'dashboard_login'
   */
  async recordUserLogin(data: {
    workos_user_id: string;
    workos_organization_id: string;
    user_name?: string;
  }): Promise<void> {
    const pool = getPool();
    // Only record if the organization exists locally. The local row is created
    // on first billing/agreement event, so early logins may arrive before it.
    const result = await pool.query(
      `INSERT INTO org_activities (organization_id, activity_type, logged_by_user_id, logged_by_name, activity_date)
       SELECT $1, 'dashboard_login', $2, $3, NOW()
       WHERE EXISTS (SELECT 1 FROM organizations WHERE workos_organization_id = $1)`,
      [data.workos_organization_id, data.workos_user_id, data.user_name || null]
    );
    if (result.rowCount === 0) {
      logger.debug(
        { workos_organization_id: data.workos_organization_id, workos_user_id: data.workos_user_id },
        'Skipped login activity record: organization not present in local DB yet'
      );
    }
  }

  /**
   * Get login count for an organization in the last N days
   */
  async getOrgLoginCount(workos_organization_id: string, days: number = 30): Promise<number> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM org_activities
       WHERE organization_id = $1
       AND activity_type = 'dashboard_login'
       AND activity_date > NOW() - INTERVAL '1 day' * $2`,
      [workos_organization_id, days]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get the most recent login for an organization
   */
  async getOrgLastLogin(workos_organization_id: string): Promise<Date | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT MAX(activity_date) as last_login FROM org_activities
       WHERE organization_id = $1
       AND activity_type = 'dashboard_login'`,
      [workos_organization_id]
    );
    return result.rows[0]?.last_login || null;
  }

  /**
   * Set the interest level for an organization (human-set)
   */
  async setInterestLevel(
    workos_organization_id: string,
    data: {
      interest_level: 'low' | 'medium' | 'high' | 'very_high' | null;
      note?: string;
      set_by?: string;
    }
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE organizations
       SET interest_level = $2,
           interest_level_note = $3,
           interest_level_set_by = $4,
           interest_level_set_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE workos_organization_id = $1`,
      [workos_organization_id, data.interest_level, data.note || null, data.set_by || null]
    );

    // Track in org_knowledge for provenance
    if (data.interest_level) {
      orgKnowledgeDb.setKnowledge({
        workos_organization_id,
        attribute: 'interest_level',
        value: data.interest_level,
        source: 'admin_set',
        confidence: 'high',
        set_by_description: data.set_by ? `Set by ${data.set_by}` : 'Admin set',
        source_reference: data.note || undefined,
      }).catch(() => {
        // Non-critical, don't fail the main operation
      });
    }
  }

  // ========================================
  // DISCOUNT MANAGEMENT
  // ========================================

  /**
   * Set or update discount for an organization
   * Use discount_percent OR discount_amount_cents, not both
   */
  async setDiscount(
    workos_organization_id: string,
    data: {
      discount_percent?: number | null;
      discount_amount_cents?: number | null;
      reason: string;
      granted_by: string;
      stripe_coupon_id?: string | null;
      stripe_promotion_code?: string | null;
    }
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE organizations
       SET discount_percent = $2,
           discount_amount_cents = $3,
           discount_reason = $4,
           discount_granted_by = $5,
           discount_granted_at = NOW(),
           stripe_coupon_id = $6,
           stripe_promotion_code = $7,
           updated_at = NOW()
       WHERE workos_organization_id = $1`,
      [
        workos_organization_id,
        data.discount_percent ?? null,
        data.discount_amount_cents ?? null,
        data.reason,
        data.granted_by,
        data.stripe_coupon_id ?? null,
        data.stripe_promotion_code ?? null,
      ]
    );
  }

  /**
   * Remove discount from an organization
   */
  async removeDiscount(workos_organization_id: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE organizations
       SET discount_percent = NULL,
           discount_amount_cents = NULL,
           discount_reason = NULL,
           discount_granted_by = NULL,
           discount_granted_at = NULL,
           stripe_coupon_id = NULL,
           stripe_promotion_code = NULL,
           updated_at = NOW()
       WHERE workos_organization_id = $1`,
      [workos_organization_id]
    );
  }

  /**
   * List all organizations with active discounts
   */
  async listOrganizationsWithDiscounts(): Promise<Array<{
    workos_organization_id: string;
    name: string;
    discount_percent: number | null;
    discount_amount_cents: number | null;
    discount_reason: string | null;
    discount_granted_by: string | null;
    discount_granted_at: Date | null;
    stripe_coupon_id: string | null;
    stripe_promotion_code: string | null;
  }>> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT workos_organization_id, name, discount_percent, discount_amount_cents,
              discount_reason, discount_granted_by, discount_granted_at,
              stripe_coupon_id, stripe_promotion_code
       FROM organizations
       WHERE discount_percent IS NOT NULL OR discount_amount_cents IS NOT NULL
       ORDER BY discount_granted_at DESC`
    );
    return result.rows;
  }

  /**
   * Get engagement signals for an organization
   * Returns all computed signals for display in admin UI
   */
  async getEngagementSignals(workos_organization_id: string): Promise<{
    has_member_profile: boolean;
    login_count_30d: number;
    last_login: Date | null;
    working_group_count: number;
    email_click_count_30d: number;
    interest_level: string | null;
    interest_level_note: string | null;
    interest_level_set_by: string | null;
    interest_level_set_at: Date | null;
  }> {
    const pool = getPool();

    // Run all queries in parallel for efficiency
    const [
      profileResult,
      loginCountResult,
      lastLoginResult,
      wgResult,
      emailClickResult,
      orgResult
    ] = await Promise.all([
      // Check if member profile exists
      pool.query(
        `SELECT 1 FROM member_profiles WHERE workos_organization_id = $1`,
        [workos_organization_id]
      ),
      // Login count (last 30 days) - uses org_activities with dashboard_login type
      pool.query(
        `SELECT COUNT(*) as count FROM org_activities
         WHERE organization_id = $1
         AND activity_type = 'dashboard_login'
         AND activity_date > NOW() - INTERVAL '30 days'`,
        [workos_organization_id]
      ),
      // Last login - uses org_activities with dashboard_login type
      pool.query(
        `SELECT MAX(activity_date) as last_login FROM org_activities
         WHERE organization_id = $1
         AND activity_type = 'dashboard_login'`,
        [workos_organization_id]
      ),
      // Working group membership count
      pool.query(
        `SELECT COUNT(DISTINCT wgm.working_group_id) as count
         FROM working_group_memberships wgm
         WHERE wgm.workos_organization_id = $1
         AND wgm.status = 'active'`,
        [workos_organization_id]
      ),
      // Email click count (last 30 days)
      pool.query(
        `SELECT COUNT(*) as count FROM email_clicks ec
         JOIN email_events ee ON ee.id = ec.email_event_id
         WHERE ee.workos_organization_id = $1
         AND ec.clicked_at > NOW() - INTERVAL '30 days'`,
        [workos_organization_id]
      ),
      // Organization interest level fields
      pool.query(
        `SELECT interest_level, interest_level_note, interest_level_set_by, interest_level_set_at
         FROM organizations WHERE workos_organization_id = $1`,
        [workos_organization_id]
      )
    ]);

    const org = orgResult.rows[0] || {};

    return {
      has_member_profile: profileResult.rows.length > 0,
      login_count_30d: parseInt(loginCountResult.rows[0]?.count || '0', 10),
      last_login: lastLoginResult.rows[0]?.last_login || null,
      working_group_count: parseInt(wgResult.rows[0]?.count || '0', 10),
      email_click_count_30d: parseInt(emailClickResult.rows[0]?.count || '0', 10),
      interest_level: org.interest_level || null,
      interest_level_note: org.interest_level_note || null,
      interest_level_set_by: org.interest_level_set_by || null,
      interest_level_set_at: org.interest_level_set_at || null,
    };
  }
}
