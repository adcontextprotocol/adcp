/**
 * Heal partial-truth subscription rows surfaced by the
 * `every-entitled-org-has-resolvable-tier` invariant.
 *
 * Background — Adzymic / Travis Teo (May 2026): founding-member org rows had
 * `subscription_status='active'` but NULL `subscription_price_lookup_key`,
 * NULL `stripe_subscription_id`, NULL `subscription_amount`. The tier
 * resolver returned null; the dashboard rendered "Explorer" and prompted
 * the customer to upgrade to Professional. Five+ founding-era corporate
 * orgs were in this state.
 *
 * The fix in `lazy-reconcile.ts` heals these rows on next paywall touch,
 * but customers shouldn't have to bump into a paywall to get the right
 * dashboard. This script walks the invariant's violations and POSTs to
 * `/api/admin/accounts/:orgId/sync` for each, which re-pulls the customer's
 * Stripe subscriptions and writes the lookup_key into the row.
 *
 * Defaults to --dry-run (lists the orgs, no sync calls). Pass --execute
 * to actually sync.
 *
 * Usage:
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/incidents/2026-05-heal-partial-truth-tier-rows.ts            # dry run
 *
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/incidents/2026-05-heal-partial-truth-tier-rows.ts --execute  # live
 */

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

const execute = process.argv.includes('--execute');
const dryRun = !execute;

interface Violation {
  invariant: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  message: string;
  details?: Record<string, unknown>;
}

interface InvariantRunReport {
  total_violations: number;
  violations: Violation[];
}

interface SyncResponse {
  success?: boolean;
  stripe?: { success?: boolean; subscription?: { status?: string }; error?: string };
  workos?: { success?: boolean; error?: string };
  updated?: boolean;
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

async function adminPost<T>(path: string): Promise<T> {
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Admin: ${ADMIN_BASE_URL}\n`);

  console.log('Running every-entitled-org-has-resolvable-tier invariant...');
  const report = await adminGet<InvariantRunReport>(
    '/api/admin/integrity/check/every-entitled-org-has-resolvable-tier',
  );

  const violations = report.violations.filter(
    (v) => v.invariant === 'every-entitled-org-has-resolvable-tier',
  );

  console.log(`Found ${violations.length} partial-truth orgs.\n`);
  if (violations.length === 0) return;

  for (const v of violations) {
    const d = v.details ?? {};
    console.log(`- ${v.subject_id} (${d.org_name ?? '?'})`);
    console.log(
      `    status=${JSON.stringify(d.subscription_status)} ` +
        `lookup_key=${JSON.stringify(d.subscription_price_lookup_key)} ` +
        `amount=${JSON.stringify(d.subscription_amount)} ` +
        `sub_id=${JSON.stringify(d.stripe_subscription_id)}`,
    );
  }

  if (dryRun) {
    console.log('\nDry run — no sync calls issued. Pass --execute to heal.');
    return;
  }

  console.log('\nSyncing each org from Stripe...');
  let healed = 0;
  let stripeSkipped = 0;
  let failed = 0;
  for (const v of violations) {
    try {
      // adminPost throws on non-2xx, so reaching here means the endpoint accepted
      // the call. The endpoint's `success` field is true only when both WorkOS
      // *and* Stripe sub-syncs succeeded; for orgs with no live Stripe sub the
      // Stripe branch returns success=true with an "error" message instead. We
      // care that the sync ran without HTTP error, then surface what changed.
      const result = await adminPost<SyncResponse>(
        `/api/admin/accounts/${encodeURIComponent(v.subject_id)}/sync`,
      );
      if (result.updated) {
        healed++;
        const status = result.stripe?.subscription?.status;
        console.log(`  ✓ ${v.subject_id} synced${status ? ` (status=${status})` : ''}`);
      } else {
        // Sync ran but didn't write — usually means no live Stripe sub and no
        // paid membership invoice (legacy hand-rolled deals). These need
        // manual tier setting; the script can't heal them.
        stripeSkipped++;
        const reason = result.stripe?.error ?? 'no Stripe data to write';
        console.log(`  ~ ${v.subject_id} not updated: ${reason}`);
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ ${v.subject_id} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `\nHealed ${healed}, skipped ${stripeSkipped} (no Stripe data), failed ${failed}, total ${violations.length}.`,
  );
  console.log('Re-run the invariant to confirm — orgs with no Stripe subscription');
  console.log('at all (legacy hand-rolled deals) will still need manual tier setting.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
