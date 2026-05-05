/**
 * Billing notification service
 *
 * Sends billing-related notifications to the configured Slack channel via Addie.
 * Replaces the old webhook-based notifications with channel-based messaging.
 */

import { createLogger } from '../logger.js';
import { getBillingChannel } from '../db/system-settings-db.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlock, SlackTextObject } from '../slack/types.js';

const logger = createLogger('billing-notifications');

/**
 * Format currency amount from cents to dollars
 */
function formatAmount(cents: number, currency: string = 'usd'): string {
  const amount = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount);
}

/**
 * Mask email address to prevent PII exposure
 */
function maskEmail(email: string | null | undefined): string {
  if (!email) return '***';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const masked = local.charAt(0) + '***';
  return `${masked}@${domain}`;
}

/**
 * Strip Slack mrkdwn formatting chars and HTML-encode special chars so
 * untrusted user input (e.g. WorkOS firstName) can't inject markup or links
 * into a notification.
 */
function sanitizeMrkdwn(s: string): string {
  return s
    .replace(/[*_~`|]/g, '')
    .replace(/[<>&]/g, (c) =>
      c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'
    );
}

/**
 * Helper to create a header block
 */
function headerBlock(text: string): SlackBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true } as SlackTextObject,
  };
}

/**
 * Helper to create a section block with fields
 */
function sectionBlock(fields: Array<{ label: string; value: string }>): SlackBlock {
  return {
    type: 'section',
    fields: fields.map(f => ({
      type: 'mrkdwn' as const,
      text: `*${f.label}:*\n${f.value}`,
    })),
  };
}

/**
 * Send a billing notification to the configured channel
 * Returns true if sent successfully, false if channel not configured or send failed
 */
async function sendBillingNotification(
  text: string,
  blocks: SlackBlock[]
): Promise<boolean> {
  if (!isSlackConfigured()) {
    logger.debug('Slack not configured, skipping billing notification');
    return false;
  }

  const billingChannel = await getBillingChannel();
  if (!billingChannel.channel_id) {
    logger.debug('Billing channel not configured, skipping notification');
    return false;
  }

  try {
    const result = await sendChannelMessage(billingChannel.channel_id, { text, blocks }, { requirePrivate: true });
    if (result.ok) {
      logger.info({ channel: billingChannel.channel_name }, 'Billing notification sent');
      return true;
    } else {
      logger.warn({ error: result.error, channel: billingChannel.channel_id }, 'Failed to send billing notification');
      return false;
    }
  } catch (error) {
    logger.error({ error, channel: billingChannel.channel_id }, 'Error sending billing notification');
    return false;
  }
}

export type NewSubscriptionPaymentStatus =
  | 'paid'
  | 'invoice_sent_pending'
  | 'payment_failed'
  | 'payment_pending'
  | 'unknown';

/**
 * Notify when a new subscription is created. The amount field is the
 * post-discount amount actually being billed — show list price + discount
 * summary as a separate field when they differ. Status reflects whether
 * the first invoice has been collected yet.
 */
export async function notifyNewSubscription(data: {
  organizationName: string;
  customerEmail: string;
  productName?: string;
  amount?: number;
  /** Catalog list price, only set when different from `amount`. Drives "(was $X)". */
  listAmount?: number;
  /** Free-text discount line, e.g. "$5,000 referral discount" or "20% off". */
  discountSummary?: string;
  currency?: string;
  interval?: string;
  paymentStatus?: NewSubscriptionPaymentStatus;
  /** For send_invoice mode: days from invoice creation to due date. 0 = "due upon receipt". */
  invoiceTermsDays?: number;
}): Promise<boolean> {
  const intervalText = data.interval === 'year' ? '/year' : '/month';
  const amountText = data.amount
    ? formatAmount(data.amount, data.currency) + intervalText
    : 'Custom';

  const planText = formatPlanLine(data);
  const statusText = formatPaymentStatus(data.paymentStatus, data.invoiceTermsDays);

  const fields: Array<{ label: string; value: string }> = [
    { label: 'Organization', value: data.organizationName },
    { label: 'Email', value: maskEmail(data.customerEmail) },
    { label: 'Plan', value: planText },
    { label: 'Amount', value: amountText },
  ];
  if (statusText) {
    fields.push({ label: 'Status', value: statusText });
  }

  return sendBillingNotification(
    `New Member: ${data.organizationName}`,
    [headerBlock('New Member!'), sectionBlock(fields)],
  );
}

/**
 * Plan field — shows the product name plus list price + discount summary
 * when a discount was applied, so admins can see the framing at a glance.
 */
function formatPlanLine(data: {
  productName?: string;
  listAmount?: number;
  discountSummary?: string;
  currency?: string;
}): string {
  const base = data.productName || 'Membership';
  if (data.listAmount && data.discountSummary) {
    return `${base} (${formatAmount(data.listAmount, data.currency)} list, ${data.discountSummary})`;
  }
  if (data.discountSummary) {
    return `${base} (${data.discountSummary})`;
  }
  return base;
}

function formatPaymentStatus(
  status: NewSubscriptionPaymentStatus | undefined,
  termsDays: number | undefined,
): string | undefined {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'invoice_sent_pending': {
      const terms =
        termsDays === undefined
          ? 'awaiting payment'
          : termsDays === 0
            ? 'Net 0 — due upon receipt, not yet paid'
            : `Net ${termsDays}, not yet paid`;
      return `Invoice sent (${terms})`;
    }
    case 'payment_pending':
      return 'Charge pending — Stripe is processing the payment';
    case 'payment_failed':
      return 'Payment failed — admin action needed';
    case 'unknown':
    case undefined:
      return undefined;
  }
}

/**
 * Notify when a payment succeeds
 */
export async function notifyPaymentSucceeded(data: {
  organizationName: string;
  amount: number;
  currency: string;
  productName?: string;
  isRecurring: boolean;
}): Promise<boolean> {
  const paymentType = data.isRecurring ? 'Recurring Payment' : 'Payment';

  return sendBillingNotification(
    `${paymentType}: ${formatAmount(data.amount, data.currency)} from ${data.organizationName}`,
    [
      headerBlock(`${paymentType} Received`),
      sectionBlock([
        { label: 'Organization', value: data.organizationName },
        { label: 'Amount', value: formatAmount(data.amount, data.currency) },
        { label: 'Product', value: data.productName || 'Membership' },
        { label: 'Type', value: data.isRecurring ? 'Recurring' : 'Initial' },
      ]),
    ]
  );
}

/**
 * Notify when a payment fails
 */
export async function notifyPaymentFailed(data: {
  organizationName: string;
  amount: number;
  currency: string;
  attemptCount: number;
}): Promise<boolean> {
  return sendBillingNotification(
    `Payment Failed: ${data.organizationName} - ${formatAmount(data.amount, data.currency)}`,
    [
      headerBlock('Payment Failed'),
      sectionBlock([
        { label: 'Organization', value: data.organizationName },
        { label: 'Amount', value: formatAmount(data.amount, data.currency) },
        { label: 'Attempt', value: `#${data.attemptCount}` },
      ]),
    ]
  );
}

/**
 * Notify when a subscription is cancelled
 */
export async function notifySubscriptionCancelled(data: {
  organizationName: string;
  productName?: string;
}): Promise<boolean> {
  return sendBillingNotification(
    `Subscription Cancelled: ${data.organizationName}`,
    [
      headerBlock('Subscription Cancelled'),
      sectionBlock([
        { label: 'Organization', value: data.organizationName },
        { label: 'Plan', value: data.productName || 'Membership' },
      ]),
    ]
  );
}

/**
 * Notify when an invoice is sent
 */
export async function notifyInvoiceSent(data: {
  organizationName: string;
  contactEmail: string;
  contactName?: string;
  amount: number;
  currency: string;
  productName?: string;
  invoiceId?: string;
}): Promise<boolean> {
  const safeOrg = sanitizeMrkdwn(data.organizationName);
  const safeName = data.contactName ? sanitizeMrkdwn(data.contactName) : null;
  const requestedBy = safeName
    ? `${safeName} (${maskEmail(data.contactEmail)})`
    : maskEmail(data.contactEmail);

  const fields = [
    { label: 'Organization', value: safeOrg },
    { label: 'Requested By', value: requestedBy },
    { label: 'Amount', value: formatAmount(data.amount, data.currency) },
    { label: 'Product', value: data.productName || 'Membership' },
  ];
  if (data.invoiceId) {
    fields.push({ label: 'Invoice ID', value: data.invoiceId });
  }

  return sendBillingNotification(
    `Invoice Sent: ${formatAmount(data.amount, data.currency)} to ${safeOrg}`,
    [headerBlock('Invoice Sent'), sectionBlock(fields)]
  );
}

/**
 * Notify when a discount is applied
 */
export async function notifyDiscountApplied(data: {
  organizationName: string;
  discountCode: string;
  discountPercent: number;
  appliedBy: string;
}): Promise<boolean> {
  return sendBillingNotification(
    `Discount Applied: ${data.discountPercent}% off for ${data.organizationName}`,
    [
      headerBlock('Discount Applied'),
      sectionBlock([
        { label: 'Organization', value: data.organizationName },
        { label: 'Discount', value: `${data.discountPercent}% off` },
        { label: 'Code', value: data.discountCode },
        { label: 'Applied By', value: data.appliedBy },
      ]),
    ]
  );
}
