/**
 * Repair Certifier credentials that were issued with broken recipient names —
 * specifically the "undefined undefined" literal that lands on the certificate
 * when a learner earns a credential before WorkOS has populated their
 * first_name / last_name (escalation #382, Tom Hespos).
 *
 * For each user_credentials row with a certifier_credential_id, fetch the
 * credential from Certifier and check whether its recipient name needs fixing.
 * A name needs fixing when:
 *   - it contains the literal "undefined" (the original bug), OR
 *   - it equals the user's email (older fallback) AND the user now has a
 *     populated first_name / last_name we could substitute.
 * For each mismatch, PATCH Certifier with `buildRecipientName(user)`.
 *
 * Usage (dev):
 *   npx tsx server/src/scripts/repair-credential-recipient-names.ts            # dry-run
 *   npx tsx server/src/scripts/repair-credential-recipient-names.ts --apply    # write
 *
 * Optional filters:
 *   --credential-id=<certifier_credential_id>   only this credential
 *   --workos-user-id=<id>                        only this learner's credentials
 *
 * Usage (prod, via fly ssh):
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/repair-credential-recipient-names.js'
 *   fly ssh console -a adcp-docs -C 'node /app/dist/scripts/repair-credential-recipient-names.js --apply'
 *
 * Prerequisites: DATABASE_URL, CERTIFIER_API_TOKEN set.
 */

import { initializeDatabase, getPool, closeDatabase } from '../db/client.js';
import { getDatabaseConfig } from '../config.js';
import {
  getCredential,
  updateCredential,
  isCertifierConfigured,
  buildRecipientName,
} from '../services/certifier-client.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const credentialIdFilter = readFlag('credential-id');
const userIdFilter = readFlag('workos-user-id');

interface Row {
  workos_user_id: string;
  credential_id: string;
  certifier_credential_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

interface PlanEntry {
  workos_user_id: string;
  email: string;
  certifier_credential_id: string;
  current_name: string;
  desired_name: string;
}

function needsRepair(current: string, desired: string, user: Row): boolean {
  if (current === desired) return false;
  if (current.toLowerCase().includes('undefined')) return true;
  if (current.toLowerCase().includes('null')) return true;
  // Email-as-name fallback: repair only when we now have real name data to
  // substitute. If the user still has no first_name and no last_name, leave
  // the email-name in place.
  if (current === user.email && (user.first_name || user.last_name)) return true;
  return false;
}

async function main(): Promise<void> {
  if (!isCertifierConfigured()) {
    console.error('CERTIFIER_API_TOKEN is not set');
    process.exit(1);
  }
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);
  const pool = getPool();

  const params: unknown[] = [];
  const where: string[] = ['uc.certifier_credential_id IS NOT NULL'];
  if (credentialIdFilter) {
    params.push(credentialIdFilter);
    where.push(`uc.certifier_credential_id = $${params.length}`);
  }
  if (userIdFilter) {
    params.push(userIdFilter);
    where.push(`uc.workos_user_id = $${params.length}`);
  }

  const result = await pool.query<Row>(
    `SELECT uc.workos_user_id,
            uc.credential_id,
            uc.certifier_credential_id,
            u.first_name,
            u.last_name,
            u.email
       FROM user_credentials uc
       JOIN users u ON u.workos_user_id = uc.workos_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY uc.workos_user_id`,
    params,
  );

  const plan: PlanEntry[] = [];
  const skipped: Array<{ row: Row; current: string; desired: string; reason: string }> = [];
  const errors: Array<{ row: Row; error: string }> = [];

  for (const row of result.rows) {
    try {
      const desired = buildRecipientName(row);
      const remote = await getCredential(row.certifier_credential_id);
      const current = remote.recipient?.name ?? '';
      if (needsRepair(current, desired, row)) {
        plan.push({
          workos_user_id: row.workos_user_id,
          email: row.email,
          certifier_credential_id: row.certifier_credential_id,
          current_name: current,
          desired_name: desired,
        });
      } else {
        skipped.push({
          row,
          current,
          desired,
          reason: current === desired ? 'already correct' : 'no real name data to substitute',
        });
      }
    } catch (err) {
      errors.push({ row, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`Mode:      ${dryRun ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing changes)'}`);
  console.log(`Scanned:   ${result.rows.length} credentials`);
  console.log(`Would fix: ${plan.length}`);
  console.log(`Skipped:   ${skipped.length}`);
  console.log(`Errors:    ${errors.length}`);

  if (plan.length > 0) {
    console.log('\nRepair plan:');
    for (const p of plan) {
      console.log(`  ${p.certifier_credential_id}  ${p.workos_user_id} <${p.email}>`);
      console.log(`    "${p.current_name}" -> "${p.desired_name}"`);
    }
  }

  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const e of errors) {
      console.log(`  ${e.row.certifier_credential_id}  ${e.row.workos_user_id}: ${e.error}`);
    }
  }

  if (!dryRun && plan.length > 0) {
    console.log('\nApplying repairs...');
    let ok = 0;
    let failed = 0;
    for (const p of plan) {
      try {
        await updateCredential(p.certifier_credential_id, {
          recipient: { name: p.desired_name, email: p.email },
        });
        console.log(`  ok    ${p.certifier_credential_id}  -> "${p.desired_name}"`);
        ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  FAIL  ${p.certifier_credential_id}  ${msg}`);
        failed++;
      }
    }
    console.log(`\nRepaired: ${ok}   Failed: ${failed}`);
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
