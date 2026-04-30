/**
 * Backfill person_events rows for existing membership_invites.
 *
 * Issue: github.com/adcontextprotocol/adcp/issues/3588
 *
 * For every row in membership_invites we emit:
 *   - invite_sent      at created_at
 *   - invite_accepted  at accepted_at        (if accepted)
 *   - invite_revoked   at revoked_at         (if revoked)
 *   - invite_expired   at expires_at         (if expired and not otherwise terminal)
 *
 * Idempotency comes from the partial unique index on
 * person_events (event_type, data->>'invite_id') from migration 458.
 * INSERT uses ON CONFLICT DO NOTHING via recordInviteEvent — safe to re-run.
 *
 * ## Pre-flight
 *
 * The script first counts distinct invite emails that have no existing
 * person_relationships row. Backfill will create one row per unique email
 * via resolvePersonId (project invariant: everyone is an account). Operator
 * must confirm with --yes before any writes happen.
 *
 * ## Usage
 *
 *   npx tsx server/src/scripts/backfill-invite-events.ts             # pre-flight only (no writes)
 *   npx tsx server/src/scripts/backfill-invite-events.ts --yes       # write events
 *   npx tsx server/src/scripts/backfill-invite-events.ts --yes --batch 200
 *
 * ## Env
 *
 *   DATABASE_URL  required
 */

import { closeDatabase, initializeDatabase, query } from '../db/client.js';
import { resolvePersonId } from '../db/relationship-db.js';
import { recordInviteEvent, type InviteEventType } from '../db/person-events-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('backfill-invite-events');

interface Args {
  yes: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { yes: false, batch: 100 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes') {
      args.yes = true;
    } else if (a === '--batch') {
      const raw = argv[++i];
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--batch requires a positive integer, got: ${raw}`);
      }
      args.batch = n;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: npx tsx backfill-invite-events.ts [--yes] [--batch N]\n' +
          '  (no flag)  pre-flight only, prints what would be written\n' +
          '  --yes      write events\n' +
          '  --batch N  page size (default 100)'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function describeDatabaseTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  try {
    const parsed = new URL(url);
    const dbname = parsed.pathname.replace(/^\//, '') || '(none)';
    return `${parsed.host}/${dbname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function ensureMigrationApplied(): Promise<void> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'membership_invites' AND column_name = 'id'
     ) AS exists`
  );
  if (!result.rows[0]?.exists) {
    throw new Error(
      'Migration 458 has not run on this database — membership_invites.id is missing. Run migrations first.'
    );
  }
}

interface InviteRow {
  id: string;
  token: string;
  workos_organization_id: string;
  lookup_key: string;
  contact_email: string;
  contact_name: string | null;
  invited_by_user_id: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by_user_id: string | null;
  invoice_id: string | null;
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
}

interface Plan {
  type: InviteEventType;
  occurredAt: Date;
  data: Record<string, unknown>;
}

function planEvents(row: InviteRow, now: Date): Plan[] {
  const tokenPrefix = row.token.slice(0, 8);
  const orgId = row.workos_organization_id;
  const lookupKey = row.lookup_key;

  const plans: Plan[] = [
    {
      type: 'invite_sent',
      occurredAt: row.created_at,
      data: {
        token_prefix: tokenPrefix,
        org_id: orgId,
        lookup_key: lookupKey,
        contact_name: row.contact_name,
        expires_at: row.expires_at.toISOString(),
        invited_by_user_id: row.invited_by_user_id,
      },
    },
  ];

  if (row.accepted_at) {
    plans.push({
      type: 'invite_accepted',
      occurredAt: row.accepted_at,
      data: {
        token_prefix: tokenPrefix,
        org_id: orgId,
        lookup_key: lookupKey,
        accepted_by_user_id: row.accepted_by_user_id,
        invoice_id: row.invoice_id,
      },
    });
  }
  if (row.revoked_at) {
    plans.push({
      type: 'invite_revoked',
      occurredAt: row.revoked_at,
      data: {
        token_prefix: tokenPrefix,
        org_id: orgId,
        lookup_key: lookupKey,
        revoked_by_user_id: row.revoked_by_user_id,
        previous_status: row.accepted_at
          ? 'accepted'
          : row.expires_at.getTime() <= row.revoked_at.getTime()
            ? 'expired'
            : 'pending',
      },
    });
  }
  if (
    !row.accepted_at &&
    !row.revoked_at &&
    row.expires_at.getTime() <= now.getTime()
  ) {
    plans.push({
      type: 'invite_expired',
      occurredAt: row.expires_at,
      data: {
        token_prefix: tokenPrefix,
        org_id: orgId,
        lookup_key: lookupKey,
        expired_at: row.expires_at.toISOString(),
        detected_at: now.toISOString(),
        backfilled: true,
      },
    });
  }

  return plans;
}

interface PreFlightStats {
  totalInvites: number;
  pendingInvites: number;
  acceptedInvites: number;
  revokedInvites: number;
  expiredInvites: number;
  expectedEvents: number;
  ghostsToCreate: number;
}

async function preFlight(): Promise<PreFlightStats> {
  const stateResult = await query<{
    total: string;
    pending: string;
    accepted: string;
    revoked: string;
    expired: string;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (
         WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       ) AS pending,
       COUNT(*) FILTER (WHERE accepted_at IS NOT NULL) AS accepted,
       COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked,
       COUNT(*) FILTER (
         WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= NOW()
       ) AS expired
     FROM membership_invites`
  );
  const row = stateResult.rows[0] ?? {
    total: '0', pending: '0', accepted: '0', revoked: '0', expired: '0',
  };
  const stats: PreFlightStats = {
    totalInvites: Number(row.total),
    pendingInvites: Number(row.pending),
    acceptedInvites: Number(row.accepted),
    revokedInvites: Number(row.revoked),
    expiredInvites: Number(row.expired),
    expectedEvents: 0,
    ghostsToCreate: 0,
  };
  // Each invite contributes one invite_sent. Accepted/revoked/expired add a
  // second event per invite (revoked may stack with expired in the DB but
  // the script only emits one terminal event per row).
  stats.expectedEvents =
    stats.totalInvites +
    stats.acceptedInvites +
    stats.revokedInvites +
    stats.expiredInvites;

  const ghostsResult = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT mi.contact_email) AS count
     FROM membership_invites mi
     LEFT JOIN person_relationships pr
       ON pr.email = mi.contact_email
     WHERE pr.id IS NULL`
  );
  stats.ghostsToCreate = Number(ghostsResult.rows[0]?.count ?? 0);

  console.log('--- pre-flight ---');
  console.log(`Database target:                ${describeDatabaseTarget()}`);
  console.log(`Total invites:                  ${stats.totalInvites}`);
  console.log(`  pending:                      ${stats.pendingInvites}`);
  console.log(`  accepted:                     ${stats.acceptedInvites}`);
  console.log(`  revoked:                      ${stats.revokedInvites}`);
  console.log(`  expired (not revoked):        ${stats.expiredInvites}`);
  console.log(`Events to attempt:              ${stats.expectedEvents}`);
  console.log(`person_relationships to create: ${stats.ghostsToCreate}`);
  console.log('');
  console.log(
    'Each invite contributes one invite_sent; accepted/revoked/expired adds a'
  );
  console.log(
    'second terminal event. Re-runs are idempotent (ON CONFLICT DO NOTHING).'
  );
  console.log('');
  return stats;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  const now = new Date();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  initializeDatabase({ connectionString: databaseUrl });

  await ensureMigrationApplied();
  await preFlight();

  if (!args.yes) {
    console.log('Pre-flight only — pass --yes to write events.');
    return;
  }

  let lastId: string | null = null;
  let totalRows = 0;
  let inserted = 0;
  let skipped = 0;
  let resolveFailures = 0;
  let planFailures = 0;
  let recordFailures = 0;

  for (;;) {
    const params: unknown[] = [args.batch];
    let cursorClause = '';
    if (lastId) {
      params.push(lastId);
      cursorClause = `WHERE id > $${params.length}`;
    }
    const result = await query<InviteRow>(
      `SELECT id, token, workos_organization_id, lookup_key, contact_email,
              contact_name, invited_by_user_id, created_at, expires_at,
              accepted_at, accepted_by_user_id, invoice_id,
              revoked_at, revoked_by_user_id
       FROM membership_invites
       ${cursorClause}
       ORDER BY id ASC
       LIMIT $1`,
      params
    );

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      lastId = row.id;
      totalRows += 1;

      let personId: string;
      try {
        personId = await resolvePersonId({ email: row.contact_email });
      } catch (err) {
        resolveFailures += 1;
        logger.warn(
          { err, inviteId: row.id, contactEmail: row.contact_email },
          'Failed to resolve person — skipping invite'
        );
        continue;
      }

      let plans: Plan[];
      try {
        plans = planEvents(row, now);
      } catch (err) {
        planFailures += 1;
        logger.warn(
          { err, inviteId: row.id },
          'Failed to plan events for invite — skipping'
        );
        continue;
      }

      for (const plan of plans) {
        try {
          const wrote = await recordInviteEvent(personId, plan.type, row.id, {
            occurredAt: plan.occurredAt,
            data: plan.data,
          });
          if (wrote) inserted += 1;
          else skipped += 1;
        } catch (err) {
          recordFailures += 1;
          logger.warn(
            { err, inviteId: row.id, type: plan.type },
            'Failed to record invite event'
          );
        }
      }
    }
  }

  console.log('--- done ---');
  console.log(`Invites processed:    ${totalRows}`);
  console.log(`Events inserted:      ${inserted}`);
  console.log(`Events skipped (dedupe / re-run): ${skipped}`);
  console.log(`Resolve failures:     ${resolveFailures}`);
  console.log(`Plan failures:        ${planFailures}`);
  console.log(`Record failures:      ${recordFailures}`);
}

run()
  .then(() => closeDatabase())
  .catch(async (err) => {
    logger.error({ err }, 'Backfill failed');
    await closeDatabase();
    process.exit(1);
  });
