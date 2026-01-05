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
    const result = await sendChannelMessage(billingChannel.channel_id, { text, blocks });
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

/**
 * Notify when a new subscription is created
 */
export async function notifyNewSubscription(data: {
  organizationName: string;
  customerEmail: string;
  productName?: string;
  amount?: number;
  currency?: string;
  interval?: string;
}): Promise<boolean> {
  const intervalText = data.interval === 'year' ? '/year' : '/month';
  const amountText = data.amount ? formatAmount(data.amount, data.currency) + intervalText : 'Custom';

  return sendBillingNotification(
    `New Member: ${data.organizationName}`,
    [
      headerBlock('New Member!'),
      sectionBlock([
        { label: 'Organization', value: data.organizationName },
        { label: 'Email', value: maskEmail(data.customerEmail) },
        { label: 'Plan', value: data.productName || 'Membership' },
        { label: 'Amount', value: amountText },
      ]),
    ]
  );
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
  amount: number;
  currency: string;
  productName?: string;
}): Promise<boolean> {
  return sendBillingNotification(
    `Invoice Sent: ${formatAmount(data.amount, data.currency)} to ${data.organizationName}`,
    [
      headerBlock('Invoice Sent'),
      sectionBlock([
        { label: 'Organization', value: data.organizationName },
        { label: 'Sent To', value: maskEmail(data.contactEmail) },
        { label: 'Amount', value: formatAmount(data.amount, data.currency) },
        { label: 'Product', value: data.productName || 'Membership' },
      ]),
    ]
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
