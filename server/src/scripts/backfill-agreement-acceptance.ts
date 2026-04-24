/**
 * Backfill a missing row in user_agreement_acceptances for a subscription
 * whose `customer.subscription.created` webhook alerted with
 * `needs_manual_reconciliation: true`.
 *
 * The webhook (server/src/http.ts) now resolves the WorkOS user in this
 * priority order:
 *   1. org.pending_agreement_user_id (set at checkbox time — reliable)
 *   2. subscription.metadata.workos_user_id
 *   3. customer.metadata.workos_user_id
 *   4. customer.email → WorkOS listUsers (brittle, the original bug)
 *
 * When all four fail, the webhook records the org-level agreement,
 * notifies Slack, and leaves the user-level attestation missing. This
 * script backfills that row after an admin has identified the correct
 * WorkOS user.
 *
 * ## Usage
 *
 *   npx tsx server/src/scripts/backfill-agreement-acceptance.ts \
 *     --subscription sub_XXX \
 *     --workos-user-id user_YYY
 *
 *   npx tsx server/src/scripts/backfill-agreement-acceptance.ts \
 *     --subscription sub_XXX
 *   # ^ without --workos-user-id, reads org.pending_agreement_user_id
 *     # or errors out with a list of org members to pick from
 *
 * ## Env
 *
 *   DATABASE_URL         required
 *   STRIPE_SECRET_KEY    required (to look up the subscription + customer)
 *   WORKOS_API_KEY       required (to verify user + org membership)
 *
 * ## Safety
 *
 * - The underlying INSERT uses ON CONFLICT DO NOTHING — safe to re-run.
 * - Verifies the provided user is a member of the subscribing org before
 *   inserting. If not a member, the script refuses and prints the
 *   member list.
 * - Dry-run via --dry-run prints what would happen without writing.
 */

import { WorkOS } from '@workos-inc/node';
import Stripe from 'stripe';
import { closeDatabase } from '../db/client.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('backfill-agreement');

interface Args {
  subscriptionId: string;
  workosUserId?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { subscriptionId: '', dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--subscription') args.subscriptionId = argv[++i];
    else if (a === '--workos-user-id') args.workosUserId = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.subscriptionId) throw new Error('--subscription sub_XXX is required');
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  if (!process.env.WORKOS_API_KEY) throw new Error('WORKOS_API_KEY not set');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const workos = new WorkOS(process.env.WORKOS_API_KEY);
  const orgDb = new OrganizationDatabase();

  const subscription = await stripe.subscriptions.retrieve(args.subscriptionId);
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;

  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    throw new Error(`Customer ${customerId} is deleted — cannot backfill.`);
  }

  const orgIdFromMetadata = subscription.metadata?.workos_organization_id
    || customer.metadata?.workos_organization_id;
  if (!orgIdFromMetadata) {
    throw new Error(
      `No workos_organization_id found on subscription ${args.subscriptionId} or customer ${customerId} metadata. Cannot resolve org.`,
    );
  }

  const org = await orgDb.getOrganization(orgIdFromMetadata);
  if (!org) {
    throw new Error(`Organization ${orgIdFromMetadata} not found in local DB.`);
  }

  const workosUserId = args.workosUserId ?? org.pending_agreement_user_id;
  if (!workosUserId) {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId: org.workos_organization_id,
    });
    const lines = await Promise.all(memberships.data.map(async (m) => {
      try {
        const u = await workos.userManagement.getUser(m.userId);
        return `  ${m.userId}  ${u.email}${u.firstName ? ` (${u.firstName} ${u.lastName ?? ''})` : ''}`;
      } catch {
        return `  ${m.userId}  (lookup failed)`;
      }
    }));
    throw new Error(
      `No user resolvable via --workos-user-id or org.pending_agreement_user_id. Pick from current members:\n${lines.join('\n')}\n\nRerun with --workos-user-id <id>.`,
    );
  }

  const user = await workos.userManagement.getUser(workosUserId);

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: workosUserId,
    organizationId: org.workos_organization_id,
  });
  if (memberships.data.length === 0) {
    throw new Error(
      `WorkOS user ${workosUserId} (${user.email}) is not a member of org ${org.workos_organization_id}. Refusing to record a misattributed agreement.`,
    );
  }

  const agreementVersion = org.agreement_version ?? org.pending_agreement_version ?? '1.0';

  logger.info({
    subscriptionId: args.subscriptionId,
    orgId: org.workos_organization_id,
    workosUserId,
    userEmail: user.email,
    agreementVersion,
    dryRun: args.dryRun,
    source: args.workosUserId ? 'cli-override' : 'pending_agreement_user_id',
  }, 'Backfill plan');

  if (args.dryRun) {
    logger.info('--dry-run: no database writes. Rerun without --dry-run to apply.');
    return;
  }

  await orgDb.recordUserAgreementAcceptance({
    workos_user_id: workosUserId,
    email: user.email,
    agreement_type: 'membership',
    agreement_version: agreementVersion,
    workos_organization_id: org.workos_organization_id,
  });

  // Best-effort: clear pending_* so future webhooks don't attempt to
  // re-record against stale state.
  await orgDb.updateOrganization(org.workos_organization_id, {
    pending_agreement_version: null,
    pending_agreement_accepted_at: null,
    pending_agreement_user_id: null,
  }).catch(err => logger.warn({ err }, 'Failed to clear pending_* fields (non-critical)'));

  logger.info({
    subscriptionId: args.subscriptionId,
    orgId: org.workos_organization_id,
    workosUserId,
    userEmail: user.email,
  }, 'Backfill complete — user_agreement_acceptances recorded');
}

main()
  .catch((err: Error) => {
    logger.error({ err: err.message || err }, 'Backfill failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closeDatabase(); } catch { /* no-op */ }
  });
