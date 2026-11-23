/**
 * Admin control of the training agent's reporting webhook subscribers.
 *
 * A subscriber that stops accepting deliveries keeps every reporting
 * notification on its account retrying until the SDK abandons it, and every new
 * notification starts again. The owning principal can turn a subscriber off
 * through `PUT /sales/reporting/notifications/:accountId`; these routes let an
 * administrator suspend and resume one without that principal's credential.
 * They stand in for a per-subscriber retry budget and circuit breaker in the SDK
 * (adcontextprotocol/adcp-client#3780).
 *
 * Every suspend and resume needs a `reason` and lands in `registry_audit_log`.
 * Responses and logs carry identifiers and the destination host only, never
 * the URL path, query or any credential.
 */

import { Router, type Request, type Response } from 'express';
import { AdcpError, NotificationSubscriptionValidationError } from '@adcp/sdk/server';
import { getPool } from '../../db/client.js';
import { createLogger } from '../../logger.js';
import { getStaticAdminAuditDetails, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { getTrainingGcsReporting } from '../../training-agent/gcs-reporting.js';

const logger = createLogger('admin-training-reporting');

const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
/** Audit rows for installation-wide actions that belong to no member organization. */
const AUDIT_ORGANIZATION = 'system_training_agent';

export function setupTrainingReportingRoutes(apiRouter: Router): void {
  // GET /api/admin/training-agent/reporting/subscribers
  apiRouter.get('/training-agent/reporting/subscribers', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const runtime = getTrainingGcsReporting();
      if (!runtime) return res.status(503).json({ error: 'reporting_disabled' });
      return res.json({ subscribers: await runtime.listNotificationSubscribers() });
    } catch (error) {
      return unavailable(res, error);
    }
  });

  // POST /api/admin/training-agent/reporting/subscribers/:accountId/:subscriberId/suspend
  apiRouter.post(
    '/training-agent/reporting/subscribers/:accountId/:subscriberId/suspend',
    requireAuth,
    requireAdmin,
    (req, res) => setActive(req, res, false),
  );

  // POST /api/admin/training-agent/reporting/subscribers/:accountId/:subscriberId/resume
  apiRouter.post(
    '/training-agent/reporting/subscribers/:accountId/:subscriberId/resume',
    requireAuth,
    requireAdmin,
    (req, res) => setActive(req, res, true),
  );
}

async function setActive(req: Request, res: Response, active: boolean) {
  const { accountId, subscriberId } = req.params;
  if (!ID_PATTERN.test(accountId) || !ID_PATTERN.test(subscriberId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < MIN_REASON_LENGTH) {
    return res.status(400).json({
      error: 'reason_required',
      message: `reason is required (min ${MIN_REASON_LENGTH} chars)`,
    });
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return res.status(400).json({ error: 'reason_too_long', message: `reason exceeds ${MAX_REASON_LENGTH} chars` });
  }

  let outcome;
  try {
    const runtime = getTrainingGcsReporting();
    if (!runtime) return res.status(503).json({ error: 'reporting_disabled' });
    outcome = await runtime.setNotificationSubscriberActive(accountId, subscriberId, active);
  } catch (error) {
    if (error instanceof NotificationSubscriptionValidationError) {
      // The whole set is revalidated on write, for example a destination whose
      // host no longer resolves. Only the owning principal can replace it.
      return res.status(422).json({
        error: 'subscription_set_invalid',
        message: 'The account\'s subscription set no longer validates; the owning principal must replace it.',
      });
    }
    return unavailable(res, error);
  }
  if (outcome === 'not_found') {
    return res.status(404).json({ error: 'subscriber_not_found' });
  }

  const action = active ? 'training_reporting_subscriber_resumed' : 'training_reporting_subscriber_suspended';
  const changed = outcome === 'applied';
  const at = new Date().toISOString();
  const record = { account_id: accountId, subscriber_id: subscriberId, active, changed, reason, at };
  logger.info({ adminUserId: req.user!.id, ...record }, active
    ? 'Training reporting subscriber resumed by an administrator'
    : 'Training reporting subscriber suspended by an administrator');
  try {
    await getPool().query(
      `INSERT INTO registry_audit_log
         (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'training_reporting_subscriber', $4, $5)`,
      [
        AUDIT_ORGANIZATION,
        req.user!.id,
        action,
        `${accountId}/${subscriberId}`,
        JSON.stringify({ ...record, admin_email: req.user!.email, ...getStaticAdminAuditDetails(req) }),
      ],
    );
  } catch (error) {
    // The change is applied and the log line above records it. A retry is an
    // idempotent no-op that records the audit row.
    logger.error({ err: error, adminUserId: req.user!.id, ...record }, 'Training reporting subscriber audit write failed');
    return res.status(500).json({
      error: 'audit_write_failed',
      message: 'The change was applied but its audit record was not written; retry to record it.',
      account_id: accountId,
      subscriber_id: subscriberId,
      active,
    });
  }
  return res.json({ account_id: accountId, subscriber_id: subscriberId, active, changed });
}

function unavailable(res: Response, error: unknown) {
  if (!(error instanceof AdcpError)) {
    logger.error({ err: error }, 'Training reporting subscriber administration failed');
  }
  return res.status(503).json({ error: 'reporting_unavailable' });
}
