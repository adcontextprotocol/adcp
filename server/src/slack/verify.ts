/**
 * Slack request verification
 *
 * Verifies that incoming requests are actually from Slack
 * using the signing secret.
 */

import crypto from 'crypto';
import { logger } from '../logger.js';

/**
 * Verify a Slack request signature
 *
 * @param signingSecret The Slack signing secret
 * @param requestSignature The X-Slack-Signature header
 * @param requestTimestamp The X-Slack-Request-Timestamp header
 * @param body The raw request body
 * @returns true if signature is valid
 */
export function verifySlackSignature(
  signingSecret: string,
  requestSignature: string,
  requestTimestamp: string,
  body: string
): boolean {
  // Check timestamp is recent (within 5 minutes)
  const timestamp = parseInt(requestTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 60 * 5) {
    logger.warn({ timestamp, now, diff: Math.abs(now - timestamp) }, 'Slack request timestamp too old');
    return false;
  }

  // Create signature base string
  const sigBasestring = `v0:${requestTimestamp}:${body}`;

  // Create HMAC signature
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  // Compare signatures using timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(requestSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Check if Addie Slack signing secret is configured
 */
export function isAddieSigningConfigured(): boolean {
  return Boolean(process.env.ADDIE_SIGNING_SECRET);
}
