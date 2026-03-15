/**
 * Email Outreach Service
 *
 * Handles proactive email outreach to prospects who aren't reachable on Slack.
 * Manages send volume, prospect eligibility, unsubscribe tokens, and
 * email delivery via Resend.
 */

import { Resend } from 'resend';
import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { emailDb } from '../../db/email-db.js';

const logger = createLogger('email-outreach');

// ─── Email volume controls ──────────────────────────────────────────────────
// Cold email is a completely different animal from Slack DMs. These limits
// protect sender reputation, deliverability, and brand perception.

/** Max emails per scheduler run. */
export const EMAIL_PER_RUN_LIMIT = 5;

/** Max emails per calendar day across all runs. */
export const EMAIL_DAILY_LIMIT = 5;

/** Max emails per rolling 7-day window. */
export const EMAIL_WEEKLY_LIMIT = 15;

/** Days between touches to the same prospect. Minimum 7 — one touch per week max. */
const DAYS_BETWEEN_TOUCHES = 7;

/** Separate kill switch for email outreach (independent of Slack outreach). */
const EMAIL_OUTREACH_ENABLED = process.env.EMAIL_OUTREACH_ENABLED !== 'false';

/**
 * Check daily and weekly send volume against limits.
 * Returns how many more emails can be sent today.
 */
export async function getEmailBudget(): Promise<{
  canSend: boolean;
  remainingToday: number;
  remainingThisWeek: number;
  sentToday: number;
  sentThisWeek: number;
}> {
  const result = await query<{ sent_today: number; sent_this_week: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN 1 ELSE 0 END), 0) AS sent_today,
       COALESCE(COUNT(*), 0) AS sent_this_week
     FROM email_events
     WHERE email_type = 'prospect_outreach'
       AND created_at >= NOW() - INTERVAL '7 days'`
  );

  const sentToday = Number(result.rows[0]?.sent_today ?? 0);
  const sentThisWeek = Number(result.rows[0]?.sent_this_week ?? 0);
  const remainingToday = Math.max(0, EMAIL_DAILY_LIMIT - sentToday);
  const remainingThisWeek = Math.max(0, EMAIL_WEEKLY_LIMIT - sentThisWeek);
  const effective = Math.min(remainingToday, remainingThisWeek);

  return {
    canSend: effective > 0 && EMAIL_OUTREACH_ENABLED,
    remainingToday,
    remainingThisWeek,
    sentToday,
    sentThisWeek,
  };
}

// ─── Prospect types ─────────────────────────────────────────────────────────

interface EmailProspect {
  workos_organization_id: string;
  name: string;
  email_domain: string | null;
  company_types: string[] | null;
  persona: string | null;
  prospect_status: string;
  prospect_contact_name: string | null;
  prospect_contact_email: string;
  prospect_contact_title: string | null;
  prospect_notes: string | null;
  prospect_source: string | null;
  last_email_outreach_at: Date | null;
  email_outreach_count: number;
}

/**
 * Get eligible email prospects — Addie-owned prospects with contact emails,
 * not recently emailed, not opted out.
 */
export async function getEligibleEmailProspects(limit: number): Promise<EmailProspect[]> {
  const result = await query<EmailProspect>(
    `SELECT
       o.workos_organization_id, o.name, o.email_domain,
       o.company_types, o.persona,
       o.prospect_status, o.prospect_contact_name,
       o.prospect_contact_email, o.prospect_contact_title,
       o.prospect_notes, o.prospect_source,
       o.last_email_outreach_at, o.email_outreach_count
     FROM organizations o
     WHERE o.prospect_owner = 'addie'
       AND o.prospect_contact_email IS NOT NULL
       AND o.prospect_status IN ('prospect', 'contacted')
       AND o.subscription_status IS NULL
       AND (o.last_email_outreach_at IS NULL OR o.last_email_outreach_at < NOW() - make_interval(days => $2))
       AND NOT EXISTS (
         SELECT 1 FROM prospect_email_optouts peo
         WHERE LOWER(peo.email) = LOWER(o.prospect_contact_email)
           AND peo.source != 'token_reserved'
       )
     ORDER BY
       CASE WHEN o.last_email_outreach_at IS NULL THEN 0 ELSE 1 END,
       o.last_email_outreach_at NULLS FIRST
     LIMIT $1`,
    [limit, DAYS_BETWEEN_TOUCHES]
  );
  return result.rows;
}


// ─── Unsubscribe token management ───────────────────────────────────────────

/**
 * Get or create an unsubscribe token for a prospect email
 */
export async function getOrCreateUnsubscribeToken(email: string): Promise<string> {
  // Check if token already exists
  const existing = await query<{ unsubscribe_token: string }>(
    `SELECT unsubscribe_token FROM prospect_email_optouts
     WHERE LOWER(email) = LOWER($1)`,
    [email]
  );

  if (existing.rows[0]) {
    return existing.rows[0].unsubscribe_token;
  }

  // Generate a random token and insert a placeholder row (source='token_reserved')
  // so the unsubscribe link can look it up. opted_out_at is set to a far-future
  // sentinel value to distinguish from actual opt-outs.
  const { randomBytes } = await import('node:crypto');
  const token = randomBytes(16).toString('hex');

  await query(
    `INSERT INTO prospect_email_optouts (email, unsubscribe_token, source, opted_out_at)
     VALUES (LOWER($1), $2, 'token_reserved', '9999-12-31'::timestamptz)
     ON CONFLICT (LOWER(email)) DO UPDATE SET unsubscribe_token = $2`,
    [email, token]
  );

  return token;
}

/**
 * Process an unsubscribe request for a prospect
 */
export async function unsubscribeProspect(token: string): Promise<{ success: boolean; email?: string }> {
  const result = await query<{ email: string }>(
    `UPDATE prospect_email_optouts
     SET source = 'unsubscribe_link', opted_out_at = NOW()
     WHERE unsubscribe_token = $1
     RETURNING email`,
    [token]
  );

  if (result.rows[0]) {
    return { success: true, email: result.rows[0].email };
  }

  return { success: false };
}

/**
 * Record a prospect opt-out by email address
 */
export async function optOutProspectEmail(email: string, token: string): Promise<void> {
  await query(
    `INSERT INTO prospect_email_optouts (email, unsubscribe_token, source)
     VALUES (LOWER($1), $2, 'unsubscribe_link')
     ON CONFLICT (LOWER(email)) DO NOTHING`,
    [email, token]
  );
}

/**
 * Check if a prospect email is opted out
 */
export async function isProspectOptedOut(email: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM prospect_email_optouts
     WHERE LOWER(email) = LOWER($1) AND source != 'token_reserved'`,
    [email]
  );
  return result.rows.length > 0;
}

// ─── Organization tracking updates ─────────────────────────────────────────

/**
 * Update organization after sending an email
 */
export async function recordEmailSent(orgId: string): Promise<void> {
  await query(
    `UPDATE organizations
     SET last_email_outreach_at = NOW(),
         email_outreach_count = email_outreach_count + 1,
         prospect_status = CASE
           WHEN prospect_status = 'prospect' THEN 'contacted'
           ELSE prospect_status
         END,
         updated_at = NOW()
     WHERE workos_organization_id = $1`,
    [orgId]
  );
}

// ─── Email sending via Resend ───────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';
const FROM_EMAIL_ADDIE = 'Addie from AgenticAdvertising.org <addie@updates.agenticadvertising.org>';
const PHYSICAL_ADDRESS = '1309 Coffeen Avenue STE 1200, Sheridan, WY 82801';

/**
 * Send a prospect outreach email via Resend with tracking and CAN-SPAM compliance
 */
export async function sendProspectEmail(params: {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  prospectOrgId: string;
  unsubscribeToken: string;
}): Promise<{ success: boolean; trackingId?: string; error?: string }> {
  if (!resend) {
    logger.warn('Resend not configured, skipping prospect email');
    return { success: false, error: 'Resend not configured' };
  }

  try {
    const unsubscribeUrl = `${BASE_URL}/unsubscribe/prospect/${params.unsubscribeToken}`;

    // Create tracking record
    const emailEvent = await emailDb.createEmailEvent({
      email_type: 'prospect_outreach',
      recipient_email: params.to,
      subject: params.subject,
      workos_organization_id: params.prospectOrgId,
      metadata: { prospect_org_id: params.prospectOrgId },
    });

    const trackingId = emailEvent.tracking_id;

    // CAN-SPAM compliant footer
    const footerHtml = `
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">
    <p style="font-size: 12px; color: #666; text-align: center;">
      AgenticAdvertising.org<br>
      ${PHYSICAL_ADDRESS}<br>
      <a href="${unsubscribeUrl}" style="color: #666; text-decoration: underline;">Unsubscribe from future emails</a>
    </p>`;

    const footerText = `\n---\nAgenticAdvertising.org\n${PHYSICAL_ADDRESS}\nUnsubscribe: ${unsubscribeUrl}`;

    const { data: sendData, error } = await resend.emails.send({
      from: FROM_EMAIL_ADDIE,
      to: params.to,
      subject: params.subject,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${params.bodyHtml}
  ${footerHtml}
</body>
</html>`.trim(),
      text: `${params.bodyText}\n${footerText}`,
    });

    if (error) {
      logger.error({ error, to: params.to, trackingId }, 'Failed to send prospect email');
      return { success: false, trackingId, error: String(error) };
    }

    await emailDb.markEmailSent(trackingId, sendData?.id);

    logger.info({
      to: params.to,
      trackingId,
      prospectOrgId: params.prospectOrgId,
    }, 'Prospect outreach email sent');

    return { success: true, trackingId };
  } catch (error) {
    logger.error({ error, to: params.to }, 'Error sending prospect email');
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
