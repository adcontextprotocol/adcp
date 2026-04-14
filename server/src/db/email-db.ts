import { query } from './client.js';
import crypto from 'crypto';

export interface EmailEvent {
  id: string;
  tracking_id: string;
  email_type: string;
  recipient_email: string;
  subject: string | null;
  workos_user_id: string | null;
  workos_organization_id: string | null;
  sent_at: Date | null;
  resend_email_id: string | null;
  opened_at: Date | null;
  open_count: number;
  first_clicked_at: Date | null;
  click_count: number;
  delivered_at: Date | null;
  bounced_at: Date | null;
  bounce_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmailClick {
  id: number;
  email_event_id: string;
  link_name: string | null;
  destination_url: string;
  clicked_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

/**
 * Generate a short tracking ID for URLs
 */
function generateTrackingId(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * Database operations for email tracking
 */
export class EmailDatabase {
  /**
   * Create a new email event record (before sending)
   */
  async createEmailEvent(data: {
    email_type: string;
    recipient_email: string;
    subject?: string;
    workos_user_id?: string;
    workos_organization_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EmailEvent> {
    const trackingId = generateTrackingId();

    const result = await query<EmailEvent>(
      `INSERT INTO email_events (
        tracking_id, email_type, recipient_email, subject,
        workos_user_id, workos_organization_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        trackingId,
        data.email_type,
        data.recipient_email,
        data.subject || null,
        data.workos_user_id || null,
        data.workos_organization_id || null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Mark email as sent with Resend email ID
   */
  async markEmailSent(trackingId: string, resendEmailId?: string): Promise<void> {
    await query(
      `UPDATE email_events
       SET sent_at = NOW(), resend_email_id = $2, updated_at = NOW()
       WHERE tracking_id = $1`,
      [trackingId, resendEmailId || null]
    );
  }

  /**
   * Get email event by tracking ID
   */
  async getByTrackingId(trackingId: string): Promise<EmailEvent | null> {
    const result = await query<EmailEvent>(
      'SELECT * FROM email_events WHERE tracking_id = $1',
      [trackingId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get email event by Resend email ID (for webhook processing)
   */
  async getByResendId(resendEmailId: string): Promise<EmailEvent | null> {
    const result = await query<EmailEvent>(
      'SELECT * FROM email_events WHERE resend_email_id = $1',
      [resendEmailId]
    );
    return result.rows[0] || null;
  }

  /**
   * Check if we've already sent a specific email type to a user
   */
  async hasEmailBeenSent(data: {
    email_type: string;
    workos_user_id: string;
  }): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM email_events
        WHERE email_type = $1
          AND workos_user_id = $2
          AND sent_at IS NOT NULL
      ) as exists`,
      [data.email_type, data.workos_user_id]
    );
    return result.rows[0]?.exists || false;
  }

  /**
   * Record a click event
   */
  async recordClick(data: {
    tracking_id: string;
    link_name?: string;
    destination_url: string;
    ip_address?: string;
    user_agent?: string;
    referrer?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
  }): Promise<{ emailEvent: EmailEvent; click: EmailClick } | null> {
    // Get the email event
    const emailEvent = await this.getByTrackingId(data.tracking_id);
    if (!emailEvent) {
      return null;
    }

    // Record the click
    const clickResult = await query<EmailClick>(
      `INSERT INTO email_clicks (
        email_event_id, link_name, destination_url,
        ip_address, user_agent, referrer,
        utm_source, utm_medium, utm_campaign
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        emailEvent.id,
        data.link_name || null,
        data.destination_url,
        data.ip_address || null,
        data.user_agent || null,
        data.referrer || null,
        data.utm_source || null,
        data.utm_medium || null,
        data.utm_campaign || null,
      ]
    );

    // Update aggregate click count on email event
    await query(
      `UPDATE email_events
       SET click_count = click_count + 1,
           first_clicked_at = COALESCE(first_clicked_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [emailEvent.id]
    );

    // Refresh the email event to get updated counts
    const updatedEvent = await this.getByTrackingId(data.tracking_id);

    return {
      emailEvent: updatedEvent!,
      click: clickResult.rows[0],
    };
  }

  /**
   * Record email open (from Resend webhook)
   */
  async recordOpen(resendEmailId: string): Promise<void> {
    await query(
      `UPDATE email_events
       SET open_count = open_count + 1,
           opened_at = COALESCE(opened_at, NOW()),
           updated_at = NOW()
       WHERE resend_email_id = $1`,
      [resendEmailId]
    );
  }

  /**
   * Record email delivery (from Resend webhook)
   */
  async recordDelivery(resendEmailId: string): Promise<void> {
    await query(
      `UPDATE email_events
       SET delivered_at = NOW(), updated_at = NOW()
       WHERE resend_email_id = $1`,
      [resendEmailId]
    );
  }

  /**
   * Record email bounce (from Resend webhook)
   */
  async recordBounce(resendEmailId: string, reason?: string): Promise<void> {
    await query(
      `UPDATE email_events
       SET bounced_at = NOW(), bounce_reason = $2, updated_at = NOW()
       WHERE resend_email_id = $1`,
      [resendEmailId, reason || null]
    );
  }

  /**
   * Get email stats for a user
   */
  async getUserEmailStats(workosUserId: string): Promise<{
    total_sent: number;
    total_opened: number;
    total_clicked: number;
  }> {
    const result = await query<{
      total_sent: string;
      total_opened: string;
      total_clicked: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL) as total_sent,
        COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as total_opened,
        COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL) as total_clicked
       FROM email_events
       WHERE workos_user_id = $1`,
      [workosUserId]
    );

    return {
      total_sent: parseInt(result.rows[0]?.total_sent || '0', 10),
      total_opened: parseInt(result.rows[0]?.total_opened || '0', 10),
      total_clicked: parseInt(result.rows[0]?.total_clicked || '0', 10),
    };
  }

  /**
   * Get recent emails for an organization (for admin view)
   */
  async getOrgEmails(
    workosOrganizationId: string,
    limit = 50
  ): Promise<EmailEvent[]> {
    const result = await query<EmailEvent>(
      `SELECT * FROM email_events
       WHERE workos_organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workosOrganizationId, limit]
    );
    return result.rows;
  }
}

export const emailDb = new EmailDatabase();
