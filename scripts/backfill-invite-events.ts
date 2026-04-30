/**
 * One-shot backfill: walk membership_invites and write the corresponding
 * person_events rows using the original timestamps.
 *
 * Safe to re-run: skips any invite whose token_prefix already appears in
 * person_events for the matching person and event type.
 *
 * Usage:
 *   npx tsx scripts/backfill-invite-events.ts [--dry-run]
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function resolveOrCreatePerson(email: string, client: pg.PoolClient): Promise<string | null> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM person_relationships WHERE email = $1 LIMIT 1`,
    [email]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Create a website-only relationship — same as resolvePersonId({ email }) does.
  const created = await client.query<{ id: string }>(
    `INSERT INTO person_relationships (email, source)
     VALUES ($1, 'website')
     ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );
  return created.rows[0]?.id ?? null;
}

async function eventExists(
  personId: string,
  eventType: string,
  tokenPrefix: string,
  client: pg.PoolClient
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM person_events
     WHERE person_id = $1
       AND event_type = $2
       AND data->>'token_prefix' = $3
     LIMIT 1`,
    [personId, eventType, tokenPrefix]
  );
  return result.rows.length > 0;
}

async function main(): Promise<void> {
  console.log(`Starting invite event backfill${DRY_RUN ? ' (DRY RUN)' : ''}…`);

  const client = await pool.connect();
  try {
    const invites = await client.query<{
      token: string;
      contact_email: string;
      workos_organization_id: string;
      lookup_key: string;
      invited_by_user_id: string;
      created_at: Date;
      accepted_at: Date | null;
      accepted_by_user_id: string | null;
      invoice_id: string | null;
      revoked_at: Date | null;
      revoked_by_user_id: string | null;
      expires_at: Date;
    }>(`SELECT * FROM membership_invites ORDER BY created_at ASC`);

    console.log(`Found ${invites.rows.length} invites`);

    let written = 0;
    let skipped = 0;

    for (const inv of invites.rows) {
      const tokenPrefix = inv.token.slice(0, 8) + '...';
      const personId = DRY_RUN ? 'dry-run' : await resolveOrCreatePerson(inv.contact_email, client);
      if (!personId) {
        console.warn(`  SKIP ${tokenPrefix}: could not resolve person for ${inv.contact_email}`);
        skipped++;
        continue;
      }

      // invite_sent
      const sentExists = DRY_RUN ? false : await eventExists(personId, 'invite_sent', tokenPrefix, client);
      if (!sentExists) {
        if (!DRY_RUN) {
          await client.query(
            `INSERT INTO person_events (person_id, event_type, data, occurred_at)
             VALUES ($1, 'invite_sent', $2, $3)`,
            [
              personId,
              JSON.stringify({
                token_prefix: tokenPrefix,
                lookup_key: inv.lookup_key,
                expires_at: inv.expires_at,
                invited_by_user_id: inv.invited_by_user_id,
                org_id: inv.workos_organization_id,
              }),
              inv.created_at,
            ]
          );
        }
        console.log(`  WRITE invite_sent  ${tokenPrefix} ${inv.contact_email} @ ${inv.created_at.toISOString()}`);
        written++;
      } else {
        skipped++;
      }

      // invite_accepted
      if (inv.accepted_at && inv.accepted_by_user_id) {
        const acceptedExists = DRY_RUN ? false : await eventExists(personId, 'invite_accepted', tokenPrefix, client);
        if (!acceptedExists) {
          if (!DRY_RUN) {
            await client.query(
              `INSERT INTO person_events (person_id, event_type, data, occurred_at)
               VALUES ($1, 'invite_accepted', $2, $3)`,
              [
                personId,
                JSON.stringify({
                  token_prefix: tokenPrefix,
                  accepted_by_user_id: inv.accepted_by_user_id,
                  invoice_id: inv.invoice_id,
                  org_id: inv.workos_organization_id,
                }),
                inv.accepted_at,
              ]
            );
          }
          console.log(`  WRITE invite_accepted ${tokenPrefix} @ ${inv.accepted_at.toISOString()}`);
          written++;
        } else {
          skipped++;
        }
      }

      // invite_revoked
      if (inv.revoked_at && inv.revoked_by_user_id) {
        const revokedExists = DRY_RUN ? false : await eventExists(personId, 'invite_revoked', tokenPrefix, client);
        if (!revokedExists) {
          if (!DRY_RUN) {
            await client.query(
              `INSERT INTO person_events (person_id, event_type, data, occurred_at)
               VALUES ($1, 'invite_revoked', $2, $3)`,
              [
                personId,
                JSON.stringify({
                  token_prefix: tokenPrefix,
                  revoked_by_user_id: inv.revoked_by_user_id,
                  org_id: inv.workos_organization_id,
                }),
                inv.revoked_at,
              ]
            );
          }
          console.log(`  WRITE invite_revoked  ${tokenPrefix} @ ${inv.revoked_at.toISOString()}`);
          written++;
        } else {
          skipped++;
        }
      }

      // invite_expired (no accepted_at, no revoked_at, past expires_at)
      if (!inv.accepted_at && !inv.revoked_at && inv.expires_at < new Date()) {
        const expiredExists = DRY_RUN ? false : await eventExists(personId, 'invite_expired', tokenPrefix, client);
        if (!expiredExists) {
          if (!DRY_RUN) {
            await client.query(
              `INSERT INTO person_events (person_id, event_type, data, occurred_at)
               VALUES ($1, 'invite_expired', $2, $3)`,
              [
                personId,
                JSON.stringify({
                  token_prefix: tokenPrefix,
                  org_id: inv.workos_organization_id,
                }),
                inv.expires_at,
              ]
            );
          }
          console.log(`  WRITE invite_expired  ${tokenPrefix} @ ${inv.expires_at.toISOString()}`);
          written++;
        } else {
          skipped++;
        }
      }
    }

    console.log(`\nDone. written=${written} skipped=${skipped}${DRY_RUN ? ' (dry run — no writes)' : ''}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
