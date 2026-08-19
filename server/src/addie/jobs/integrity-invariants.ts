/**
 * Scheduled run of the integrity-invariants framework. The on-demand admin
 * route at /api/admin/integrity/check has been there since Phase 1; this
 * job is Phase 2 — it runs ALL_INVARIANTS on a cadence and posts a single
 * Slack alert per run when any critical violation is found. Without this,
 * problems like "org references a non-existent Stripe customer" surface
 * only when a user happens to load the billing page.
 *
 * One alert per run, listing all critical violations grouped by invariant.
 * The error-notifier's per-source 5-minute throttle keeps a misbehaving
 * environment from spamming the channel.
 */

import {
  runAllInvariants,
  ALL_INVARIANTS,
  type InvariantContext,
  type Violation,
} from '../../audit/integrity/index.js';
import { detectEnvMismatch } from '../../audit/integrity/env-mismatch.js';
import { getPool } from '../../db/client.js';
import { stripe } from '../../billing/stripe-client.js';
import { getWorkos } from '../../auth/workos-client.js';
import {
  claimEscalationNotification,
  createEscalation,
  markNotificationSent,
  releaseEscalationNotificationClaim,
  type Escalation,
} from '../../db/escalation-db.js';
import { getEscalationChannel } from '../../db/system-settings-db.js';
import { createLogger } from '../../logger.js';
import { sendChannelMessage } from '../../slack/client.js';
import { notifySystemError } from '../error-notifier.js';

const logger = createLogger('integrity-invariants-job');

export interface IntegrityInvariantsJobResult {
  ran: boolean;
  skippedReason?: string;
  totalViolations: number;
  criticalViolations: number;
  warningViolations: number;
  durableEscalations: number;
  escalationNotifications: number;
  escalationErrors: number;
  durationMs: number;
}

function skippedResult(skippedReason: string): IntegrityInvariantsJobResult {
  notifySystemError({
    source: 'integrity-invariants',
    errorMessage: `Integrity invariants skipped: ${skippedReason}`,
  });

  return {
    ran: false,
    skippedReason,
    totalViolations: 0,
    criticalViolations: 0,
    warningViolations: 0,
    durableEscalations: 0,
    escalationNotifications: 0,
    escalationErrors: 0,
    durationMs: 0,
  };
}

const STRIPE_REFLECTION_INVARIANT = 'stripe-sub-reflected-in-org-row';

function isStripeReflectionBlocker(
  violation: Violation,
): boolean {
  return violation.invariant === STRIPE_REFLECTION_INVARIANT
    && violation.severity === 'critical'
    && violation.subject_type === 'organization';
}

function stripeReflectionEscalationText(
  escalation: Escalation,
  organizationId: string,
): string {
  const encodedOrganizationId = encodeURIComponent(organizationId);
  return [
    `:rotating_light: *Member organization billing sync needs action: escalation #${escalation.id}*`,
    '',
    'Stripe has an entitled membership subscription that is not fully reflected in the organization row.',
    `*Organization:* \`${organizationId.replace(/[`<>&]/g, '')}\``,
    '*Action:* Open the account, run “Sync from Stripe,” and verify the membership tier before resolving this escalation.',
    '',
    `<https://agenticadvertising.org/admin/accounts/${encodedOrganizationId}|Open account>`,
    '<https://agenticadvertising.org/admin/escalations|Open escalation dashboard>',
  ].join('\n');
}

async function ensureStripeReflectionEscalation(
  violation: Violation,
): Promise<{ ensured: boolean; notified: boolean; error: boolean }> {
  let escalation: Escalation;
  try {
    escalation = await createEscalation({
      category: 'needs_human_action',
      priority: 'urgent',
      summary: `Member organization billing state is not synchronized for organization ${violation.subject_id}`,
      addie_context: [
        violation.message,
        violation.remediation_hint ??
          `Run POST /api/admin/accounts/${violation.subject_id}/sync and verify the resolved membership tier.`,
      ].join('\n\n'),
      dedup_key: `integrity:${STRIPE_REFLECTION_INVARIANT}:${violation.subject_id}`,
    });
  } catch (err) {
    logger.error(
      { err, organizationId: violation.subject_id },
      'Failed to persist Stripe reflection escalation',
    );
    return { ensured: false, notified: false, error: true };
  }

  // A prior run already routed this active escalation. In-flight claims are
  // checked atomically below so stale claims can recover after a worker crash.
  if (escalation.notification_sent_at || escalation.notification_message_ts) {
    return { ensured: true, notified: false, error: false };
  }

  try {
    const claimed = await claimEscalationNotification(escalation.id);
    if (!claimed) {
      return { ensured: true, notified: false, error: false };
    }
  } catch (err) {
    logger.error(
      { err, escalationId: escalation.id, organizationId: violation.subject_id },
      'Failed to claim Stripe reflection escalation notification',
    );
    return { ensured: true, notified: false, error: true };
  }

  try {
    const channel = await getEscalationChannel();
    if (!channel.channel_id) {
      await releaseEscalationNotificationClaim(escalation.id);
      logger.warn(
        { escalationId: escalation.id, organizationId: violation.subject_id },
        'Stripe reflection escalation persisted but no escalation channel is configured',
      );
      return { ensured: true, notified: false, error: false };
    }

    const sent = await sendChannelMessage(
      channel.channel_id,
      { text: stripeReflectionEscalationText(escalation, violation.subject_id) },
      { requirePrivate: true },
    );
    if (!sent.ok || !sent.ts) {
      await releaseEscalationNotificationClaim(escalation.id);
      logger.warn(
        {
          escalationId: escalation.id,
          organizationId: violation.subject_id,
          channelId: channel.channel_id,
          error: sent.error,
        },
        'Failed to route Stripe reflection escalation to Slack',
      );
      return { ensured: true, notified: false, error: true };
    }

    try {
      await markNotificationSent(escalation.id, channel.channel_id, sent.ts);
      return { ensured: true, notified: true, error: false };
    } catch (err) {
      // Keep the short-lived claim: Slack accepted the message, so an
      // immediate retry would duplicate the thread. If persistence remains
      // unavailable, the claim eventually expires and the durable escalation
      // plus SLA routing still prevent the member organization from vanishing.
      logger.error(
        { err, escalationId: escalation.id, organizationId: violation.subject_id },
        'Stripe reflection escalation reached Slack but its message timestamp was not recorded',
      );
      return { ensured: true, notified: true, error: true };
    }
  } catch (err) {
    try {
      await releaseEscalationNotificationClaim(escalation.id);
    } catch (releaseErr) {
      logger.error(
        { err: releaseErr, escalationId: escalation.id },
        'Failed to release Stripe reflection notification claim after routing failure',
      );
    }
    logger.error(
      { err, escalationId: escalation.id, organizationId: violation.subject_id },
      'Failed to route Stripe reflection escalation',
    );
    return { ensured: true, notified: false, error: true };
  }
}

export async function runIntegrityInvariantsJob(): Promise<IntegrityInvariantsJobResult> {
  const mismatch = detectEnvMismatch();
  if (mismatch) {
    logger.warn({ reason: mismatch }, 'Skipping integrity run due to environment mismatch');
    return skippedResult(mismatch);
  }
  if (!stripe) {
    return skippedResult('STRIPE_SECRET_KEY not set');
  }

  const ctx: InvariantContext = {
    pool: getPool(),
    stripe,
    workos: getWorkos(),
    logger,
  };

  const t0 = Date.now();
  const report = await runAllInvariants(ALL_INVARIANTS, ctx);
  const durationMs = Date.now() - t0;

  const critical = report.violations.filter((v) => v.severity === 'critical');
  const warning = report.violations.filter((v) => v.severity === 'warning');
  let durableEscalations = 0;
  let escalationNotifications = 0;
  let escalationErrors = 0;

  if (critical.length > 0) {
    // Group by invariant for a compact summary. The error-notifier truncates
    // at 500 chars so we cap the body explicitly.
    const byInvariant = new Map<string, number>();
    for (const v of critical) {
      byInvariant.set(v.invariant, (byInvariant.get(v.invariant) ?? 0) + 1);
    }
    const summary = Array.from(byInvariant.entries())
      .map(([name, count]) => `${name}: ${count}`)
      .join(', ');
    const sample = critical
      .slice(0, 3)
      .map((v) => `${v.invariant} → ${v.subject_type} ${v.subject_id}: ${v.message}`)
      .join('\n');
    notifySystemError({
      source: 'integrity-invariants',
      errorMessage: `${critical.length} critical violation(s) — ${summary}\n\n${sample}${critical.length > 3 ? `\n…and ${critical.length - 3} more` : ''}`,
    });
  }

  // Generic system-error posts are transient and can be lost in a busy
  // channel. A missed subscription webhook blocks a paying member, so also
  // create a durable, deduplicated escalation with urgent SLA handling.
  for (const violation of critical.filter(isStripeReflectionBlocker)) {
    const escalationResult = await ensureStripeReflectionEscalation(violation);
    if (escalationResult.ensured) durableEscalations += 1;
    if (escalationResult.notified) escalationNotifications += 1;
    if (escalationResult.error) escalationErrors += 1;
  }

  logger.info(
    {
      totalViolations: report.total_violations,
      bySeverity: report.violations_by_severity,
      durableEscalations,
      escalationNotifications,
      escalationErrors,
      durationMs,
    },
    'Integrity invariants run completed'
  );

  return {
    ran: true,
    totalViolations: report.total_violations,
    criticalViolations: critical.length,
    warningViolations: warning.length,
    durableEscalations,
    escalationNotifications,
    escalationErrors,
    durationMs,
  };
}
