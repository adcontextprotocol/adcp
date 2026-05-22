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
 *   --skip-personal-email-fallback              skip credentials where the
 *                                                proposed value is the user's
 *                                                email AND the domain is a
 *                                                personal-email provider
 *                                                (gmail, hotmail, etc.) —
 *                                                avoids surfacing PII on a
 *                                                publicly-shareable artifact
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
const skipPersonalEmailFallback = process.argv.includes('--skip-personal-email-fallback');

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const credentialIdFilter = readFlag('credential-id');
const userIdFilter = readFlag('workos-user-id');

// Personal-email domains where writing the email as the recipient name on a
// public-shareable certificate would expose PII. Corporate domains are fine
// — the email is already on the user's business card / LinkedIn — but
// personal addresses surface on a publicly-linkable artifact in a way the
// user didn't opt into. The `--skip-personal-email-fallback` flag skips
// credentials where the proposed value would write one of these domains.
// The recovery path for those users is the new NAME_REQUIRED gate +
// set_my_name tool added in #4799 — they enter their name via Addie and
// the backfill becomes a no-op when we re-run.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'gmx.com',
  'gmx.de',
  'zoho.com',
  'fastmail.com',
  'pm.me',
  'tutanota.com',
  'msn.com',
  'hey.com',
]);

function isPersonalEmailFallback(desired: string, email: string): boolean {
  if (desired !== email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return PERSONAL_EMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase());
}

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

// Certifier's recipient.name field on the credential GET is a denormalized
// snapshot of the recipient resource — it is NOT what drives certificate
// rendering. The design template resolves `{recipient.name}` placeholders
// against the `attributes` map first (the override layer written by PATCH
// /credentials/{id}); only when that key is absent does it fall back to the
// recipient resource. So:
//   - When attributes['recipient.name'] is set, that's the rendered name.
//   - When attributes['recipient.name'] is absent, recipient.name renders.
// effectiveRenderedName picks the right one. Prior versions of this script
// compared against recipient.name alone, which made the dry-run report
// already-repaired credentials as still-broken (the attribute override was
// landing correctly, but the comparison missed it).
function effectiveRenderedName(remote: { recipient?: { name?: string }; attributes?: Record<string, string> }): string {
  const override = remote.attributes?.['recipient.name']?.trim();
  if (override) return override;
  return remote.recipient?.name ?? '';
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
      const current = effectiveRenderedName(remote);
      if (needsRepair(current, desired, row)) {
        if (skipPersonalEmailFallback && isPersonalEmailFallback(desired, row.email)) {
          skipped.push({
            row,
            current,
            desired,
            reason: 'personal-email-fallback (--skip-personal-email-fallback)',
          });
        } else {
          plan.push({
            workos_user_id: row.workos_user_id,
            email: row.email,
            certifier_credential_id: row.certifier_credential_id,
            current_name: current,
            desired_name: desired,
          });
        }
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
        // Verify the attribute override actually landed. Certifier returns
        // 200 on PATCH regardless, so post-update GET is the only honest
        // signal that the rendered cert will pick up the new name. Catches
        // the "PATCH accepted but field-shape was wrong" class of bug.
        const verify = await getCredential(p.certifier_credential_id);
        const verifyName = effectiveRenderedName(verify);
        if (verifyName !== p.desired_name) {
          console.log(`  FAIL  ${p.certifier_credential_id}  PATCH 200 but rendered name still "${verifyName}" (expected "${p.desired_name}")`);
          failed++;
          continue;
        }
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
