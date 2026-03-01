/**
 * Email notification service for AgenticAdvertising.org member events
 * With click tracking, event-based send recording, and preference management
 */

import { Resend } from 'resend';
import { createLogger } from '../logger.js';
import { emailDb } from '../db/email-db.js';
import { emailPrefsDb } from '../db/email-preferences-db.js';

const logger = createLogger('email');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!RESEND_API_KEY) {
  logger.warn('RESEND_API_KEY not set - email notifications will be disabled');
}

const FROM_EMAIL = 'AgenticAdvertising.org <hello@updates.agenticadvertising.org>';
const FROM_EMAIL_ADDIE = 'Addie from AgenticAdvertising.org <addie@updates.agenticadvertising.org>';
const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

/**
 * Create a tracked URL that redirects through our click tracker
 */
function trackedUrl(trackingId: string, linkName: string, destinationUrl: string): string {
  const params = new URLSearchParams({
    to: destinationUrl,
    ln: linkName,
  });
  return `${BASE_URL}/r/${trackingId}?${params.toString()}`;
}

/**
 * Generate standard email footer HTML with optional unsubscribe links
 * @param trackingId - The tracking ID for URL tracking
 * @param unsubscribeToken - Token for one-click unsubscribe (null for transactional emails)
 * @param category - Optional category name for specific unsubscribe text
 */
function generateFooterHtml(
  trackingId: string,
  unsubscribeToken: string | null,
  category?: string
): string {
  const websiteUrl = trackedUrl(trackingId, 'footer_website', 'https://agenticadvertising.org');

  let unsubscribeSection = '';
  if (unsubscribeToken) {
    const unsubscribeUrl = trackedUrl(trackingId, 'footer_unsubscribe', `${BASE_URL}/unsubscribe/${unsubscribeToken}`);
    const preferencesUrl = trackedUrl(trackingId, 'footer_preferences', `${BASE_URL}/unsubscribe/${unsubscribeToken}`);

    unsubscribeSection = `
    <p style="font-size: 12px; color: #666; text-align: center; margin-top: 10px;">
      <a href="${unsubscribeUrl}" style="color: #666; text-decoration: underline;">Unsubscribe</a>
      ${category ? ` from ${category}` : ''} |
      <a href="${preferencesUrl}" style="color: #666; text-decoration: underline;">Manage email preferences</a>
    </p>`;
  }

  return `
  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

  <p style="font-size: 12px; color: #666; text-align: center;">
    AgenticAdvertising.org<br>
    <a href="${websiteUrl}" style="color: #2563eb;">agenticadvertising.org</a>
  </p>
  ${unsubscribeSection}`;
}

/**
 * Generate standard email footer text with optional unsubscribe links
 */
function generateFooterText(unsubscribeToken: string | null, category?: string): string {
  let footer = `---
AgenticAdvertising.org
https://agenticadvertising.org`;

  if (unsubscribeToken) {
    footer += `

Unsubscribe${category ? ` from ${category}` : ''}: ${BASE_URL}/unsubscribe/${unsubscribeToken}
Manage email preferences: ${BASE_URL}/unsubscribe/${unsubscribeToken}`;
  }

  return footer;
}

/**
 * Get or create an unsubscribe token for a user
 */
async function getUnsubscribeToken(workosUserId: string, email: string): Promise<string> {
  const prefs = await emailPrefsDb.getOrCreateUserPreferences({
    workos_user_id: workosUserId,
    email,
  });
  return prefs.unsubscribe_token;
}

/**
 * Email types for tracking
 */
export type EmailType =
  | 'welcome_member'
  | 'signup_user'
  | 'signup_user_member'
  | 'signup_user_nonmember'
  | 'slack_invite';

/**
 * Send welcome email to new members after subscription is created
 * Now with tracking!
 */
export async function sendWelcomeEmail(data: {
  to: string;
  organizationName: string;
  productName?: string;
  workosUserId?: string;
  workosOrganizationId?: string;
  isPersonal?: boolean;
  firstName?: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping welcome email');
    return false;
  }

  const emailType: EmailType = 'welcome_member';
  const subject = 'Welcome to AgenticAdvertising.org!';

  // Escape HTML entities to prevent XSS
  const escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Personalize greeting based on account type (guard against empty strings and XSS)
  const safeName = data.firstName?.trim() ? escapeHtml(data.firstName.trim()) : null;
  const greeting = safeName ? `Hi ${safeName},` : 'Hi there,';

  // For individual accounts, use personal language instead of organization name
  const welcomeMessage = data.isPersonal
    ? "We're excited to have you join us."
    : `We're excited to have ${data.organizationName} join us.`;

  // For individual accounts, adjust "your organization" references
  const profileDescription = data.isPersonal
    ? 'Showcase your work and interests'
    : "Showcase your organization's capabilities";

  try {
    // Create tracking record first
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      workos_user_id: data.workosUserId,
      workos_organization_id: data.workosOrganizationId,
      metadata: { organizationName: data.organizationName, productName: data.productName, isPersonal: data.isPersonal },
    });

    const trackingId = emailEvent.tracking_id;

    // Build tracked URLs
    const dashboardUrl = trackedUrl(trackingId, 'cta_dashboard', 'https://agenticadvertising.org/dashboard');
    const websiteUrl = trackedUrl(trackingId, 'footer_website', 'https://agenticadvertising.org');

    // Welcome email is transactional - no unsubscribe link
    const footerHtml = generateFooterHtml(trackingId, null);
    const footerText = generateFooterText(null);

    const { data: sendData, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: data.to,
      subject,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Welcome to AgenticAdvertising.org!</h1>
  </div>

  <p>${greeting}</p>

  <p>Thank you for becoming a member of <strong>AgenticAdvertising.org</strong>! ${welcomeMessage}</p>

  <p>As a member, you now have access to:</p>

  <ul style="padding-left: 20px;">
    <li><strong>Member Directory</strong> - Connect with other members working on agentic advertising</li>
    <li><strong>Working Groups</strong> - Participate in shaping the future of AdCP</li>
    <li><strong>Member Profile</strong> - ${profileDescription}</li>
  </ul>

  <p>To get started, visit your dashboard to set up your member profile:</p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${dashboardUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">Go to Dashboard</a>
  </p>

  <p>If you have any questions, just reply to this email - we're happy to help.</p>

  <p style="margin-top: 30px;">
    Best,<br>
    The AgenticAdvertising.org Team
  </p>
  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
Welcome to AgenticAdvertising.org!

${greeting}

Thank you for becoming a member of AgenticAdvertising.org! ${welcomeMessage}

As a member, you now have access to:
- Member Directory - Connect with other members working on agentic advertising
- Working Groups - Participate in shaping the future of AdCP
- Member Profile - ${profileDescription}

To get started, visit your dashboard to set up your member profile:
https://agenticadvertising.org/dashboard

If you have any questions, just reply to this email - we're happy to help.

Best,
The AgenticAdvertising.org Team

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to, trackingId }, 'Failed to send welcome email');
      return false;
    }

    // Mark as sent with Resend's email ID
    await emailDb.markEmailSent(trackingId, sendData?.id);

    logger.info({ to: data.to, organization: data.organizationName, isPersonal: data.isPersonal || false, trackingId }, 'Welcome email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending welcome email');
    return false;
  }
}

/**
 * Check if we've already sent a signup email to this user
 */
export async function hasSignupEmailBeenSent(workosUserId: string): Promise<boolean> {
  // Check for any variant of signup email
  const memberSent = await emailDb.hasEmailBeenSent({
    email_type: 'signup_user_member',
    workos_user_id: workosUserId,
  });
  const nonMemberSent = await emailDb.hasEmailBeenSent({
    email_type: 'signup_user_nonmember',
    workos_user_id: workosUserId,
  });
  // Also check legacy type
  const legacySent = await emailDb.hasEmailBeenSent({
    email_type: 'signup_user',
    workos_user_id: workosUserId,
  });

  return memberSent || nonMemberSent || legacySent;
}

/**
 * Send signup confirmation email to new users
 * Content varies based on whether their organization has an active subscription
 * Now with tracking and duplicate prevention!
 */
export async function sendUserSignupEmail(data: {
  to: string;
  firstName?: string;
  organizationName?: string;
  hasActiveSubscription: boolean;
  workosUserId?: string;
  workosOrganizationId?: string;
  isLinkedToSlack?: boolean; // If true, skip Slack invite section
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping signup email');
    return false;
  }

  // Check if already sent (if we have user ID)
  if (data.workosUserId) {
    const alreadySent = await hasSignupEmailBeenSent(data.workosUserId);
    if (alreadySent) {
      logger.debug({ userId: data.workosUserId }, 'Signup email already sent to this user, skipping');
      return true; // Return true since this isn't a failure
    }
  }

  const greeting = data.firstName ? `Hi ${data.firstName}!` : 'Hi there!';
  const emailType: EmailType = data.hasActiveSubscription ? 'signup_user_member' : 'signup_user_nonmember';

  // Different content based on subscription status
  const { subject, ctaText, ctaDestination, ctaLinkName } = data.hasActiveSubscription
    ? {
        subject: `Welcome to AgenticAdvertising.org! I'm Addie, your AI assistant`,
        ctaText: 'Go to Dashboard',
        ctaDestination: 'https://agenticadvertising.org/dashboard',
        ctaLinkName: 'cta_dashboard',
      }
    : {
        subject: `Welcome to AgenticAdvertising.org! I'm Addie`,
        ctaText: 'Become a Member',
        ctaDestination: 'https://agenticadvertising.org/dashboard/membership',
        ctaLinkName: 'cta_membership',
      };

  try {
    // Create tracking record
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      workos_user_id: data.workosUserId,
      workos_organization_id: data.workosOrganizationId,
      metadata: {
        firstName: data.firstName,
        organizationName: data.organizationName,
        hasActiveSubscription: data.hasActiveSubscription,
      },
    });

    const trackingId = emailEvent.tracking_id;

    // Build tracked URLs
    const ctaUrl = trackedUrl(trackingId, ctaLinkName, ctaDestination);
    const slackUrl = trackedUrl(trackingId, 'cta_slack_invite', SLACK_INVITE_URL);

    // Signup email is transactional - no unsubscribe link
    // Future marketing emails will include unsubscribe via:
    // const unsubscribeToken = data.workosUserId ? await getUnsubscribeToken(data.workosUserId, data.to) : null;
    const footerHtml = generateFooterHtml(trackingId, null);
    const footerText = generateFooterText(null);

    // Addie section - different content based on whether user is on Slack
    const addieSectionHtml = data.isLinkedToSlack
      ? `
  <div style="background: #f0f9ff; border-radius: 8px; padding: 20px; margin: 20px 0; border-left: 4px solid #2563eb;">
    <p style="margin: 0 0 10px 0;"><strong>Need help? I'm here!</strong></p>
    <p style="margin: 0; font-size: 14px;">I noticed you're already on Slack - you can DM me anytime at <strong>@Addie</strong>. I can help you find members, answer questions about the community, or just chat about agentic advertising.</p>
  </div>`
      : `
  <div style="background: #f8f4ff; border-radius: 8px; padding: 20px; margin: 20px 0; border-left: 4px solid #4A154B;">
    <p style="margin: 0 0 10px 0;"><strong>Join our Slack community!</strong></p>
    <p style="margin: 0 0 15px 0; font-size: 14px;">Most of our community hangs out in Slack - it's where the conversations happen! You can also DM me there anytime.</p>
    <a href="${slackUrl}" style="background-color: #4A154B; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; display: inline-block; font-size: 14px;">Join Slack</a>
  </div>`;

    const addieSectionText = data.isLinkedToSlack
      ? `
---
NEED HELP? I'M HERE!
I noticed you're already on Slack - you can DM me anytime at @Addie. I can help you find members, answer questions about the community, or just chat about agentic advertising.
---
`
      : `
---
JOIN OUR SLACK COMMUNITY
Most of our community hangs out in Slack - it's where the conversations happen! You can also DM me there anytime.
Join Slack: ${SLACK_INVITE_URL}
---
`;

    const mainContent = data.hasActiveSubscription
      ? `
  <p>${greeting}</p>

  <p>I'm Addie, the AI assistant for AgenticAdvertising.org. Welcome! I see you've joined <strong>${data.organizationName || 'your organization'}</strong> - great to have you here.</p>

  <p>Since your team is already a member, you have full access to everything:</p>

  <ul style="padding-left: 20px;">
    <li><strong>Member Directory</strong> - Find and connect with others building agentic advertising</li>
    <li><strong>Your Dashboard</strong> - Manage your organization's profile and settings</li>
    <li><strong>Invite Teammates</strong> - Bring more people from your team on board</li>
  </ul>

  <p>Here's your dashboard:</p>`
      : `
  <p>${greeting}</p>

  <p>I'm Addie, the AI assistant for AgenticAdvertising.org. Thanks for signing up${data.organizationName ? ` with <strong>${data.organizationName}</strong>` : ''}!</p>

  <p>You've created an account, but your organization isn't a member yet. Membership unlocks:</p>

  <ul style="padding-left: 20px;">
    <li><strong>Member Directory</strong> - Connect with companies building agentic advertising</li>
    <li><strong>Working Groups</strong> - Help shape the future of AdCP</li>
    <li><strong>Member Profile</strong> - Show off what your organization does</li>
  </ul>

  <p>Want to become a member?</p>`;

    const { data: sendData, error } = await resend.emails.send({
      from: FROM_EMAIL_ADDIE,
      to: data.to,
      subject,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Welcome!</h1>
  </div>

  ${mainContent}

  <p style="text-align: center; margin: 30px 0;">
    <a href="${ctaUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">${ctaText}</a>
  </p>

  ${addieSectionHtml}

  <p>If you have any questions, just reply to this email and I'll help you out!</p>

  <p style="margin-top: 30px;">
    Talk soon,<br>
    Addie
  </p>
  ${footerHtml}
</body>
</html>
      `.trim(),
      text: data.hasActiveSubscription
        ? `Welcome!

${data.firstName ? `Hi ${data.firstName}!` : 'Hi there!'}

I'm Addie, the AI assistant for AgenticAdvertising.org. Welcome! I see you've joined ${data.organizationName || 'your organization'} - great to have you here.

Since your team is already a member, you have full access to everything:
- Member Directory - Find and connect with others building agentic advertising
- Your Dashboard - Manage your organization's profile and settings
- Invite Teammates - Bring more people from your team on board

Here's your dashboard:
https://agenticadvertising.org/dashboard
${addieSectionText}
If you have any questions, just reply to this email and I'll help you out!

Talk soon,
Addie

${footerText}`
        : `Welcome!

${data.firstName ? `Hi ${data.firstName}!` : 'Hi there!'}

I'm Addie, the AI assistant for AgenticAdvertising.org. Thanks for signing up${data.organizationName ? ` with ${data.organizationName}` : ''}!

You've created an account, but your organization isn't a member yet. Membership unlocks:
- Member Directory - Connect with companies building agentic advertising
- Working Groups - Help shape the future of AdCP
- Member Profile - Show off what your organization does

Want to become a member?
https://agenticadvertising.org/dashboard/membership
${addieSectionText}
If you have any questions, just reply to this email and I'll help you out!

Talk soon,
Addie

${footerText}`,
    });

    if (error) {
      logger.error({ error, to: data.to, trackingId }, 'Failed to send signup email');
      return false;
    }

    // Mark as sent
    await emailDb.markEmailSent(trackingId, sendData?.id);

    logger.info(
      { to: data.to, hasActiveSubscription: data.hasActiveSubscription, trackingId },
      'User signup email sent'
    );
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending signup email');
    return false;
  }
}

/**
 * Send a marketing/campaign email with unsubscribe capability
 * This is used for newsletters, announcements, etc.
 */
export async function sendMarketingEmail(data: {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  category: string;
  workosUserId: string;
  workosOrganizationId?: string;
  campaignId?: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping marketing email');
    return false;
  }

  // Check if user wants to receive this category
  const shouldSend = await emailPrefsDb.shouldSendEmail({
    workos_user_id: data.workosUserId,
    category_id: data.category,
  });

  if (!shouldSend) {
    logger.debug({ userId: data.workosUserId, category: data.category }, 'User opted out of category, skipping');
    return true; // Not a failure, just respecting preferences
  }

  try {
    // Get unsubscribe token
    const unsubscribeToken = await getUnsubscribeToken(data.workosUserId, data.to);

    // Create tracking record
    const emailEvent = await emailDb.createEmailEvent({
      email_type: data.category,
      recipient_email: data.to,
      subject: data.subject,
      workos_user_id: data.workosUserId,
      workos_organization_id: data.workosOrganizationId,
      metadata: { campaignId: data.campaignId },
    });

    const trackingId = emailEvent.tracking_id;

    // Generate footer with unsubscribe link
    const footerHtml = generateFooterHtml(trackingId, unsubscribeToken, data.category);
    const footerText = generateFooterText(unsubscribeToken, data.category);

    const { data: sendData, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: data.to,
      subject: data.subject,
      headers: {
        'List-Unsubscribe': `<${BASE_URL}/unsubscribe/${unsubscribeToken}>`,
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
  ${data.htmlContent}
  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `${data.textContent}

${footerText}`,
    });

    if (error) {
      logger.error({ error, to: data.to, trackingId }, 'Failed to send marketing email');
      return false;
    }

    await emailDb.markEmailSent(trackingId, sendData?.id);

    logger.info({ to: data.to, category: data.category, trackingId }, 'Marketing email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending marketing email');
    return false;
  }
}

export interface BatchMarketingEmail {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  category: string;
  workosUserId: string;
}

export interface BatchSendResult {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Send marketing emails in batches via Resend batch API.
 * Handles preference checks, tracking records, and unsubscribe links per-recipient,
 * then sends in chunks of 100 via the batch endpoint.
 */
export async function sendBatchMarketingEmails(
  emails: BatchMarketingEmail[],
): Promise<BatchSendResult> {
  const result: BatchSendResult = { sent: 0, skipped: 0, failed: 0 };

  if (!resend) {
    logger.debug('Resend not configured, skipping batch marketing emails');
    return result;
  }

  // Prepare each email: check preferences, create tracking, build final HTML
  const prepared: Array<{
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
    trackingId: string;
  }> = [];

  for (const email of emails) {
    const shouldSend = await emailPrefsDb.shouldSendEmail({
      workos_user_id: email.workosUserId,
      category_id: email.category,
    });

    if (!shouldSend) {
      result.skipped++;
      continue;
    }

    try {
      const unsubscribeToken = await getUnsubscribeToken(email.workosUserId, email.to);
      const emailEvent = await emailDb.createEmailEvent({
        email_type: email.category,
        recipient_email: email.to,
        subject: email.subject,
        workos_user_id: email.workosUserId,
        metadata: {},
      });

      const trackingId = emailEvent.tracking_id;
      const footerHtml = generateFooterHtml(trackingId, unsubscribeToken, email.category);
      const footerText = generateFooterText(unsubscribeToken, email.category);

      prepared.push({
        to: email.to,
        subject: email.subject,
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${email.htmlContent}
  ${footerHtml}
</body>
</html>`,
        text: `${email.textContent}\n\n${footerText}`,
        headers: {
          'List-Unsubscribe': `<${BASE_URL}/unsubscribe/${unsubscribeToken}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        trackingId,
      });
    } catch (error) {
      logger.error({ error, to: email.to }, 'Failed to prepare marketing email');
      result.failed++;
    }
  }

  // Send in batches of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const batch = prepared.slice(i, i + BATCH_SIZE);

    try {
      const { data: batchData, error } = await resend.batch.send(
        batch.map((e) => ({
          from: FROM_EMAIL,
          to: e.to,
          subject: e.subject,
          html: e.html,
          text: e.text,
          headers: e.headers,
        })),
      );

      if (error) {
        logger.error({ error, batchIndex: i, batchSize: batch.length }, 'Batch send failed');
        result.failed += batch.length;
        continue;
      }

      // Mark each as sent
      const batchResults = batchData?.data || [];
      for (let j = 0; j < batch.length; j++) {
        const resendId = batchResults[j]?.id;
        await emailDb.markEmailSent(batch[j].trackingId, resendId);
        result.sent++;
      }

      logger.info({ batchIndex: i, count: batch.length }, 'Batch marketing emails sent');
    } catch (error) {
      logger.error({ error, batchIndex: i }, 'Error sending batch marketing emails');
      result.failed += batch.length;
    }
  }

  return result;
}

/**
 * Email thread context for replies
 * Contains the information needed to properly thread a reply
 */
export interface EmailThreadContext {
  messageId: string; // The Message-ID of the email being replied to
  references?: string[]; // Previous Message-IDs in the thread
  subject: string; // Original subject (we'll add "Re: " if needed)
  from: string; // Who sent the original email
  to: string[]; // Original TO recipients
  cc?: string[]; // Original CC recipients
  replyTo?: string; // Reply-To header if present
  originalText?: string; // Original email text for quoting
  originalDate?: Date; // When the original was sent
}

/**
 * Send an email reply that properly threads with the original conversation
 * Used by Addie to respond to email invocations
 */
export async function sendEmailReply(data: {
  threadContext: EmailThreadContext;
  htmlContent: string;
  textContent: string;
  fromName?: string; // Name to show (defaults to "Addie from AgenticAdvertising.org")
  fromEmail?: string; // Email address to send from (defaults to addie@agenticadvertising.org)
  excludeAddresses?: string[]; // Addresses to exclude from recipients (e.g., the Addie address itself)
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!resend) {
    logger.warn('Resend not configured, cannot send email reply');
    return { success: false, error: 'Email not configured' };
  }

  const fromName = data.fromName || 'Addie from AgenticAdvertising.org';
  // Validate fromEmail is from our domain to prevent spoofing
  const ALLOWED_FROM_DOMAINS = ['agenticadvertising.org', 'updates.agenticadvertising.org'];
  const fromEmail = (() => {
    if (data.fromEmail) {
      const domain = data.fromEmail.split('@')[1]?.toLowerCase();
      if (domain && ALLOWED_FROM_DOMAINS.includes(domain)) {
        return data.fromEmail;
      }
      logger.warn({ requestedFromEmail: data.fromEmail }, 'Rejected invalid fromEmail domain');
    }
    return 'addie@agenticadvertising.org';
  })();
  const from = `${fromName} <${fromEmail}>`;

  // Build recipient list for reply-all
  // Include original sender + all TO/CC, excluding our own addresses
  const shouldInclude = (addr: string): boolean => {
    const email = addr.toLowerCase();
    // Exclude our own domain addresses
    if (email.includes('@agenticadvertising.org') || email.includes('@updates.agenticadvertising.org')) {
      return false;
    }
    // Exclude explicitly provided addresses
    return !(data.excludeAddresses || []).some(pattern => email.includes(pattern.toLowerCase()));
  };

  // Parse the original sender - they go in TO
  const replyTo = data.threadContext.replyTo || data.threadContext.from;
  const toRecipients = [replyTo].filter(shouldInclude);

  // Original TO and CC (minus sender, minus us) go in CC
  const ccRecipients = [
    ...data.threadContext.to,
    ...(data.threadContext.cc || []),
  ].filter(addr => {
    const email = addr.toLowerCase();
    // Exclude the original sender (they're in TO now) and our addresses
    return shouldInclude(addr) && !email.includes(replyTo.toLowerCase().split('<').pop()?.split('>')[0] || '');
  });

  if (toRecipients.length === 0) {
    logger.error({ threadContext: data.threadContext }, 'No valid recipients for email reply');
    return { success: false, error: 'No valid recipients' };
  }

  // Build subject - add "Re: " if not already present
  let subject = data.threadContext.subject;
  if (!subject.toLowerCase().startsWith('re:')) {
    subject = `Re: ${subject}`;
  }

  // Build References header - includes all previous message IDs plus the one we're replying to
  const references = [
    ...(data.threadContext.references || []),
    data.threadContext.messageId,
  ].filter(Boolean).join(' ');

  // Build quoted original message if available
  let quotedHtml = '';
  let quotedText = '';
  if (data.threadContext.originalText) {
    const senderName = data.threadContext.from.replace(/<.*>/, '').trim() || data.threadContext.from;
    const dateStr = data.threadContext.originalDate
      ? data.threadContext.originalDate.toLocaleDateString('en-US', {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';

    // Build attribution line (with or without date)
    const attribution = dateStr ? `On ${dateStr}, ${senderName} wrote:` : `${senderName} wrote:`;

    // Truncate quoted text to keep emails reasonable
    const truncatedOriginal = data.threadContext.originalText.substring(0, 2000);
    const escapedOriginal = truncatedOriginal
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    quotedHtml = `
  <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #e5e5e5;">
    <p style="font-size: 12px; color: #666; margin-bottom: 10px;">
      ${attribution}
    </p>
    <blockquote style="margin: 0; padding-left: 15px; border-left: 3px solid #e5e5e5; color: #666; font-size: 14px;">
      ${escapedOriginal}
    </blockquote>
  </div>`;

    // Build text version with > quoting
    const quotedLines = truncatedOriginal.split('\n').map(line => `> ${line}`).join('\n');
    quotedText = `\n\n${attribution}\n${quotedLines}`;
  }

  try {
    const { data: sendData, error } = await resend.emails.send({
      from,
      to: toRecipients,
      cc: ccRecipients.length > 0 ? ccRecipients : undefined,
      subject,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${data.htmlContent}

  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">
  <p style="font-size: 12px; color: #666;">
    Addie is the AI assistant for <a href="https://agenticadvertising.org" style="color: #2563eb;">AgenticAdvertising.org</a>
  </p>
  ${quotedHtml}
</body>
</html>
      `.trim(),
      text: `${data.textContent}

---
Addie is the AI assistant for AgenticAdvertising.org
https://agenticadvertising.org${quotedText}`,
      headers: {
        'In-Reply-To': data.threadContext.messageId,
        ...(references && { References: references }),
      },
    });

    if (error) {
      logger.error({ error, to: toRecipients, cc: ccRecipients }, 'Failed to send email reply');
      return { success: false, error: error.message };
    }

    logger.info({
      messageId: sendData?.id,
      to: toRecipients,
      cc: ccRecipients,
      subject,
      inReplyTo: data.threadContext.messageId,
    }, 'Addie sent email reply');

    return { success: true, messageId: sendData?.id };
  } catch (error) {
    logger.error({ error }, 'Error sending email reply');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Send an introduction email from Addie connecting a searcher with a member
 * This is a transactional email (no unsubscribe needed)
 */
export async function sendIntroductionEmail(data: {
  memberEmail: string;
  memberName: string;
  memberSlug: string;
  requesterName: string;
  requesterEmail: string;
  requesterCompany?: string;
  requesterMessage: string;
  searchQuery?: string;
  addieReasoning?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!resend) {
    logger.warn('Resend not configured, cannot send introduction email');
    return { success: false, error: 'Email not configured' };
  }

  const escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');

  // Sanitize and truncate for subject line (prevent injection and excessive length)
  const safeName = (data.requesterName || 'Someone').slice(0, 50).replace(/[\r\n]/g, '');
  const safeCompany = data.requesterCompany ? data.requesterCompany.slice(0, 50).replace(/[\r\n]/g, '') : '';

  // Build the subject line
  const subject = `Introduction: ${safeName}${safeCompany ? ` from ${safeCompany}` : ''} wants to connect`;

  // Build the context section if we have search info
  let contextHtml = '';
  let contextText = '';
  if (data.searchQuery || data.addieReasoning) {
    contextHtml = `
    <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <p style="font-size: 12px; color: #6b7280; margin: 0 0 8px 0; font-weight: 500;">WHY THIS INTRODUCTION</p>
      ${data.searchQuery ? `<p style="margin: 0 0 8px 0;"><strong>They searched for:</strong> "${escapeHtml(data.searchQuery)}"</p>` : ''}
      ${data.addieReasoning ? `<p style="margin: 0; color: #374151;">${escapeHtml(data.addieReasoning)}</p>` : ''}
    </div>`;

    contextText = `\n---\nWHY THIS INTRODUCTION\n`;
    if (data.searchQuery) contextText += `They searched for: "${data.searchQuery}"\n`;
    if (data.addieReasoning) contextText += `${data.addieReasoning}\n`;
    contextText += `---\n`;
  }

  // Build requester info
  const requesterInfo = data.requesterCompany
    ? `${data.requesterName} from ${data.requesterCompany}`
    : data.requesterName;

  try {
    const { data: sendData, error } = await resend.emails.send({
      from: 'Addie from AgenticAdvertising.org <addie@agenticadvertising.org>',
      to: data.memberEmail,
      replyTo: data.requesterEmail,
      subject,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>Hi ${escapeHtml(data.memberName.split(' ')[0] || data.memberName)},</p>

  <p><strong>${escapeHtml(requesterInfo)}</strong> found your profile on AgenticAdvertising.org and asked me to make an introduction.</p>

  ${contextHtml}

  <div style="background: #fafafa; border-left: 4px solid #2563eb; padding: 16px; margin: 20px 0;">
    <p style="font-size: 12px; color: #6b7280; margin: 0 0 8px 0; font-weight: 500;">THEIR MESSAGE</p>
    <p style="margin: 0;">${escapeHtml(data.requesterMessage)}</p>
  </div>

  <p><strong>Reply directly to this email</strong> to connect with ${escapeHtml(data.requesterName)} - your response will go straight to them at ${escapeHtml(data.requesterEmail)}.</p>

  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

  <p style="font-size: 12px; color: #666;">
    This introduction was made through <a href="https://agenticadvertising.org" style="color: #2563eb;">AgenticAdvertising.org</a>.<br>
    <a href="https://agenticadvertising.org/members/${escapeHtml(data.memberSlug)}" style="color: #2563eb;">View your member profile</a> |
    <a href="https://agenticadvertising.org/member-profile" style="color: #2563eb;">Update your profile</a>
  </p>
</body>
</html>
      `.trim(),
      text: `Hi ${data.memberName.split(' ')[0] || data.memberName},

${requesterInfo} found your profile on AgenticAdvertising.org and asked me to make an introduction.
${contextText}
---
THEIR MESSAGE

${data.requesterMessage}
---

Reply directly to this email to connect with ${data.requesterName} - your response will go straight to them at ${data.requesterEmail}.

---
This introduction was made through AgenticAdvertising.org.
View your member profile: https://agenticadvertising.org/members/${data.memberSlug}
Update your profile: https://agenticadvertising.org/member-profile
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.memberEmail }, 'Failed to send introduction email');
      return { success: false, error: error.message };
    }

    logger.info({
      messageId: sendData?.id,
      to: data.memberEmail,
      from: data.requesterEmail,
      memberSlug: data.memberSlug,
    }, 'Introduction email sent');

    return { success: true, messageId: sendData?.id };
  } catch (error) {
    logger.error({ error }, 'Error sending introduction email');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ============== Slack Invite Email ==============

export const SLACK_INVITE_URL = process.env.SLACK_INVITE_URL || 'https://join.slack.com/t/agenticads/shared_invite/your-invite-link';

/**
 * Check if we've already sent a Slack invite email to this user
 */
export async function hasSlackInviteBeenSent(workosUserId: string): Promise<boolean> {
  return emailDb.hasEmailBeenSent({
    email_type: 'slack_invite',
    workos_user_id: workosUserId,
  });
}

/**
 * Send Slack invite email to website-only users
 * These are users who have a website account but aren't in Slack yet
 */
export async function sendSlackInviteEmail(data: {
  to: string;
  firstName?: string;
  workosUserId: string;
  workosOrganizationId?: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping Slack invite email');
    return false;
  }

  // Check if already sent
  const alreadySent = await hasSlackInviteBeenSent(data.workosUserId);
  if (alreadySent) {
    logger.debug({ userId: data.workosUserId }, 'Slack invite email already sent to this user, skipping');
    return true; // Return true since this isn't a failure
  }

  const emailType: EmailType = 'slack_invite';
  const subject = 'Join the AgenticAdvertising.org Slack community';
  const greeting = data.firstName ? `Hi ${data.firstName},` : 'Hi there,';

  try {
    // Create tracking record first
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      workos_user_id: data.workosUserId,
      workos_organization_id: data.workosOrganizationId,
      metadata: {},
    });

    const trackingId = emailEvent.tracking_id;

    // Build tracked URLs
    const slackUrl = trackedUrl(trackingId, 'cta_slack_invite', SLACK_INVITE_URL);

    // Get unsubscribe token for marketing email
    const unsubscribeToken = await getUnsubscribeToken(data.workosUserId, data.to);
    const footerHtml = generateFooterHtml(trackingId, unsubscribeToken, 'community updates');
    const footerText = generateFooterText(unsubscribeToken, 'community updates');

    const { data: sendData, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: data.to,
      subject,
      headers: {
        'List-Unsubscribe': `<${BASE_URL}/unsubscribe/${unsubscribeToken}>`,
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
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Join our Slack community!</h1>
  </div>

  <p>${greeting}</p>

  <p>Thanks for being part of AgenticAdvertising.org! We wanted to let you know about our <strong>Slack community</strong> where members connect, share ideas, and collaborate on agentic advertising.</p>

  <p>In Slack, you can:</p>

  <ul style="padding-left: 20px;">
    <li><strong>Connect with other members</strong> working on AI-powered advertising</li>
    <li><strong>Join working groups</strong> and participate in discussions</li>
    <li><strong>Get updates</strong> on events, specs, and community news</li>
    <li><strong>Ask questions</strong> and get help from the community</li>
  </ul>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${slackUrl}" style="background-color: #4A154B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">Join Slack</a>
  </p>

  <p style="font-size: 14px; color: #666;">Already have a Slack account? Just use the same email address you used to sign up for the website, and your accounts will be automatically linked.</p>

  <p>See you in Slack!</p>

  <p style="margin-top: 30px;">
    Best,<br>
    The AgenticAdvertising.org Team
  </p>
  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
Join our Slack community!

${greeting}

Thanks for being part of AgenticAdvertising.org! We wanted to let you know about our Slack community where members connect, share ideas, and collaborate on agentic advertising.

In Slack, you can:
- Connect with other members working on AI-powered advertising
- Join working groups and participate in discussions
- Get updates on events, specs, and community news
- Ask questions and get help from the community

Join Slack: ${SLACK_INVITE_URL}

Already have a Slack account? Just use the same email address you used to sign up for the website, and your accounts will be automatically linked.

See you in Slack!

Best,
The AgenticAdvertising.org Team

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to, trackingId }, 'Failed to send Slack invite email');
      return false;
    }

    // Mark as sent with Resend's email ID
    await emailDb.markEmailSent(trackingId, sendData?.id);

    logger.info({ to: data.to, trackingId }, 'Slack invite email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending Slack invite email');
    return false;
  }
}

// Re-export for use in routes
export { emailDb, emailPrefsDb, getUnsubscribeToken };
