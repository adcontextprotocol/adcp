/**
 * Slack middleware
 *
 * Reusable middleware for handling Slack webhook requests.
 * Provides raw body capture and signature verification.
 */

import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifySlackSignature } from '../slack/verify.js';
import { createLogger } from '../logger.js';

const logger = createLogger('slack-middleware');

/**
 * Express middleware options for capturing raw body (JSON)
 * Use with express.json() for Slack Events API
 */
export const slackJsonOptions = {
  verify: (req: Request, _res: Response, buf: Buffer) => {
    (req as any).rawBody = buf.toString('utf8');
  },
};

/**
 * Express middleware options for capturing raw body (URL-encoded)
 * Use with express.urlencoded() for Slack slash commands
 */
export const slackUrlencodedOptions = {
  extended: true,
  verify: (req: Request, _res: Response, buf: Buffer) => {
    (req as any).rawBody = buf.toString('utf8');
  },
};

/**
 * Middleware factory to verify Slack request signatures
 *
 * @param signingSecret The Slack signing secret to use for verification
 * @param appName Name of the Slack app (for logging)
 * @returns Express middleware that verifies signatures
 */
export function createSlackSignatureVerifier(
  signingSecret: string | undefined,
  appName: string = 'Slack'
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!signingSecret) {
      logger.warn(`${appName}: Signing secret not configured, skipping verification`);
      next();
      return;
    }

    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;

    if (!signature || !timestamp) {
      logger.warn(`${appName}: Missing signature headers`);
      res.status(401).json({ error: 'Missing signature headers' });
      return;
    }

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      logger.warn(`${appName}: Raw body not captured for signature verification`);
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    const isValid = verifySlackSignature(
      signingSecret,
      signature,
      timestamp,
      rawBody
    );

    if (!isValid) {
      logger.warn(`${appName}: Invalid signature`);
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    next();
  };
}

/**
 * Middleware to handle Slack URL verification challenge
 * Returns true if this was a URL verification request (and response was sent)
 * Returns false if this is a normal event that should continue processing
 */
export function handleUrlVerification(req: Request, res: Response): boolean {
  if (req.body?.type === 'url_verification') {
    res.json({ challenge: req.body.challenge });
    return true;
  }
  return false;
}

/**
 * Combined middleware for Slack JSON endpoints (Events API)
 * Parses JSON body with raw body capture
 */
export function slackJsonParser(): RequestHandler {
  return express.json(slackJsonOptions);
}

/**
 * Combined middleware for Slack URL-encoded endpoints (slash commands)
 * Parses URL-encoded body with raw body capture
 */
export function slackUrlencodedParser(): RequestHandler {
  return express.urlencoded(slackUrlencodedOptions);
}
