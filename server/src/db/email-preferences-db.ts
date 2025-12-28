import { query } from './client.js';
import crypto from 'crypto';

export interface EmailCategory {
  id: string;
  name: string;
  description: string | null;
  default_enabled: boolean;
  sort_order: number;
  created_at: Date;
}

export interface UserEmailPreferences {
  id: string;
  workos_user_id: string;
  email: string;
  unsubscribe_token: string;
  global_unsubscribe: boolean;
  global_unsubscribe_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserCategoryPreference {
  id: string;
  user_preference_id: string;
  category_id: string;
  enabled: boolean;
  updated_at: Date;
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string | null;
  subject_template: string;
  html_template: string;
  text_template: string;
  category_id: string | null;
  available_variables: Record<string, string> | null;
  version: number;
  last_edited_by: string | null;
  last_edited_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmailCampaign {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  html_content: string;
  text_content: string;
  category_id: string;
  target_audience: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
  scheduled_for: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  open_count: number;
  click_count: number;
  unsubscribe_count: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Generate a secure unsubscribe token
 */
function generateUnsubscribeToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Database operations for email preferences
 */
export class EmailPreferencesDatabase {
  // ==================== Categories ====================

  /**
   * Get all email categories
   */
  async getCategories(): Promise<EmailCategory[]> {
    const result = await query<EmailCategory>(
      'SELECT * FROM email_categories ORDER BY sort_order ASC'
    );
    return result.rows;
  }

  /**
   * Get a single category by ID
   */
  async getCategoryById(categoryId: string): Promise<EmailCategory | null> {
    const result = await query<EmailCategory>(
      'SELECT * FROM email_categories WHERE id = $1',
      [categoryId]
    );
    return result.rows[0] || null;
  }

  // ==================== User Preferences ====================

  /**
   * Get or create user email preferences
   * Creates a new record with defaults if none exists
   */
  async getOrCreateUserPreferences(data: {
    workos_user_id: string;
    email: string;
  }): Promise<UserEmailPreferences> {
    // Try to get existing
    const existing = await query<UserEmailPreferences>(
      'SELECT * FROM user_email_preferences WHERE workos_user_id = $1',
      [data.workos_user_id]
    );

    if (existing.rows[0]) {
      // Update email if changed
      if (existing.rows[0].email !== data.email) {
        await query(
          'UPDATE user_email_preferences SET email = $2, updated_at = NOW() WHERE workos_user_id = $1',
          [data.workos_user_id, data.email]
        );
        existing.rows[0].email = data.email;
      }
      return existing.rows[0];
    }

    // Create new with default preferences
    const token = generateUnsubscribeToken();
    const result = await query<UserEmailPreferences>(
      `INSERT INTO user_email_preferences (workos_user_id, email, unsubscribe_token)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.workos_user_id, data.email, token]
    );

    return result.rows[0];
  }

  /**
   * Get user preferences by unsubscribe token (no auth required)
   */
  async getUserPreferencesByToken(token: string): Promise<UserEmailPreferences | null> {
    const result = await query<UserEmailPreferences>(
      'SELECT * FROM user_email_preferences WHERE unsubscribe_token = $1',
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * Get user preferences by user ID
   */
  async getUserPreferencesByUserId(workosUserId: string): Promise<UserEmailPreferences | null> {
    const result = await query<UserEmailPreferences>(
      'SELECT * FROM user_email_preferences WHERE workos_user_id = $1',
      [workosUserId]
    );
    return result.rows[0] || null;
  }

  /**
   * Global unsubscribe (one-click unsubscribe from all non-transactional emails)
   */
  async globalUnsubscribe(token: string): Promise<boolean> {
    const result = await query(
      `UPDATE user_email_preferences
       SET global_unsubscribe = true, global_unsubscribe_at = NOW(), updated_at = NOW()
       WHERE unsubscribe_token = $1
       RETURNING id`,
      [token]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Re-subscribe (undo global unsubscribe)
   */
  async resubscribe(workosUserId: string): Promise<boolean> {
    const result = await query(
      `UPDATE user_email_preferences
       SET global_unsubscribe = false, global_unsubscribe_at = NULL, updated_at = NOW()
       WHERE workos_user_id = $1
       RETURNING id`,
      [workosUserId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ==================== Category Preferences ====================

  /**
   * Get user's category preferences with defaults applied
   */
  async getUserCategoryPreferences(workosUserId: string): Promise<
    Array<{
      category_id: string;
      category_name: string;
      category_description: string | null;
      enabled: boolean;
      is_override: boolean;
    }>
  > {
    // Get user preference record
    const userPrefs = await this.getUserPreferencesByUserId(workosUserId);

    // Get all categories with any overrides
    const result = await query<{
      category_id: string;
      category_name: string;
      category_description: string | null;
      default_enabled: boolean;
      override_enabled: boolean | null;
    }>(
      `SELECT
        c.id as category_id,
        c.name as category_name,
        c.description as category_description,
        c.default_enabled,
        ucp.enabled as override_enabled
       FROM email_categories c
       LEFT JOIN user_email_category_preferences ucp
         ON ucp.category_id = c.id
         AND ucp.user_preference_id = $1
       ORDER BY c.sort_order ASC`,
      [userPrefs?.id || null]
    );

    return result.rows.map((row) => ({
      category_id: row.category_id,
      category_name: row.category_name,
      category_description: row.category_description,
      enabled: row.override_enabled !== null ? row.override_enabled : row.default_enabled,
      is_override: row.override_enabled !== null,
    }));
  }

  /**
   * Set preference for a specific category
   */
  async setCategoryPreference(data: {
    workos_user_id: string;
    email: string;
    category_id: string;
    enabled: boolean;
  }): Promise<void> {
    // Ensure user preferences exist
    const userPrefs = await this.getOrCreateUserPreferences({
      workos_user_id: data.workos_user_id,
      email: data.email,
    });

    // Upsert category preference
    await query(
      `INSERT INTO user_email_category_preferences (user_preference_id, category_id, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_preference_id, category_id)
       DO UPDATE SET enabled = $3, updated_at = NOW()`,
      [userPrefs.id, data.category_id, data.enabled]
    );
  }

  /**
   * Check if a user wants to receive a specific category of email
   */
  async shouldSendEmail(data: {
    workos_user_id: string;
    category_id: string;
  }): Promise<boolean> {
    const userPrefs = await this.getUserPreferencesByUserId(data.workos_user_id);

    // If no preferences exist, use category default
    if (!userPrefs) {
      const category = await this.getCategoryById(data.category_id);
      return category?.default_enabled ?? true;
    }

    // Check global unsubscribe first
    if (userPrefs.global_unsubscribe) {
      return false;
    }

    // Check category-specific preference
    const result = await query<{ enabled: boolean; default_enabled: boolean }>(
      `SELECT
        ucp.enabled,
        c.default_enabled
       FROM email_categories c
       LEFT JOIN user_email_category_preferences ucp
         ON ucp.category_id = c.id
         AND ucp.user_preference_id = $1
       WHERE c.id = $2`,
      [userPrefs.id, data.category_id]
    );

    if (result.rows[0]) {
      const row = result.rows[0];
      return row.enabled !== null ? row.enabled : row.default_enabled;
    }

    return true; // Default to sending if category doesn't exist
  }

  // ==================== Templates ====================

  /**
   * Get all email templates
   */
  async getTemplates(): Promise<EmailTemplate[]> {
    const result = await query<EmailTemplate>(
      'SELECT * FROM email_templates ORDER BY name ASC'
    );
    return result.rows;
  }

  /**
   * Get a template by ID
   */
  async getTemplateById(templateId: string): Promise<EmailTemplate | null> {
    const result = await query<EmailTemplate>(
      'SELECT * FROM email_templates WHERE id = $1',
      [templateId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update a template
   */
  async updateTemplate(
    templateId: string,
    data: {
      subject_template?: string;
      html_template?: string;
      text_template?: string;
      last_edited_by: string;
    }
  ): Promise<EmailTemplate | null> {
    const result = await query<EmailTemplate>(
      `UPDATE email_templates SET
        subject_template = COALESCE($2, subject_template),
        html_template = COALESCE($3, html_template),
        text_template = COALESCE($4, text_template),
        last_edited_by = $5,
        last_edited_at = NOW(),
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        templateId,
        data.subject_template || null,
        data.html_template || null,
        data.text_template || null,
        data.last_edited_by,
      ]
    );
    return result.rows[0] || null;
  }

  // ==================== Campaigns ====================

  /**
   * Create a new email campaign
   */
  async createCampaign(data: {
    name: string;
    description?: string;
    subject: string;
    html_content: string;
    text_content: string;
    category_id: string;
    target_audience?: string;
    created_by?: string;
  }): Promise<EmailCampaign> {
    const result = await query<EmailCampaign>(
      `INSERT INTO email_campaigns (
        name, description, subject, html_content, text_content,
        category_id, target_audience, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        data.name,
        data.description || null,
        data.subject,
        data.html_content,
        data.text_content,
        data.category_id,
        data.target_audience || 'all_subscribers',
        data.created_by || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all campaigns
   */
  async getCampaigns(filters?: {
    status?: string;
    category_id?: string;
  }): Promise<EmailCampaign[]> {
    let sql = 'SELECT * FROM email_campaigns WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.status) {
      params.push(filters.status);
      sql += ` AND status = $${params.length}`;
    }

    if (filters?.category_id) {
      params.push(filters.category_id);
      sql += ` AND category_id = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    const result = await query<EmailCampaign>(sql, params);
    return result.rows;
  }

  /**
   * Get a campaign by ID
   */
  async getCampaignById(campaignId: string): Promise<EmailCampaign | null> {
    const result = await query<EmailCampaign>(
      'SELECT * FROM email_campaigns WHERE id = $1',
      [campaignId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update campaign
   */
  async updateCampaign(
    campaignId: string,
    data: Partial<{
      name: string;
      description: string;
      subject: string;
      html_content: string;
      text_content: string;
      category_id: string;
      target_audience: string;
      status: string;
      scheduled_for: Date;
    }>
  ): Promise<EmailCampaign | null> {
    // Only allow updates to draft campaigns
    const campaign = await this.getCampaignById(campaignId);
    if (!campaign || campaign.status !== 'draft') {
      return null;
    }

    const setClauses: string[] = [];
    const params: unknown[] = [campaignId];

    if (data.name !== undefined) {
      params.push(data.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (data.description !== undefined) {
      params.push(data.description);
      setClauses.push(`description = $${params.length}`);
    }
    if (data.subject !== undefined) {
      params.push(data.subject);
      setClauses.push(`subject = $${params.length}`);
    }
    if (data.html_content !== undefined) {
      params.push(data.html_content);
      setClauses.push(`html_content = $${params.length}`);
    }
    if (data.text_content !== undefined) {
      params.push(data.text_content);
      setClauses.push(`text_content = $${params.length}`);
    }
    if (data.category_id !== undefined) {
      params.push(data.category_id);
      setClauses.push(`category_id = $${params.length}`);
    }
    if (data.target_audience !== undefined) {
      params.push(data.target_audience);
      setClauses.push(`target_audience = $${params.length}`);
    }
    if (data.status !== undefined) {
      params.push(data.status);
      setClauses.push(`status = $${params.length}`);
    }
    if (data.scheduled_for !== undefined) {
      params.push(data.scheduled_for);
      setClauses.push(`scheduled_for = $${params.length}`);
    }

    if (setClauses.length === 0) {
      return campaign;
    }

    setClauses.push('updated_at = NOW()');

    const result = await query<EmailCampaign>(
      `UPDATE email_campaigns SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  /**
   * Update campaign stats
   */
  async updateCampaignStats(
    campaignId: string,
    stats: Partial<{
      total_recipients: number;
      sent_count: number;
      failed_count: number;
      open_count: number;
      click_count: number;
      unsubscribe_count: number;
    }>
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [campaignId];

    Object.entries(stats).forEach(([key, value]) => {
      if (value !== undefined) {
        params.push(value);
        setClauses.push(`${key} = $${params.length}`);
      }
    });

    if (setClauses.length > 0) {
      setClauses.push('updated_at = NOW()');
      await query(
        `UPDATE email_campaigns SET ${setClauses.join(', ')} WHERE id = $1`,
        params
      );
    }
  }

  /**
   * Get campaign stats summary
   */
  async getCampaignStats(): Promise<{
    total_campaigns: number;
    total_sent: number;
    total_opened: number;
    total_clicked: number;
    avg_open_rate: number;
    avg_click_rate: number;
  }> {
    const result = await query<{
      total_campaigns: string;
      total_sent: string;
      total_opened: string;
      total_clicked: string;
    }>(
      `SELECT
        COUNT(*) as total_campaigns,
        SUM(sent_count) as total_sent,
        SUM(open_count) as total_opened,
        SUM(click_count) as total_clicked
       FROM email_campaigns
       WHERE status = 'sent'`
    );

    const row = result.rows[0];
    const totalSent = parseInt(row?.total_sent || '0', 10);
    const totalOpened = parseInt(row?.total_opened || '0', 10);
    const totalClicked = parseInt(row?.total_clicked || '0', 10);

    return {
      total_campaigns: parseInt(row?.total_campaigns || '0', 10),
      total_sent: totalSent,
      total_opened: totalOpened,
      total_clicked: totalClicked,
      avg_open_rate: totalSent > 0 ? (totalOpened / totalSent) * 100 : 0,
      avg_click_rate: totalSent > 0 ? (totalClicked / totalSent) * 100 : 0,
    };
  }

  // ==================== Unsubscribe from Category via Token ====================

  /**
   * Unsubscribe from a specific category using token (no auth)
   */
  async unsubscribeFromCategory(token: string, categoryId: string): Promise<boolean> {
    const userPrefs = await this.getUserPreferencesByToken(token);
    if (!userPrefs) {
      return false;
    }

    await query(
      `INSERT INTO user_email_category_preferences (user_preference_id, category_id, enabled)
       VALUES ($1, $2, false)
       ON CONFLICT (user_preference_id, category_id)
       DO UPDATE SET enabled = false, updated_at = NOW()`,
      [userPrefs.id, categoryId]
    );

    return true;
  }
}

export const emailPrefsDb = new EmailPreferencesDatabase();
