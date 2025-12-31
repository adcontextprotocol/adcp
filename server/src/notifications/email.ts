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
export type EmailType = 'welcome_member' | 'signup_user' | 'signup_user_member' | 'signup_user_nonmember';

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

  const greeting = data.firstName ? `Hi ${data.firstName},` : 'Hi there,';
  const emailType: EmailType = data.hasActiveSubscription ? 'signup_user_member' : 'signup_user_nonmember';

  // Different content based on subscription status
  const { subject, ctaText, ctaDestination, ctaLinkName } = data.hasActiveSubscription
    ? {
        subject: `Welcome to ${data.organizationName || 'your team'} on AgenticAdvertising.org`,
        ctaText: 'Go to Dashboard',
        ctaDestination: 'https://agenticadvertising.org/dashboard',
        ctaLinkName: 'cta_dashboard',
      }
    : {
        subject: 'Welcome to AgenticAdvertising.org',
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

    // Signup email is transactional - no unsubscribe link
    // Future marketing emails will include unsubscribe via:
    // const unsubscribeToken = data.workosUserId ? await getUnsubscribeToken(data.workosUserId, data.to) : null;
    const footerHtml = generateFooterHtml(trackingId, null);
    const footerText = generateFooterText(null);

    const mainContent = data.hasActiveSubscription
      ? `
  <p>${greeting}</p>

  <p>You've joined <strong>${data.organizationName || 'your organization'}</strong> on AgenticAdvertising.org. Your team is already a member!</p>

  <p>Here's what you can do:</p>

  <ul style="padding-left: 20px;">
    <li><strong>View the Member Directory</strong> - Connect with other members building agentic advertising</li>
    <li><strong>Access your Dashboard</strong> - Manage your organization's profile and settings</li>
    <li><strong>Invite Teammates</strong> - Add more people from your organization</li>
  </ul>

  <p>Get started by visiting your dashboard:</p>`
      : `
  <p>${greeting}</p>

  <p>Thanks for signing up for AgenticAdvertising.org${data.organizationName ? ` with <strong>${data.organizationName}</strong>` : ''}!</p>

  <p>You've created an account, but your organization isn't a member yet. Membership gives you access to:</p>

  <ul style="padding-left: 20px;">
    <li><strong>Member Directory</strong> - Connect with companies building agentic advertising</li>
    <li><strong>Working Groups</strong> - Participate in shaping the future of AdCP</li>
    <li><strong>Member Profile</strong> - Showcase your organization's capabilities</li>
  </ul>

  <p>Ready to become a member?</p>`;

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
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Welcome!</h1>
  </div>

  ${mainContent}

  <p style="text-align: center; margin: 30px 0;">
    <a href="${ctaUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">${ctaText}</a>
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
      text: data.hasActiveSubscription
        ? `Welcome!

${data.firstName ? `Hi ${data.firstName},` : 'Hi there,'}

You've joined ${data.organizationName || 'your organization'} on AgenticAdvertising.org. Your team is already a member!

Here's what you can do:
- View the Member Directory - Connect with other members building agentic advertising
- Access your Dashboard - Manage your organization's profile and settings
- Invite Teammates - Add more people from your organization

Get started by visiting your dashboard:
https://agenticadvertising.org/dashboard

If you have any questions, just reply to this email - we're happy to help.

Best,
The AgenticAdvertising.org Team

${footerText}`
        : `Welcome!

${data.firstName ? `Hi ${data.firstName},` : 'Hi there,'}

Thanks for signing up for AgenticAdvertising.org${data.organizationName ? ` with ${data.organizationName}` : ''}!

You've created an account, but your organization isn't a member yet. Membership gives you access to:
- Member Directory - Connect with companies building agentic advertising
- Working Groups - Participate in shaping the future of AdCP
- Member Profile - Showcase your organization's capabilities

Ready to become a member?
https://agenticadvertising.org/dashboard/membership

If you have any questions, just reply to this email - we're happy to help.

Best,
The AgenticAdvertising.org Team

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

// Re-export for use in routes
export { emailDb, emailPrefsDb, getUnsubscribeToken };
