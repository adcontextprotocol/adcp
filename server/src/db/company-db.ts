import { getPool } from './client.js';
import type {
  Company,
  CompanyUser,
  Agreement,
  SubscriptionStatus,
  SubscriptionTier,
  CompanyUserRole,
} from '../types.js';

export class CompanyDatabase {
  // Companies

  async createCompany(data: {
    slug: string;
    name: string;
    domain?: string;
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
    subscription_status?: SubscriptionStatus;
    subscription_tier?: SubscriptionTier;
  }): Promise<Company> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO companies (slug, name, domain, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.slug,
        data.name,
        data.domain,
        data.stripe_customer_id,
        data.stripe_subscription_id,
        data.subscription_status,
        data.subscription_tier,
      ]
    );
    return this.mapCompany(result.rows[0]);
  }

  async getCompany(id: string): Promise<Company | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
    return result.rows.length > 0 ? this.mapCompany(result.rows[0]) : null;
  }

  async getCompanyBySlug(slug: string): Promise<Company | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM companies WHERE slug = $1', [slug]);
    return result.rows.length > 0 ? this.mapCompany(result.rows[0]) : null;
  }

  async getCompanyByStripeCustomer(customerId: string): Promise<Company | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM companies WHERE stripe_customer_id = $1', [
      customerId,
    ]);
    return result.rows.length > 0 ? this.mapCompany(result.rows[0]) : null;
  }

  async getCompanyByDomain(domain: string): Promise<Company | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM companies WHERE domain = $1', [domain]);
    return result.rows.length > 0 ? this.mapCompany(result.rows[0]) : null;
  }

  async updateCompany(
    id: string,
    data: Partial<{
      name: string;
      domain: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
      subscription_status: SubscriptionStatus;
      subscription_tier: SubscriptionTier;
      agreement_signed_at: Date;
      agreement_version: string;
    }>
  ): Promise<Company | null> {
    const pool = getPool();
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(data).forEach(([key, value]) => {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    if (fields.length === 0) {
      return this.getCompany(id);
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE companies SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows.length > 0 ? this.mapCompany(result.rows[0]) : null;
  }

  async updateCompanyByStripeCustomer(
    customerId: string,
    data: Partial<{
      subscription_status: SubscriptionStatus;
      subscription_tier: SubscriptionTier;
      stripe_subscription_id: string;
    }>
  ): Promise<Company | null> {
    const pool = getPool();
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(data).forEach(([key, value]) => {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    if (fields.length === 0) {
      return this.getCompanyByStripeCustomer(customerId);
    }

    values.push(customerId);
    const result = await pool.query(
      `UPDATE companies SET ${fields.join(', ')} WHERE stripe_customer_id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows.length > 0 ? this.mapCompany(result.rows[0]) : null;
  }

  async listCompanies(): Promise<Company[]> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
    return result.rows.map(this.mapCompany);
  }

  // Company Users

  async createCompanyUser(data: {
    company_id: string;
    user_id: string;
    email: string;
    role: CompanyUserRole;
    invited_by?: string;
  }): Promise<CompanyUser> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO company_users (company_id, user_id, email, role, invited_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.company_id, data.user_id, data.email, data.role, data.invited_by]
    );
    return this.mapCompanyUser(result.rows[0]);
  }

  async getCompanyUser(companyId: string, userId: string): Promise<CompanyUser | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM company_users WHERE company_id = $1 AND user_id = $2',
      [companyId, userId]
    );
    return result.rows.length > 0 ? this.mapCompanyUser(result.rows[0]) : null;
  }

  async getCompanyUserByEmail(companyId: string, email: string): Promise<CompanyUser | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM company_users WHERE company_id = $1 AND email = $2',
      [companyId, email]
    );
    return result.rows.length > 0 ? this.mapCompanyUser(result.rows[0]) : null;
  }

  async getUserCompanies(userId: string): Promise<Company[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT c.* FROM companies c
       INNER JOIN company_users cu ON c.id = cu.company_id
       WHERE cu.user_id = $1
       ORDER BY cu.joined_at DESC`,
      [userId]
    );
    return result.rows.map(this.mapCompany);
  }

  async getCompanyUsers(companyId: string): Promise<CompanyUser[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM company_users WHERE company_id = $1 ORDER BY joined_at ASC',
      [companyId]
    );
    return result.rows.map(this.mapCompanyUser);
  }

  async updateCompanyUserRole(
    companyId: string,
    userId: string,
    role: CompanyUserRole
  ): Promise<CompanyUser | null> {
    const pool = getPool();
    const result = await pool.query(
      'UPDATE company_users SET role = $1 WHERE company_id = $2 AND user_id = $3 RETURNING *',
      [role, companyId, userId]
    );
    return result.rows.length > 0 ? this.mapCompanyUser(result.rows[0]) : null;
  }

  async removeCompanyUser(companyId: string, userId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2',
      [companyId, userId]
    );
    return (result.rowCount || 0) > 0;
  }

  // Domain-based auto-join
  async findCompanyByEmailDomain(email: string): Promise<Company | null> {
    const domain = email.split('@')[1];
    if (!domain) return null;
    return this.getCompanyByDomain(domain);
  }

  // Agreements

  async getCurrentAgreement(): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM agreements ORDER BY effective_date DESC LIMIT 1'
    );
    return result.rows.length > 0 ? this.mapAgreement(result.rows[0]) : null;
  }

  async getAgreementByVersion(version: string): Promise<Agreement | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM agreements WHERE version = $1', [version]);
    return result.rows.length > 0 ? this.mapAgreement(result.rows[0]) : null;
  }

  async createAgreement(data: {
    version: string;
    text: string;
    effective_date: Date;
  }): Promise<Agreement> {
    const pool = getPool();
    const result = await pool.query(
      'INSERT INTO agreements (version, text, effective_date) VALUES ($1, $2, $3) RETURNING *',
      [data.version, data.text, data.effective_date]
    );
    return this.mapAgreement(result.rows[0]);
  }

  // Audit Log

  async recordAuditLog(data: {
    entry_id?: string;
    company_id?: string;
    user_id?: string;
    action: string;
    changes?: any;
    metadata?: any;
    notes?: string;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO registry_audit_log (entry_id, company_id, user_id, action, changes, metadata, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        data.entry_id,
        data.company_id,
        data.user_id,
        data.action,
        data.changes ? JSON.stringify(data.changes) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.notes,
      ]
    );
  }

  // Helper mappers

  private mapCompany(row: any): Company {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      domain: row.domain,
      stripe_customer_id: row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
      subscription_status: row.subscription_status,
      subscription_tier: row.subscription_tier,
      agreement_signed_at: row.agreement_signed_at,
      agreement_version: row.agreement_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapCompanyUser(row: any): CompanyUser {
    return {
      id: row.id,
      company_id: row.company_id,
      user_id: row.user_id,
      email: row.email,
      role: row.role,
      invited_by: row.invited_by,
      joined_at: row.joined_at,
    };
  }

  private mapAgreement(row: any): Agreement {
    return {
      id: row.id,
      version: row.version,
      text: row.text,
      effective_date: row.effective_date,
      created_at: row.created_at,
    };
  }
}
