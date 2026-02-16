import { getPool } from './client.js';
import { getStripeSubscriptionInfo, listCustomersWithOrgIds } from '../billing/stripe-client.js';
import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { CompanyTypeValue } from '../config/company-types.js';
import type { Agreement } from '../types.js';

// Re-export Agreement for backwards compatibility
export type { Agreement };

const logger = createLogger('organization-db');

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
export type MembershipTier = 'individual_professional' | 'individual_academic' | 'company_standard' | 'company_icl';

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
 * - individual_professional: $250/year for industry professionals
 * - individual_academic: $50/year for students, academics, and non-profits
 * - company_standard: $2,500/year (<$5M revenue) or $10,000/year (>=$5M revenue)
 * - company_icl: $50,000/year Industry Council Leader
 */
export const VALID_MEMBERSHIP_TIERS: readonly MembershipTier[] = [
  'individual_professional',
  'individual_academic',
  'company_standard',
  'company_icl',
] as const;

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
  subscription_status: string | null;
  subscription_current_period_end: Date | null;
  subscription_product_id: string | null;
  subscription_product_name: string | null;
  subscription_price_id: string | null;
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
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionInfo {
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'none';
  product_id?: string;
  product_name?: string;
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
      subscription_current_period_end: 'subscription_current_period_end',
      subscription_product_id: 'subscription_product_id',
      subscription_product_name: 'subscription_product_name',
      subscription_price_id: 'subscription_price_id',
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
        mp.logo_url,
        mp.tagline
       FROM organizations o
       LEFT JOIN member_profiles mp ON mp.workos_organization_id = o.workos_organization_id
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
    await pool.query(
      `INSERT INTO registry_audit_log (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.workos_organization_id,
        entry.workos_user_id,
        entry.action,
        entry.resource_type,
        entry.resource_id,
        JSON.stringify(entry.details),
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
   * Uses SELECT FOR UPDATE to prevent concurrent customer creation.
   */
  async getOrCreateStripeCustomer(
    workos_organization_id: string,
    createFn: () => Promise<string | null>
  ): Promise<string | null> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT stripe_customer_id FROM organizations
         WHERE workos_organization_id = $1 FOR UPDATE`,
        [workos_organization_id]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const existingCustomerId = result.rows[0].stripe_customer_id;
      if (existingCustomerId) {
        await client.query('COMMIT');
        return existingCustomerId;
      }

      const newCustomerId = await createFn();

      if (newCustomerId) {
        await client.query(
          `UPDATE organizations SET stripe_customer_id = $1, updated_at = NOW()
           WHERE workos_organization_id = $2`,
          [newCustomerId, workos_organization_id]
        );
      }

      await client.query('COMMIT');
      return newCustomerId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
   * Find Stripe customer mismatches where an org has a different customer ID in the DB
   * than what Stripe metadata says it should have.
   *
   * This detects the case where:
   * - Org has stripe_customer_id = cus_X in the database
   * - But a different Stripe customer (cus_Y) has metadata saying it belongs to that org
   *
   * This often indicates an org has multiple Stripe customers (e.g., someone created
   * a new customer instead of using the existing one).
   */
  async findStripeCustomerMismatches(): Promise<Array<{
    org_id: string;
    org_name: string;
    db_customer_id: string;
    stripe_metadata_customer_id: string;
  }>> {
    const mismatches: Array<{
      org_id: string;
      org_name: string;
      db_customer_id: string;
      stripe_metadata_customer_id: string;
    }> = [];

    // Get all Stripe customers with org metadata
    const stripeCustomers = await listCustomersWithOrgIds();

    for (const { stripeCustomerId, workosOrgId } of stripeCustomers) {
      const localOrg = await this.getOrganization(workosOrgId);

      // Check if org exists and has a DIFFERENT customer ID than Stripe metadata suggests
      if (localOrg && localOrg.stripe_customer_id && localOrg.stripe_customer_id !== stripeCustomerId) {
        // Mismatch: Org has cus_X in DB, but Stripe customer cus_Y claims to belong to this org
        mismatches.push({
          org_id: workosOrgId,
          org_name: localOrg.name,
          db_customer_id: localOrg.stripe_customer_id,
          stripe_metadata_customer_id: stripeCustomerId,
        });
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
      // List all organizations from WorkOS
      const orgs = await workos.organizations.listOrganizations({
        limit: 100, // Paginate if needed in the future
      });

      for (const workosOrg of orgs.data) {
        const localOrg = await this.getOrganization(workosOrg.id);

        if (!localOrg) {
          // Create the org locally
          await this.createOrganization({
            workos_organization_id: workosOrg.id,
            name: workosOrg.name,
          });
          synced++;
          logger.info({ orgId: workosOrg.id, name: workosOrg.name }, 'Synced organization from WorkOS');
        } else {
          existing++;
        }
      }

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
    await pool.query(
      `INSERT INTO org_activities (organization_id, activity_type, logged_by_user_id, logged_by_name, activity_date)
       VALUES ($1, 'dashboard_login', $2, $3, NOW())`,
      [data.workos_organization_id, data.workos_user_id, data.user_name || null]
    );
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
