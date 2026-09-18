/**
 * Report duplicate prospect-stub org rows surfaced by the
 * `unique-org-per-email-domain` invariant. Reporting only — see the #6827 note
 * below; this script used to delete them and no longer does.
 *
 * Background — May 2026 audit: the April-20 prospect import re-ran without
 * dedup, creating a second `prospect`/0-member row for ~60 companies that
 * already had one from the December 2025 import. The duplicate is empty
 * (no stripe_customer_id, no agreement, no announcement, no subscription)
 * but clutters admin search and breaks domain-keyed automation.
 *
 * #6827: THIS SCRIPT NO LONGER DELETES ANYTHING. It is read-only analysis.
 *
 * It previously deleted duplicate organization rows with direct SQL, reasoning
 * from the absence of an admin delete endpoint that a script was the sanctioned
 * route. That is exactly backwards. Organization deletion and organization merge
 * are contained under #6827 because removing an organization locally while its
 * WorkOS organization survives is the split provider/local state the containment
 * exists to prevent — and a script bypasses the containment, the audit trail and
 * the reconciliation contract all at once. An operator bypass is still a bypass.
 *
 * What it does now:
 *   1. Runs the invariant via the admin API to get the duplicate list.
 *   2. Classifies each pair and reports which duplicates are fully empty stubs
 *        - 0 organization_memberships
 *        - stripe_customer_id IS NULL
 *        - subscription_status IS NULL or 'none'
 *      versus which carry members or Stripe state.
 *   3. Stops. It opens no database connection and issues no writes. `--execute`
 *      hard-refuses before any connection is made.
 *
 * Usage (read-only; no DATABASE_URL needed or used):
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/incidents/2026-05-cleanup-duplicate-prospect-stubs.ts
 *
 * Hand the report to the engineering owner of #6827. Do not delete or edit the
 * rows by hand.
 */

// #6827 containment, before anything else runs: refuse the destructive mode
// outright. This precedes every network call and every database connection —
// the script no longer even imports a database client — so there is no path
// from this flag to a mutation.
if (process.argv.includes('--execute')) {
  console.error(
    'organization_deletion_unavailable: --execute is refused.\n' +
    '\n' +
    'This script used to delete duplicate organization rows with direct SQL.\n' +
    'Organization deletion and organization merge are contained under #6827\n' +
    'because deleting an organization locally while its WorkOS organization\n' +
    'survives is the split provider/local state the containment prevents.\n' +
    'A script bypass is still a bypass, so the destructive path was removed.\n' +
    '\n' +
    'Run without --execute for the read-only report, then escalate to the\n' +
    'engineering owner of #6827. Do not delete or edit the rows by hand.\n' +
    'See docs/contributing/organization-deletion-containment.md.',
  );
  process.exit(1);
}

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL?.replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_BASE_URL) {
  console.error('ADMIN_BASE_URL not set (e.g. https://agenticadvertising.org)');
  process.exit(1);
}
if (!ADMIN_API_KEY) {
  console.error('ADMIN_API_KEY not set');
  process.exit(1);
}

interface Violation {
  invariant: string;
  severity: string;
  subject_id: string;
  message: string;
  details?: {
    email_domain?: string;
    duplicate?: {
      workos_organization_id: string;
      name: string;
      member_count: number;
      has_stripe_customer: boolean;
      has_active_subscription: boolean;
      member_status?: string;
    };
    keeper?: {
      workos_organization_id: string;
      name: string;
      member_count: number;
      has_stripe_customer: boolean;
    };
  };
}

interface InvariantRunReport {
  total_violations: number;
  violations: Violation[];
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  console.log('Mode: READ-ONLY REPORT (#6827 containment; no execute mode exists)');
  console.log(`Admin: ${ADMIN_BASE_URL}\n`);

  console.log('Running unique-org-per-email-domain invariant...');
  const report = await adminGet<InvariantRunReport>(
    '/api/admin/integrity/check/unique-org-per-email-domain',
  );

  const violations = report.violations.filter(
    (v) => v.invariant === 'unique-org-per-email-domain',
  );
  console.log(`Found ${violations.length} duplicate org row(s).\n`);
  if (violations.length === 0) return;

  // Partition into truly-empty stubs vs. duplicates carrying state. Neither
  // bucket is actionable here: organization merge and deletion are both
  // contained (#6827), so both are reported and escalated, not resolved.
  const emptyStubs: Violation[] = [];
  const nonEmptyDuplicates: Violation[] = [];
  for (const v of violations) {
    const dup = v.details?.duplicate;
    if (!dup) {
      nonEmptyDuplicates.push(v);
      continue;
    }
    const isEmpty =
      dup.member_count === 0 &&
      !dup.has_stripe_customer &&
      !dup.has_active_subscription;
    if (isEmpty) {
      emptyStubs.push(v);
    } else {
      nonEmptyDuplicates.push(v);
    }
  }

  console.log(`  Truly empty stubs (report only): ${emptyStubs.length}`);
  console.log(`  Non-empty duplicates (escalate, do not consolidate): ${nonEmptyDuplicates.length}\n`);

  if (nonEmptyDuplicates.length > 0) {
    console.log('=== Non-empty duplicates (escalate to the #6827 owner) ===');
    for (const v of nonEmptyDuplicates) {
      const d = v.details?.duplicate;
      const k = v.details?.keeper;
      console.log(
        `  ${d?.workos_organization_id} "${d?.name}" ` +
        `(${d?.member_count} members, stripe=${d?.has_stripe_customer}) ` +
        `→ keeper ${k?.workos_organization_id} "${k?.name}"`,
      );
    }
    console.log();
  }

  if (emptyStubs.length === 0) {
    console.log('No empty stubs found.');
    return;
  }

  console.log('=== Empty stubs (reportable only — consolidation is contained) ===');
  for (const v of emptyStubs) {
    const d = v.details?.duplicate;
    const k = v.details?.keeper;
    console.log(
      `  ${d?.workos_organization_id} "${d?.name}" ` +
      `(domain=${v.details?.email_domain}, keeper=${k?.workos_organization_id})`,
    );
  }
  console.log();

  console.log(
    'Read-only report only — no deletes are issued and no database connection\n' +
    'is opened. Organization deletion and organization merge are contained\n' +
    'under #6827 (organization_deletion_unavailable / organization_merge_unavailable).\n' +
    'Hand this list to the engineering owner of #6827; do not delete or edit the\n' +
    'rows by hand, and do not re-add a direct SQL path here.',
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
