/**
 * Invite expiry sweep — emits invite_expired person_events for membership
 * invites whose expires_at has passed and that were never accepted or revoked.
 *
 * Run hourly. Idempotent via the partial unique index on
 * person_events (event_type, data->>'invite_id') from migration 458, so
 * overlapping runs and crashed-mid-batch retries are safe.
 *
 * occurred_at is set to the invite's expires_at (logical truth — the moment
 * the state actually became "expired"), not the wall clock when the sweep
 * detected it. data.detected_at carries the wall-clock time for ops
 * dashboards that need to track sweep latency.
 */

import { query } from '../../db/client.js';
import { resolvePersonId } from '../../db/relationship-db.js';
import { recordInviteEvent } from '../../db/person-events-db.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('invite-expiry-sweep');

const log = logger.child({ module: 'invite-expiry-sweep' });

interface ExpiredInviteRow {
  id: string;
  token: string;
  workos_organization_id: string;
  lookup_key: string;
  contact_email: string;
  expires_at: Date;
}

export interface InviteExpirySweepResult {
  candidates: number;
  emitted: number;
  resolveFailures: number;
  recordFailures: number;
}

export async function runInviteExpirySweep(): Promise<InviteExpirySweepResult> {
  const detectedAt = new Date();

  const result = await query<ExpiredInviteRow>(
    `SELECT mi.id, mi.token, mi.workos_organization_id, mi.lookup_key,
            mi.contact_email, mi.expires_at
     FROM membership_invites mi
     WHERE mi.expires_at < NOW()
       AND mi.accepted_at IS NULL
       AND mi.revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM person_events pe
         WHERE pe.event_type = 'invite_expired'
           AND pe.data->>'invite_id' = mi.id::text
       )
     ORDER BY mi.expires_at ASC
     LIMIT 500`
  );

  const candidates = result.rows.length;
  if (candidates === 0) {
    log.debug('Invite expiry sweep ran, no candidates');
    return { candidates: 0, emitted: 0, resolveFailures: 0, recordFailures: 0 };
  }

  let emitted = 0;
  let resolveFailures = 0;
  let recordFailures = 0;

  for (const row of result.rows) {
    let personId: string;
    try {
      personId = await resolvePersonId({ email: row.contact_email });
    } catch (err) {
      resolveFailures += 1;
      log.warn(
        {
          err,
          inviteId: row.id,
          orgId: row.workos_organization_id,
          contactEmail: row.contact_email,
        },
        'Failed to resolve person for expired invite — will retry on next sweep'
      );
      continue;
    }

    try {
      await recordInviteEvent(personId, 'invite_expired', row.id, {
        occurredAt: row.expires_at,
        data: {
          token_prefix: row.token.slice(0, 8),
          org_id: row.workos_organization_id,
          lookup_key: row.lookup_key,
          expired_at: row.expires_at.toISOString(),
          detected_at: detectedAt.toISOString(),
        },
      });
      emitted += 1;
    } catch (err) {
      recordFailures += 1;
      log.warn(
        {
          err,
          inviteId: row.id,
          orgId: row.workos_organization_id,
        },
        'Failed to write invite_expired event — will retry on next sweep'
      );
    }
  }

  if (emitted > 0 || resolveFailures > 0 || recordFailures > 0) {
    log.info(
      { candidates, emitted, resolveFailures, recordFailures },
      'Invite expiry sweep completed'
    );
  }

  return { candidates, emitted, resolveFailures, recordFailures };
}
