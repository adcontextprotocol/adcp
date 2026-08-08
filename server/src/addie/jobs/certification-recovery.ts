/**
 * Certification recovery job.
 *
 * Repairs the common failure mode where an assessment attempt is already
 * marked passed but the module/credential reconciliation did not finish. If
 * the repair still cannot award the credential, file one deduplicated
 * escalation so admins have a queue item instead of a silent learner block.
 */

import { createLogger } from '../../logger.js';
import * as certDb from '../../db/certification-db.js';
import {
  createEscalation,
  markNotificationSent,
  type Escalation,
} from '../../db/escalation-db.js';
import { getEscalationChannel } from '../../db/system-settings-db.js';
import { sendChannelMessage } from '../../slack/client.js';

const logger = createLogger('certification-recovery');

export interface CertificationRecoveryJobOptions {
  limit?: number;
}

export interface CertificationRecoveryJobResult {
  scanned: number;
  repaired: number;
  escalated: number;
  notified: number;
  skipped_no_channel: number;
  errors: number;
}

function extractNumericScores(scores: Record<string, unknown> | null): Record<string, number> | null {
  if (!scores || Array.isArray(scores) || typeof scores !== 'object') return null;
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(scores)) {
    if (key.startsWith('_')) continue;
    if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value;
  }
  return Object.keys(numeric).length > 0 ? numeric : null;
}

function certificationEscalationText(escalation: Escalation, attemptId: string, moduleId: string): string {
  return [
    `:warning: *Certification recovery needed: escalation #${escalation.id}*`,
    '',
    `A passed certification attempt could not be reconciled automatically.`,
    `*Attempt:* \`${attemptId}\``,
    `*Module:* \`${moduleId}\``,
    `*Learner:* \`${escalation.workos_user_id || 'unknown'}\``,
    '',
    `<https://agenticadvertising.org/admin/certification?user=${encodeURIComponent(escalation.workos_user_id || '')}&module=${encodeURIComponent(moduleId)}|Open certification admin>`,
  ].join('\n');
}

async function notifyEscalation(escalation: Escalation, attemptId: string, moduleId: string): Promise<boolean | 'no_channel'> {
  if (escalation.notification_message_ts) return false;

  const channel = await getEscalationChannel();
  if (!channel.channel_id) return 'no_channel';

  const sent = await sendChannelMessage(
    channel.channel_id,
    { text: certificationEscalationText(escalation, attemptId, moduleId) },
    { requirePrivate: true },
  );
  if (sent.ok && sent.ts) {
    await markNotificationSent(escalation.id, channel.channel_id, sent.ts);
    return true;
  }
  logger.warn(
    { escalationId: escalation.id, channelId: channel.channel_id, error: sent.error },
    'Failed to send certification recovery escalation notification',
  );
  return false;
}

export async function runCertificationRecoveryJob(
  options: CertificationRecoveryJobOptions = {},
): Promise<CertificationRecoveryJobResult> {
  const stuck = await certDb.getStuckAttempts(7);
  const candidates = stuck
    .filter(a => a.status === 'passed' && a.module_id)
    .slice(0, options.limit ?? 25);

  const result: CertificationRecoveryJobResult = {
    scanned: candidates.length,
    repaired: 0,
    escalated: 0,
    notified: 0,
    skipped_no_channel: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    const moduleId = candidate.module_id;
    if (!moduleId) continue;

    try {
      const attempt = await certDb.getAttempt(candidate.id);
      if (!attempt || attempt.status !== 'passed' || attempt.passing !== true) continue;

      const scores = extractNumericScores(attempt.scores);
      if (!scores) {
        throw new Error('Passed attempt has no numeric scores to reconcile');
      }

      await certDb.reconcilePassedAttemptModule(attempt, moduleId, scores);
      const awarded = await certDb.checkAndAwardCredentials(attempt.workos_user_id);
      if (awarded.length > 0) {
        result.repaired += 1;
        continue;
      }

      const stillEligibleButMissing = await certDb.hasEligibleMissingCredentialForModule(
        attempt.workos_user_id,
        moduleId,
      );
      if (!stillEligibleButMissing) continue;

      const escalation = await createEscalation({
        workos_user_id: attempt.workos_user_id,
        user_display_name: candidate.name,
        user_email: candidate.email,
        category: 'needs_human_action',
        priority: 'high',
        summary: `Certification attempt ${candidate.id} passed but no credential was awarded`,
        addie_context: [
          `Certification recovery tried to reconcile module ${moduleId} and re-run credential awarding, but no credential was awarded.`,
          `Use the certification admin repair panel or backfill badges runbook.`,
        ].join(' '),
        dedup_key: `certification-recovery:${candidate.id}`,
      });
      result.escalated += 1;

      const notified = await notifyEscalation(escalation, candidate.id, moduleId);
      if (notified === true) result.notified += 1;
      if (notified === 'no_channel') result.skipped_no_channel += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn(
        { err, attemptId: candidate.id, moduleId },
        'Certification recovery candidate failed',
      );
    }
  }

  if (
    result.repaired > 0 ||
    result.escalated > 0 ||
    result.skipped_no_channel > 0 ||
    result.errors > 0
  ) {
    logger.info(result, 'Certification recovery job completed');
  }

  return result;
}
