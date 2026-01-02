/**
 * Slack request verification
 *
 * Verifies that incoming requests are actually from Slack
 * using the signing secret.
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

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
 * Express middleware to verify Slack request signatures
 *
 * Requires express.raw() or express.text() middleware to be used
 * before this middleware to preserve the raw body.
 */
export function verifySlackRequest(req: Request, res: Response, next: NextFunction): void {
  if (!SLACK_SIGNING_SECRET) {
    logger.warn('SLACK_SIGNING_SECRET not configured, skipping verification');
    next();
    return;
  }

  const signature = req.headers['x-slack-signature'] as string;
  const timestamp = req.headers['x-slack-request-timestamp'] as string;

  if (!signature || !timestamp) {
    logger.warn('Missing Slack signature headers');
    res.status(401).json({ error: 'Missing signature headers' });
    return;
  }

  // Get raw body - express.json() parses it, so we need to reconstruct
  // For URL-encoded forms (slash commands), we need the raw body
  const rawBody = typeof req.body === 'string'
    ? req.body
    : JSON.stringify(req.body);

  const isValid = verifySlackSignature(
    SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    rawBody
  );

  if (!isValid) {
    logger.warn('Invalid Slack signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}

/**
 * Check if Slack signing secret is configured
 */
export function isSlackSigningConfigured(): boolean {
  return Boolean(SLACK_SIGNING_SECRET);
}

/**
 * Check if Addie Slack signing secret is configured
 */
export function isAddieSigningConfigured(): boolean {
  return Boolean(process.env.ADDIE_SIGNING_SECRET);
}
