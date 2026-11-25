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

  const runtime = (() => {
    try { return getTrainingGcsReporting(); } catch { return null; }
  })();
  if (runtime === undefined) return res.status(503).json({ error: 'reporting_disabled' });
  if (runtime === null) return res.status(503).json({ error: 'reporting_unavailable' });

  // The intent is recorded, attributed, before anything changes, so no change
  // can exist without an audit row; the outcome row follows it.
  const verb = active ? 'resume' : 'suspend';
  const attribution = { admin_user_id: req.user!.id, ...getStaticAdminAuditDetails(req) };
  const request = { account_id: accountId, subscriber_id: subscriberId, active, reason, requested_at: new Date().toISOString() };
  const audit = (action: string, details: Record<string, unknown>) => getPool().query(
    `INSERT INTO registry_audit_log
       (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'training_reporting_subscriber', $4, $5)`,
    [AUDIT_ORGANIZATION, req.user!.id, action, `${accountId}/${subscriberId}`,
      JSON.stringify({ ...request, ...details, ...attribution, admin_email: req.user!.email })],
  );
  try {
    await audit(`training_reporting_subscriber_${verb}_requested`, {});
  } catch (error) {
    logger.error({ ...errorFacts(error), ...request, ...attribution }, 'Training reporting subscriber audit write failed; nothing was changed');
    return res.status(500).json({
      error: 'audit_write_failed',
      message: 'Nothing was changed: the audit record could not be written.',
    });
  }

  let outcome;
  try {
    outcome = await runtime.setNotificationSubscriberActive(accountId, subscriberId, active);
  } catch (error) {
    const refused = error instanceof NotificationSubscriptionValidationError;
    await recordOutcome(audit, `training_reporting_subscriber_${verb}_failed`,
      { outcome: refused ? 'subscription_set_invalid' : 'unavailable', ...errorFacts(error) }, request, attribution);
    if (refused) {
      // Resuming revalidates the whole set, for example a destination whose
      // host no longer resolves. Only the owning principal can replace it.
      return res.status(422).json({
        error: 'subscription_set_invalid',
        message: 'The account\'s subscription set no longer validates; the owning principal must replace it.',
      });
    }
    return unavailable(res, error);
  }
  if (outcome === 'not_found') {
    await recordOutcome(audit, `training_reporting_subscriber_${verb}_failed`, { outcome }, request, attribution);
    return res.status(404).json({ error: 'subscriber_not_found' });
  }

  const changed = outcome === 'applied';
  logger.info({ ...request, ...attribution, changed }, active
    ? 'Training reporting subscriber resumed by an administrator'
    : 'Training reporting subscriber suspended by an administrator');
  await recordOutcome(audit, active ? 'training_reporting_subscriber_resumed' : 'training_reporting_subscriber_suspended',
    { outcome, changed, completed_at: new Date().toISOString() }, request, attribution);
  return res.json({ account_id: accountId, subscriber_id: subscriberId, active, changed });
}

/** The intent row already attributes the action, so a lost outcome row is logged, not fatal. */
async function recordOutcome(
  audit: (action: string, details: Record<string, unknown>) => Promise<unknown>,
  action: string, details: Record<string, unknown>,
  request: Record<string, unknown>, attribution: Record<string, unknown>,
): Promise<void> {
  try {
    await audit(action, details);
  } catch (error) {
    logger.error({ ...errorFacts(error), action, ...details, ...request, ...attribution },
      'Training reporting subscriber outcome audit write failed; its intent row is recorded');
  }
}

/**
 * Allowlisted facts about a failure. Messages, stacks and causes can carry
 * destination URLs or backend values, so none of them is logged.
 */
function errorFacts(error: unknown): { error_name?: string; database_code?: string } {
  const facts: { error_name?: string; database_code?: string } = {};
  if (error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name)) facts.error_name = error.name;
  let cause = error;
  for (let depth = 0; depth < 8 && typeof cause === 'object' && cause !== null; depth++) {
    try {
      const code = Object.getOwnPropertyDescriptor(cause, 'code');
      if (code && 'value' in code && typeof code.value === 'string' && /^[0-9A-Z]{5}$/.test(code.value)) {
        facts.database_code = code.value;
        break;
      }
      const next = Object.getOwnPropertyDescriptor(cause, 'cause');
      cause = next && 'value' in next ? next.value : undefined;
    } catch { break; }
  }
  return facts;
}

function unavailable(res: Response, error: unknown) {
  if (!(error instanceof AdcpError)) {
    logger.error(errorFacts(error), 'Training reporting subscriber administration failed');
  }
  return res.status(503).json({ error: 'reporting_unavailable' });
}
