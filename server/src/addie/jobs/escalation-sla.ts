/**
 * Escalation SLA enforcement.
 *
 * The admin dashboard can show overdue tickets, but visibility alone does not
 * close the loop. This job re-surfaces overdue active escalations to the
 * configured private escalation Slack channel, and writes a requester-visible
 * update after 24 hours so the requester can see that the request is still
 * open and has an alternate contact path.
 */

import { createLogger } from '../../logger.js';
import { getClient } from '../../db/client.js';
import {
  addSystemEscalationUpdate,
  describeEscalationSla,
  listEscalationsForSlaEnforcement,
  markEscalationSlaNotified,
  type Escalation,
} from '../../db/escalation-db.js';
import { getEscalationChannel } from '../../db/system-settings-db.js';
import { sendChannelMessage, sendDirectMessage } from '../../slack/client.js';

const logger = createLogger('escalation-sla');

const SUPPORT_EMAIL = 'support@agenticadvertising.org';

/**
 * Session-scoped advisory lock key for the SLA job. Prevents multi-process
 * deploys or overlapping scheduler ticks from selecting the same due
 * escalations and posting duplicate Slack follow-ups.
 */
const SLA_JOB_LOCK_ID = 8136735768681787317n;

export interface EscalationSlaJobOptions {
  limit?: number;
  now?: Date;
}

export interface EscalationSlaJobResult {
  scanned: number;
  admin_alerted: number;
  requester_updated: number;
  requester_dm_sent: number;
  skipped_no_channel: number;
  errors: number;
  locked_out?: boolean;
}

function hoursBetween(start: Date | string | null | undefined, end: Date): number {
  if (!start) return 0;
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, (end.getTime() - startMs) / (60 * 60 * 1000));
}

function isAdminAlertDue(escalation: Escalation, now: Date): boolean {
  const sla = describeEscalationSla(escalation, now);
  if (!sla.needs_follow_up) return false;
  if (!escalation.sla_admin_last_notified_at) return true;
  return hoursBetween(escalation.sla_admin_last_notified_at, now) >= 4;
}

function isRequesterUpdateDue(escalation: Escalation, now: Date): boolean {
  if (hoursBetween(escalation.created_at, now) < 24) return false;
  if (!escalation.sla_requester_last_notified_at) return true;
  return hoursBetween(escalation.sla_requester_last_notified_at, now) >= 24;
}

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const remainder = Math.round(hours % 24);
  return remainder > 0 ? `${days}d ${remainder}h` : `${days}d`;
}

function adminAlertText(escalation: Escalation, now: Date): string {
  const sla = describeEscalationSla(escalation, now);
  const lines = [
    `:rotating_light: *Escalation SLA follow-up needed: #${escalation.id}*`,
    '',
    `*Priority:* ${escalation.priority}`,
    `*Status:* ${escalation.status}`,
    `*Age:* ${formatAge(sla.age_hours)}${sla.label ? ` (${sla.label})` : ''}`,
    `*Requester:* ${escalation.user_display_name || escalation.user_email || escalation.user_slack_handle || escalation.workos_user_id || escalation.slack_user_id || 'Unknown'}`,
    '',
    `*Summary:* ${escalation.summary}`,
    '',
    `<https://agenticadvertising.org/admin/escalations|Open escalation dashboard>`,
  ];
  if (escalation.thread_id) {
    lines.push(`<https://agenticadvertising.org/admin/addie?thread=${escalation.thread_id}|View Addie thread>`);
  }
  return lines.join('\n');
}

function requesterUpdateText(escalation: Escalation): string {
  return [
    'This support request is still open, and we re-surfaced it to the AgenticAdvertising.org team.',
    `If this is blocking you, email ${SUPPORT_EMAIL} and include support request #${escalation.id}.`,
    'You can also add details or close the request from your dashboard.',
  ].join(' ');
}

export async function runEscalationSlaJob(
  options: EscalationSlaJobOptions = {},
): Promise<EscalationSlaJobResult> {
  const result: EscalationSlaJobResult = {
    scanned: 0,
    admin_alerted: 0,
    requester_updated: 0,
    requester_dm_sent: 0,
    skipped_no_channel: 0,
    errors: 0,
  };

  const client = await getClient();
  let haveLock = false;
  try {
    const lockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock',
      [SLA_JOB_LOCK_ID.toString()],
    );
    haveLock = lockRes.rows[0]?.pg_try_advisory_lock === true;
    if (!haveLock) {
      logger.warn('escalation-sla: another run is already holding the advisory lock - refusing');
      result.locked_out = true;
      return result;
    }

    const now = options.now ?? new Date();
    const rows = await listEscalationsForSlaEnforcement(options.limit ?? 50);
    const channel = await getEscalationChannel();
    result.scanned = rows.length;

    for (const escalation of rows) {
      const adminDue = isAdminAlertDue(escalation, now);
      const requesterDue = isRequesterUpdateDue(escalation, now);
      let adminNotified = false;
      let requesterNotified = false;

      if (adminDue) {
        if (!channel.channel_id) {
          result.skipped_no_channel += 1;
        } else {
          try {
            const threadTs = escalation.notification_channel_id === channel.channel_id
              ? escalation.notification_message_ts || undefined
              : undefined;
            const sent = await sendChannelMessage(
              channel.channel_id,
              {
                text: adminAlertText(escalation, now),
                thread_ts: threadTs,
              },
              { requirePrivate: true },
            );
            if (sent.ok) {
              adminNotified = true;
              result.admin_alerted += 1;
            } else {
              result.errors += 1;
              logger.warn(
                { escalationId: escalation.id, channelId: channel.channel_id, error: sent.error },
                'Failed to send escalation SLA admin alert',
              );
            }
          } catch (err) {
            result.errors += 1;
            logger.warn({ err, escalationId: escalation.id }, 'Escalation SLA admin alert threw');
          }
        }
      }

      if (requesterDue) {
        const body = requesterUpdateText(escalation);
        try {
          const update = await addSystemEscalationUpdate(escalation.id, body, true);
          if (update) {
            requesterNotified = true;
            result.requester_updated += 1;
          }
          if (escalation.slack_user_id) {
            const dm = await sendDirectMessage(escalation.slack_user_id, { text: body });
            if (dm.ok) result.requester_dm_sent += 1;
          }
        } catch (err) {
          result.errors += 1;
          logger.warn({ err, escalationId: escalation.id }, 'Failed to write requester SLA update');
        }
      }

      if (adminNotified || requesterNotified) {
        await markEscalationSlaNotified(escalation.id, {
          admin: adminNotified,
          requester: requesterNotified,
        });
      }
    }

    if (
      result.admin_alerted > 0 ||
      result.requester_updated > 0 ||
      result.skipped_no_channel > 0 ||
      result.errors > 0
    ) {
      logger.info(result, 'Escalation SLA job completed');
    }

    return result;
  } finally {
    let destroyClient = false;
    if (haveLock) {
      try {
        const unlockRes = await client.query<{ pg_advisory_unlock: boolean }>(
          'SELECT pg_advisory_unlock($1) AS pg_advisory_unlock',
          [SLA_JOB_LOCK_ID.toString()],
        );
        destroyClient = unlockRes.rows[0]?.pg_advisory_unlock !== true;
        if (destroyClient) {
          logger.warn('escalation-sla: advisory unlock returned false - destroying client');
        }
      } catch (err) {
        destroyClient = true;
        logger.warn({ err }, 'escalation-sla: failed to release advisory lock - destroying client');
      }
    }
    client.release(destroyClient);
  }
}
