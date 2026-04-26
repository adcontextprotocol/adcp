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
  | 'slack_invite'
  | 'email_link_verification'
  | 'escalation_resolution'
  | 'newsletter_subscribe_confirmation'
  | 'membership_invite'
  | 'duplicate_subscription_notice';

/**
 * Send welcome email to new members after subscription is created
 * Now with tracking!
 *
 * If `listing` is provided, an "Your listing is live" section is included
 * that links to the public listing and the edit / privacy controls. This is
 * populated by the Stripe webhook when `ensureMemberProfilePublished` has
 * just created or flipped a profile public — consistent with the activation
 * touch, so admins know their listing went public without a separate email.
 */
export async function sendWelcomeEmail(data: {
  to: string;
  organizationName: string;
  productName?: string;
  workosUserId?: string;
  workosOrganizationId?: string;
  isPersonal?: boolean;
  firstName?: string;
  listing?: {
    slug: string;
    action: 'created' | 'published';
  };
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

    // Optional: auto-published listing section. Piggybacks on this email so
    // admins see (and can correct) the listing without a separate send.
    let listingSectionHtml = '';
    let listingSectionText = '';
    if (data.listing) {
      const orgQuery = data.workosOrganizationId
        ? `?org=${encodeURIComponent(data.workosOrganizationId)}`
        : '';
      // Defense-in-depth: slugs are validated at creation (slugify → [a-z0-9-]),
      // but the URL path and display both encode/escape so a future policy
      // change can't introduce injection here.
      const encodedSlug = encodeURIComponent(data.listing.slug);
      const safeSlug = escapeHtml(data.listing.slug);
      const viewUrl = trackedUrl(
        trackingId,
        'cta_listing_view',
        `https://agenticadvertising.org/members/${encodedSlug}`,
      );
      const editUrl = trackedUrl(
        trackingId,
        'cta_listing_edit',
        `https://agenticadvertising.org/member-profile${orgQuery}`,
      );
      const privacyAnchor = orgQuery ? `${orgQuery}#field-is-public` : '#field-is-public';
      const privacyUrl = trackedUrl(
        trackingId,
        'cta_listing_privacy',
        `https://agenticadvertising.org/member-profile${privacyAnchor}`,
      );
      const intro = data.listing.action === 'created'
        ? 'Your directory listing is now live. We created it when your membership activated so other members and visitors can find you.'
        : 'Your directory listing is now live — we published it when your membership activated.';
      listingSectionHtml = `
  <div style="background: #f8fafc; border-left: 4px solid #2563eb; border-radius: 8px; padding: 16px 20px; margin: 24px 0;">
    <p style="margin: 0 0 10px 0;"><strong>Your listing is live</strong></p>
    <p style="margin: 0 0 12px 0; font-size: 14px;">${intro}</p>
    <p style="margin: 0 0 4px 0; font-size: 14px;">
      <a href="${viewUrl}" style="color: #2563eb;">View listing</a>
      &nbsp;·&nbsp;
      <a href="${editUrl}" style="color: #2563eb;">Edit</a>
      &nbsp;·&nbsp;
      <a href="${privacyUrl}" style="color: #2563eb;">Make private</a>
    </p>
    <p style="margin: 8px 0 0 0; font-size: 12px; color: #666;">/members/${safeSlug}</p>
  </div>`;
      listingSectionText = `
Your listing is live
${intro}
- View: https://agenticadvertising.org/members/${encodedSlug}
- Edit: https://agenticadvertising.org/member-profile${orgQuery}
- Make private: https://agenticadvertising.org/member-profile${privacyAnchor}
`;
    }

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
  ${listingSectionHtml}
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
${listingSectionText}
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
  from?: string;
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
      from: data.from || FROM_EMAIL,
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
    from?: string;
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
          from: e.from || FROM_EMAIL,
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
    const senderName = data.threadContext.from.replace(/<[^>]*>/, '').trim() || data.threadContext.from;
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

export const SLACK_INVITE_URL = process.env.SLACK_INVITE_URL || 'https://join.slack.com/t/agenticads/shared_invite/zt-3h15gj6c0-FRTrD_y4HqmeXDKBl2TDEA';

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

// Re-export for use in routes and digest templates
export { emailDb, emailPrefsDb, getUnsubscribeToken, trackedUrl };

/**
 * Render callback for tracked batch marketing emails.
 * Receives the email tracking ID so templates can wrap links with trackedUrl().
 */
export type TrackedEmailRenderer = (trackingId: string) => { htmlContent: string; textContent: string };

export interface TrackedBatchMarketingEmail {
  to: string;
  subject: string;
  render: TrackedEmailRenderer;
  category: string;
  workosUserId: string;
  metadata?: Record<string, unknown>;
  from?: string;
}

/**
 * Send marketing emails where the template needs the tracking ID for link tracking.
 * Pre-creates email events to get tracking IDs, renders with them, then sends.
 */
export async function sendTrackedBatchMarketingEmails(
  emails: TrackedBatchMarketingEmail[],
): Promise<BatchSendResult> {
  const result: BatchSendResult = { sent: 0, skipped: 0, failed: 0 };

  if (!resend) {
    logger.debug('Resend not configured, skipping tracked batch marketing emails');
    return result;
  }

  const prepared: Array<{
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Record<string, string>;
    trackingId: string;
    from?: string;
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
        metadata: email.metadata || {},
      });

      const trackingId = emailEvent.tracking_id;

      // Render the email with the real tracking ID so links are tracked
      const { htmlContent, textContent } = email.render(trackingId);

      const footerHtml = generateFooterHtml(trackingId, unsubscribeToken, email.category);
      const footerText = generateFooterText(unsubscribeToken, email.category);

      prepared.push({
        to: email.to,
        subject: email.subject,
        from: email.from,
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${htmlContent}
  ${footerHtml}
</body>
</html>`,
        text: `${textContent}\n\n${footerText}`,
        headers: {
          'List-Unsubscribe': `<${BASE_URL}/unsubscribe/${unsubscribeToken}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        trackingId,
      });
    } catch (error) {
      logger.error({ error, to: email.to }, 'Failed to prepare tracked marketing email');
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
          from: e.from || FROM_EMAIL,
          to: e.to,
          subject: e.subject,
          html: e.html,
          text: e.text,
          headers: e.headers,
        })),
      );

      if (error) {
        logger.error({ error, batchIndex: i, batchSize: batch.length }, 'Tracked batch send failed');
        result.failed += batch.length;
        continue;
      }

      const batchResults = batchData?.data || [];
      for (let j = 0; j < batch.length; j++) {
        const resendId = batchResults[j]?.id;
        await emailDb.markEmailSent(batch[j].trackingId, resendId);
        result.sent++;
      }

      logger.info({ batchIndex: i, count: batch.length }, 'Tracked batch marketing emails sent');
    } catch (error) {
      logger.error({ error, batchIndex: i }, 'Error sending tracked batch marketing emails');
      result.failed += batch.length;
    }
  }

  return result;
}

/**
 * Send a verification email for linking another email to an account.
 * Transactional — no unsubscribe link.
 */
export async function sendEmailLinkVerification(data: {
  to: string;
  token: string;
  primaryUserName: string;
  primaryEmail: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping email link verification');
    return false;
  }

  const emailType: EmailType = 'email_link_verification';
  const subject = 'Verify your email link — AgenticAdvertising.org';

  const escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const safeName = escapeHtml(data.primaryUserName);
  const safeEmail = escapeHtml(data.primaryEmail);
  const verifyUrl = `${BASE_URL}/verify-email-link?token=${data.token}`;

  try {
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      metadata: { primaryEmail: data.primaryEmail },
    });

    const trackingId = emailEvent.tracking_id;
    const trackedVerifyUrl = trackedUrl(trackingId, 'cta_verify_email', verifyUrl);
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
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Verify Your Email</h1>
  </div>

  <p>Hi,</p>

  <p><strong>${safeName}</strong> (${safeEmail}) wants to link this email address to their AgenticAdvertising.org account.</p>

  <p>If this was you, click the button below to verify ownership. If you have an existing account with this email, your accounts will be merged — all your memberships, certifications, and activity will be consolidated.</p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${trackedVerifyUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">Verify Email Link</a>
  </p>

  <p style="font-size: 13px; color: #666;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>

  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
Verify Your Email — AgenticAdvertising.org

${data.primaryUserName} (${data.primaryEmail}) wants to link this email address to their AgenticAdvertising.org account.

If this was you, click the link below to verify. If you have an existing account, your accounts will be merged.

${verifyUrl}

This link expires in 24 hours. If you didn't request this, you can safely ignore this email.

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to }, 'Failed to send email link verification');
      return false;
    }

    if (sendData?.id) {
      await emailDb.markEmailSent(trackingId, sendData.id);
    }

    logger.info({ to: data.to, trackingId }, 'Email link verification sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending email link verification');
    return false;
  }
}

/**
 * Send escalation resolution notification email.
 * Used as fallback when the user has no Slack account but has an email on record.
 */
export async function sendEscalationResolutionEmail(data: {
  to: string;
  userName?: string;
  summary: string;
  status: 'resolved' | 'wont_do';
  notificationMessage?: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping escalation resolution email');
    return false;
  }

  const emailType: EmailType = 'escalation_resolution';
  const statusLabel = data.status === 'resolved' ? 'resolved' : 'reviewed and closed';
  const subject = `Your request has been ${statusLabel} — AgenticAdvertising.org`;

  const escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const safeSummary = escapeHtml(data.summary);
  const safeMessage = data.notificationMessage ? escapeHtml(data.notificationMessage) : null;
  const greeting = data.userName ? `Hi ${escapeHtml(data.userName)},` : 'Hi,';

  try {
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      metadata: { escalation_summary: data.summary },
    });

    const trackingId = emailEvent.tracking_id;
    const footerHtml = generateFooterHtml(trackingId, null);
    const footerText = generateFooterText(null);

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
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Request Update</h1>
  </div>

  <p>${greeting}</p>

  <p>Your request has been <strong>${statusLabel}</strong>:</p>

  <blockquote style="border-left: 4px solid #2563eb; margin: 16px 0; padding: 8px 16px; color: #555;">${safeSummary}</blockquote>

  ${safeMessage ? `<p>${safeMessage}</p>` : ''}

  <p>If you have questions or need further help, reply to this email or reach out on <a href="https://agenticadvertising.org">AgenticAdvertising.org</a>.</p>

  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
Request Update — AgenticAdvertising.org

${data.userName ? `Hi ${data.userName},` : 'Hi,'}

Your request has been ${statusLabel}:

"${data.summary}"

${data.notificationMessage || ''}

If you have questions or need further help, reply to this email or reach out on agenticadvertising.org.

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to }, 'Failed to send escalation resolution email');
      return false;
    }

    if (sendData?.id) {
      await emailDb.markEmailSent(trackingId, sendData.id);
    }

    logger.info({ to: data.to, trackingId }, 'Escalation resolution email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending escalation resolution email');
    return false;
  }
}

/**
 * Send a branded confirmation email for the non-member newsletter subscribe
 * flow. Transactional — no unsubscribe link.
 */
export async function sendNewsletterConfirmation(data: {
  to: string;
  confirmUrl: string;
  source: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping newsletter confirmation');
    return false;
  }

  const emailType: EmailType = 'newsletter_subscribe_confirmation';
  const subject = 'Confirm your subscription to The Prompt';

  try {
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      metadata: { source: data.source },
    });

    const trackingId = emailEvent.tracking_id;
    const trackedConfirmUrl = trackedUrl(trackingId, 'cta_newsletter_confirm', data.confirmUrl);
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
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Confirm your subscription</h1>
  </div>

  <p>Thanks for signing up for updates from AgenticAdvertising.org.</p>

  <p>Click the button below to confirm and we'll send you <strong>The Prompt</strong> — weekly industry news on agentic advertising — plus occasional event invitations.</p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${trackedConfirmUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">Confirm subscription</a>
  </p>

  <p style="font-size: 13px; color: #666;">This link expires in 24 hours. If you didn't sign up, you can safely ignore this email — you won't be subscribed and we won't email you again.</p>

  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
Confirm your subscription to AgenticAdvertising.org

Thanks for signing up for updates. Click the link below to confirm and we'll send you The Prompt — weekly industry news on agentic advertising.

${data.confirmUrl}

This link expires in 24 hours. If you didn't sign up, you can safely ignore this email.

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to }, 'Failed to send newsletter confirmation');
      return false;
    }

    if (sendData?.id) {
      await emailDb.markEmailSent(trackingId, sendData.id);
    }

    logger.info({ to: data.to, trackingId, source: data.source }, 'Newsletter confirmation sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending newsletter confirmation');
    return false;
  }
}

/**
 * Send a membership invitation to a prospect contact. The link drops them
 * on /invite/:token where they sign in, join the org, sign the membership
 * agreement, confirm billing details, and an invoice is issued.
 */
export async function sendMembershipInviteEmail(data: {
  to: string;
  contactName?: string | null;
  orgName: string;
  tierDisplayName: string;
  priceDisplay: string;
  inviteUrl: string;
  invitedByName: string;
  invitedByEmail: string;
  expiresAt: Date;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping membership invite email');
    return false;
  }

  const emailType: EmailType = 'membership_invite';
  const subject = `You're invited to join ${data.orgName} on AgenticAdvertising.org`;

  const escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const greeting = data.contactName ? `Hi ${escapeHtml(data.contactName)},` : 'Hi,';
  const safeOrg = escapeHtml(data.orgName);
  const safeTier = escapeHtml(data.tierDisplayName);
  const safePrice = escapeHtml(data.priceDisplay);
  const safeInviter = escapeHtml(data.invitedByName);
  const safeInviterEmail = escapeHtml(data.invitedByEmail);
  const expiresLocal = data.expiresAt.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  try {
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      metadata: {
        orgName: data.orgName,
        tierDisplayName: data.tierDisplayName,
        invitedByEmail: data.invitedByEmail,
      },
    });

    const trackingId = emailEvent.tracking_id;
    const trackedInviteUrl = trackedUrl(trackingId, 'cta_accept_invite', data.inviteUrl);
    // Transactional email: no unsubscribe (this is a one-off invite).
    const footerHtml = generateFooterHtml(trackingId, null);
    const footerText = generateFooterText(null);

    const { data: sendData, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: data.to,
      replyTo: data.invitedByEmail,
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
    <h1 style="color: #1a1a1a; font-size: 24px; margin: 0;">Membership Invitation</h1>
  </div>

  <p>${greeting}</p>

  <p><strong>${safeInviter}</strong> from AgenticAdvertising.org has invited <strong>${safeOrg}</strong> to become a member.</p>

  <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 24px 0;">
    <div style="font-size: 13px; color: #666; margin-bottom: 4px;">Tier</div>
    <div style="font-size: 18px; font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">${safeTier}</div>
    <div style="font-size: 13px; color: #666; margin-bottom: 4px;">Annual membership</div>
    <div style="font-size: 16px; color: #1a1a1a;">${safePrice}</div>
  </div>

  <p>Accepting the invitation walks you through:</p>
  <ol style="padding-left: 20px;">
    <li>Sign in (or create your account)</li>
    <li>Review and sign the membership agreement</li>
    <li>Confirm your billing address</li>
    <li>Receive your invoice for payment</li>
  </ol>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${trackedInviteUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">Accept Invitation</a>
  </p>

  <p style="font-size: 13px; color: #666;">This invitation expires on ${escapeHtml(expiresLocal)}. If you have questions, reply to this email — it goes straight to ${safeInviterEmail}.</p>

  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
Membership Invitation — AgenticAdvertising.org

${data.contactName ? `Hi ${data.contactName},` : 'Hi,'}

${data.invitedByName} from AgenticAdvertising.org has invited ${data.orgName} to become a member.

Tier: ${data.tierDisplayName}
Annual membership: ${data.priceDisplay}

Accept the invitation to sign in, review the membership agreement, confirm your billing address, and receive your invoice:

${data.inviteUrl}

This invitation expires on ${expiresLocal}. Questions? Reply to this email — it goes to ${data.invitedByEmail}.

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to }, 'Failed to send membership invite email');
      return false;
    }

    if (sendData?.id) {
      await emailDb.markEmailSent(trackingId, sendData.id);
    }

    logger.info({ to: data.to, orgName: data.orgName, trackingId }, 'Membership invite sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending membership invite email');
    return false;
  }
}

/**
 * Notify the customer when our webhook-side dedup helper canceled a duplicate
 * subscription on their account. Two scenarios:
 *
 *   - canceled_new: customer's just-completed intake was the duplicate; their
 *     existing membership continues. Most common — this is the Triton-shape.
 *   - canceled_existing: customer paid for a new sub; we voided an unpaid old
 *     sub from a prior intake (e.g., an admin invite they ignored). Their new
 *     sub is now active.
 *
 * Refunds aren't typical here because the dedup helper only auto-cancels
 * UNPAID subs (per the cancel-unpaid policy). The `wasPaid` flag is wired
 * defensively in case future policy changes cancel paid subs — copy adapts.
 */
export async function sendDuplicateSubscriptionNotice(data: {
  to: string;
  organizationName: string;
  /** 'canceled_new' = duplicate intake voided; 'canceled_existing' = old sub voided in favor of new. */
  scenario: 'canceled_new' | 'canceled_existing';
  /** Tier label of the surviving sub (the one the customer keeps), if known. */
  survivingTierLabel: string | null;
  /** True iff the canceled sub had been paid — affects refund copy. */
  canceledSubWasPaid: boolean;
  workosUserId?: string;
  workosOrganizationId?: string;
}): Promise<boolean> {
  if (!resend) {
    logger.debug('Resend not configured, skipping duplicate-subscription notice');
    return false;
  }

  const emailType: EmailType = 'duplicate_subscription_notice';
  const subject = 'We resolved a duplicate subscription on your account';

  const escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const safeOrgName = escapeHtml(data.organizationName);
  const safeTier = data.survivingTierLabel ? escapeHtml(data.survivingTierLabel) : null;

  const explanation =
    data.scenario === 'canceled_new'
      ? `We noticed your account at <strong>${safeOrgName}</strong> already had an active membership when a new subscription was created — likely a duplicate intake. We've canceled the duplicate so you're not on two subscriptions at once.`
      : `Your new membership at <strong>${safeOrgName}</strong> is now active. We've also voided an older subscription on your account from a prior intake that hadn't been paid, so you're cleanly on the new one.`;

  const survivingLine = safeTier
    ? `<p>Your active membership: <strong>${safeTier}</strong>.</p>`
    : '';

  const refundLine = data.canceledSubWasPaid
    ? `<p>Any charges on the canceled subscription will be refunded to your original payment method within 5–10 business days.</p>`
    : `<p>No charges occurred on the canceled subscription.</p>`;

  const explanationText =
    data.scenario === 'canceled_new'
      ? `We noticed your account at ${data.organizationName} already had an active membership when a new subscription was created — likely a duplicate intake. We've canceled the duplicate so you're not on two subscriptions at once.`
      : `Your new membership at ${data.organizationName} is now active. We've also voided an older subscription on your account from a prior intake that hadn't been paid, so you're cleanly on the new one.`;

  const survivingTextLine = data.survivingTierLabel
    ? `\nYour active membership: ${data.survivingTierLabel}.\n`
    : '';

  const refundTextLine = data.canceledSubWasPaid
    ? '\nAny charges on the canceled subscription will be refunded to your original payment method within 5–10 business days.\n'
    : '\nNo charges occurred on the canceled subscription.\n';

  try {
    const emailEvent = await emailDb.createEmailEvent({
      email_type: emailType,
      recipient_email: data.to,
      subject,
      workos_user_id: data.workosUserId,
      workos_organization_id: data.workosOrganizationId,
      metadata: {
        scenario: data.scenario,
        canceledSubWasPaid: data.canceledSubWasPaid,
        survivingTierLabel: data.survivingTierLabel,
      },
    });

    const trackingId = emailEvent.tracking_id;
    const footerHtml = generateFooterHtml(trackingId, null);
    const footerText = generateFooterText(null);

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
    <h1 style="color: #1a1a1a; font-size: 22px; margin: 0;">A quick heads-up about your subscription</h1>
  </div>

  <p>Hi,</p>

  <p>${explanation}</p>

  ${survivingLine}

  ${refundLine}

  <p>If this looks wrong — for example, you intended to upgrade or change tiers — just reply to this email or write to <a href="mailto:finance@agenticadvertising.org">finance@agenticadvertising.org</a> and we'll sort it out.</p>

  <p>— The AgenticAdvertising.org Team</p>

  ${footerHtml}
</body>
</html>
      `.trim(),
      text: `
A quick heads-up about your subscription — AgenticAdvertising.org

Hi,

${explanationText}
${survivingTextLine}${refundTextLine}
If this looks wrong — for example, you intended to upgrade or change tiers — just reply to this email or write to finance@agenticadvertising.org and we'll sort it out.

— The AgenticAdvertising.org Team

${footerText}
      `.trim(),
    });

    if (error) {
      logger.error({ error, to: data.to }, 'Failed to send duplicate-subscription notice');
      return false;
    }

    if (sendData?.id) {
      await emailDb.markEmailSent(trackingId, sendData.id);
    }

    logger.info(
      { to: data.to, scenario: data.scenario, trackingId },
      'Duplicate-subscription notice sent',
    );
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Error sending duplicate-subscription notice');
    return false;
  }
}
