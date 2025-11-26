import { getPool } from './client.js';
import { getSubscriptionInfo } from '../billing/stripe-client.js';

export interface Organization {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string | null;
  agreement_signed_at: Date | null;
  agreement_version: string | null;
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
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
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
}
