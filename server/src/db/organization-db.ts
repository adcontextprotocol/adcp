import { getPool } from './client.js';
import { getSubscriptionInfo } from '../billing/stripe-client.js';

export interface Organization {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string | null;
  agreement_signed_at: Date | null;
  agreement_version: string | null;
  pending_agreement_version: string | null;
  pending_agreement_accepted_at: Date | null;
  subscription_current_period_end: Date | null;
  subscription_product_id: string | null;
  subscription_product_name: string | null;
  subscription_price_id: string | null;
  subscription_amount: number | null;
  subscription_currency: string | null;
  subscription_interval: string | null;
  subscription_canceled_at: Date | null;
  subscription_metadata: any | null;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionInfo {
  status: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'none';
  product_id?: string;
  product_name?: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
}

export interface Agreement {
  id: string;
  version: string;
  text: string;
  effective_date: Date;
  created_at: Date;
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
  }): Promise<Organization> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO organizations (workos_organization_id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [data.workos_organization_id, data.name]
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
   */
  async updateOrganization(
    workos_organization_id: string,
    updates: Partial<Omit<Organization, 'workos_organization_id' | 'created_at' | 'updated_at'>>
  ): Promise<Organization> {
    // Whitelist of allowed column names to prevent SQL injection
    const ALLOWED_COLUMNS = new Set([
      'name',
      'stripe_customer_id',
      'agreement_signed_at',
      'agreement_version',
      'pending_agreement_version',
      'pending_agreement_accepted_at',
      'subscription_current_period_end',
      'subscription_product_id',
      'subscription_product_name',
      'subscription_price_id',
      'subscription_amount',
      'subscription_currency',
      'subscription_interval',
      'subscription_canceled_at',
      'subscription_metadata',
    ]);

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      if (!ALLOWED_COLUMNS.has(key)) {
        throw new Error(`Invalid column name: ${key}`);
      }
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

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
      'SELECT * FROM agreements ORDER BY effective_date DESC LIMIT 1'
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
   * Get audit log for an organization
   */
  async getAuditLog(workos_organization_id: string, limit: number = 100): Promise<any[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM registry_audit_log
       WHERE workos_organization_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [workos_organization_id, limit]
    );
    return result.rows;
  }

  // Billing Methods

  /**
   * Set Stripe customer ID for an organization
   */
  async setStripeCustomerId(
    workos_organization_id: string,
    stripe_customer_id: string
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      'UPDATE organizations SET stripe_customer_id = $1, updated_at = NOW() WHERE workos_organization_id = $2',
      [stripe_customer_id, workos_organization_id]
    );
  }

  /**
   * Get subscription info from Stripe for an organization
   * Returns null if organization has no Stripe customer or Stripe is not configured
   */
  async getSubscriptionInfo(workos_organization_id: string): Promise<SubscriptionInfo | null> {
    const org = await this.getOrganization(workos_organization_id);

    if (!org || !org.stripe_customer_id) {
      return { status: 'none' };
    }

    return getSubscriptionInfo(org.stripe_customer_id);
  }

  // Agreement Methods

  /**
   * Get current agreement by type
   */
  async getCurrentAgreementByType(type: string): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM agreements WHERE agreement_type = $1 ORDER BY effective_date DESC LIMIT 1',
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
}
