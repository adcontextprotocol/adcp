/**
 * Periodic sweep that writes invite_expired person events for membership
 * invites that have passed their expiry date without being accepted or revoked.
 *
 * Idempotent: only writes an event for an invite if no invite_expired event
 * with the same token_prefix already exists on that person's timeline.
 */

import { createLogger } from '../logger.js';
import { query } from '../db/client.js';
import { resolvePersonId } from '../db/relationship-db.js';
import { recordEvent } from '../db/person-events-db.js';

const logger = createLogger('invite-expired-sweep');

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startInviteExpiredSweep(): void {
  if (intervalId) return;

  runSweep().catch((err) => logger.error({ err }, 'invite-expired sweep failed on startup'));

  intervalId = setInterval(() => {
    runSweep().catch((err) => logger.error({ err }, 'invite-expired sweep failed'));
  }, SWEEP_INTERVAL_MS);

  logger.info('invite-expired sweep started');
}

export function stopInviteExpiredSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function runSweep(): Promise<void> {
  // Find expired invites that don't yet have an invite_expired person event.
  // token_prefix (first 8 chars + '...') is the correlation key stored in data.
  // Idempotency guard checks person_events directly by (event_type, token_prefix)
  // rather than joining through person_relationships. That JOIN would break after
  // an identity merge: the loser row is deleted so the email lookup returns nothing,
  // causing the sweep to re-write a duplicate on every subsequent run.
  const result = await query<{
    token: string;
    contact_email: string;
    workos_organization_id: string;
    expires_at: Date;
  }>(
    `SELECT mi.token, mi.contact_email, mi.workos_organization_id, mi.expires_at
     FROM membership_invites mi
     WHERE mi.expires_at < NOW()
       AND mi.expires_at > NOW() - INTERVAL '365 days'
       AND mi.accepted_at IS NULL
       AND mi.revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM person_events pe2
         WHERE pe2.event_type = 'invite_expired'
           AND pe2.data->>'token_prefix' = LEFT(mi.token, 8) || '...'
       )
     ORDER BY mi.expires_at ASC
     LIMIT 500`,
    []
  );

  if (result.rows.length === 0) return;

  logger.info({ count: result.rows.length }, 'Writing invite_expired events');

  for (const row of result.rows) {
    try {
      const personId = await resolvePersonId({ email: row.contact_email });
      await recordEvent(personId, 'invite_expired', {
        data: {
          token_prefix: row.token.slice(0, 8) + '...',
          org_id: row.workos_organization_id,
        },
        occurredAt: row.expires_at,
      });
    } catch (err) {
      logger.warn(
        { err, tokenPrefix: row.token.slice(0, 8) + '...' },
        'Failed to write invite_expired event for one invite'
      );
    }
  }
}
