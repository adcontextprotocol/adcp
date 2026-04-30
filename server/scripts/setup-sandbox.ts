/**
 * Stripe + dev-DB sandbox for billing reconciliation work.
 *
 * Idempotently creates a deterministic fixture set in Stripe TEST MODE and
 * the local Postgres dev DB. Each fixture exercises one failure mode the
 * cron auto-remediator must handle correctly. Re-runnable: existing
 * fixtures are detected via `metadata.aao_sandbox_id` and skipped.
 *
 * Refuses to run unless STRIPE_SECRET_KEY is sk_test_*.
 *
 * Usage:
 *   npx tsx server/scripts/setup-sandbox.ts        # create
 *   npx tsx server/scripts/setup-sandbox.ts --teardown   # remove
 *
 * See server/scripts/SANDBOX.md for the fixture matrix.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import pg from 'pg';

const SANDBOX_TAG = 'aao_sandbox_id';
const SANDBOX_ORG_PREFIX = 'AAO Sandbox - ';
const SANDBOX_EMAIL_DOMAIN = 'aao-sandbox.test';

interface FixtureSpec {
  id: string;
  description: string;
  /** Stripe price lookup_key for the membership sub. null = no sub created. */
  primary_price_lookup_key: string | null;
  /** Optional second price (for multi_sub). */
  secondary_price_lookup_key?: string | null;
  /** Override Stripe customer email (for email_mismatch — defaults to owner email). */
  stripe_customer_email_override?: string;
  /** subscription_status to write on the org row. null = NULL (drift). */
  org_subscription_status: string | null;
  /** Whether to insert into organization_memberships (false simulates WorkOS not knowing the user). */
  insert_org_membership: boolean;
  /** Whether to link stripe_customer_id on the org row. false = orphan (no DB link). */
  link_customer_to_org: boolean;
  is_personal: boolean;
}

const FIXTURES: FixtureSpec[] = [
  {
    id: 'lina_class',
    description: 'Paying member, webhook missed, DB has no subscription_status. Healthy WorkOS resolution.',
    primary_price_lookup_key: 'aao_membership_professional_250',
    org_subscription_status: null,
    insert_org_membership: true,
    link_customer_to_org: true,
    is_personal: true,
  },
  {
    id: 'healthy',
    description: 'Active paid member, DB row reflects Stripe state. Cron should no-op.',
    primary_price_lookup_key: 'aao_membership_professional_250',
    org_subscription_status: 'active',
    insert_org_membership: true,
    link_customer_to_org: true,
    is_personal: false,
  },
  {
    id: 'email_mismatch',
    description: 'Stripe customer email differs from org owner email. Cron must refuse remediation.',
    primary_price_lookup_key: 'aao_membership_professional_250',
    stripe_customer_email_override: `attacker@${SANDBOX_EMAIL_DOMAIN}`,
    org_subscription_status: null,
    insert_org_membership: true,
    link_customer_to_org: true,
    is_personal: false,
  },
  {
    id: 'multi_sub',
    description: 'Customer has two active subs (membership + non-membership). Cron must filter to membership.',
    primary_price_lookup_key: 'aao_membership_explorer_50',
    secondary_price_lookup_key: 'aao_sandbox_event_ticket',
    org_subscription_status: null,
    insert_org_membership: true,
    link_customer_to_org: true,
    is_personal: true,
  },
  {
    id: 'orphan',
    description: 'Active paid Stripe customer with no AAO org link. Cron flags warning, never auto-links.',
    primary_price_lookup_key: 'aao_membership_explorer_50',
    org_subscription_status: null,
    insert_org_membership: false,
    link_customer_to_org: false,
    is_personal: false,
  },
  {
    id: 'workos_no_resolution',
    description: 'Customer email maps to no member of the org (WorkOS resolution returns null). Cron refuses.',
    primary_price_lookup_key: 'aao_membership_professional_250',
    org_subscription_status: null,
    insert_org_membership: false,  // simulates "user not in org" in dev-mode WorkOS bypass
    link_customer_to_org: true,
    is_personal: false,
  },
];

function stripeCustomerEmail(f: FixtureSpec): string {
  return f.stripe_customer_email_override ?? `${f.id}@${SANDBOX_EMAIL_DOMAIN}`;
}

function ownerEmail(f: FixtureSpec): string {
  return `${f.id}@${SANDBOX_EMAIL_DOMAIN}`;
}

function ownerWorkosUserId(f: FixtureSpec): string {
  return `user_aao_sandbox_${f.id}`;
}

function workosOrgId(f: FixtureSpec): string {
  return `org_aao_sandbox_${f.id}`;
}

function orgName(f: FixtureSpec): string {
  return `${SANDBOX_ORG_PREFIX}${f.id}`;
}

async function ensureNonMembershipPrice(stripe: Stripe): Promise<string> {
  const lookupKey = 'aao_sandbox_event_ticket';
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  if (existing.data.length > 0) return lookupKey;

  const product = await stripe.products.create({
    name: 'AAO Sandbox - Event Ticket (non-membership)',
    metadata: { aao_sandbox_fixture: 'true' },
  });
  await stripe.prices.create({
    product: product.id,
    unit_amount: 2000,
    currency: 'usd',
    recurring: { interval: 'year' },
    lookup_key: lookupKey,
    metadata: { aao_sandbox_fixture: 'true' },
  });
  console.log(`  created non-membership product+price (lookup_key=${lookupKey})`);
  return lookupKey;
}

async function findCustomerByTag(stripe: Stripe, fixtureId: string): Promise<Stripe.Customer | null> {
  // search-by-metadata isn't directly exposed; use search() with query syntax
  const result = await stripe.customers.search({
    query: `metadata['${SANDBOX_TAG}']:'${fixtureId}'`,
    limit: 1,
  });
  return (result.data[0] as Stripe.Customer) ?? null;
}

async function ensureStripeFixture(stripe: Stripe, f: FixtureSpec): Promise<{ customer: Stripe.Customer; subscriptionIds: string[] }> {
  let customer = await findCustomerByTag(stripe, f.id);
  if (!customer) {
    customer = await stripe.customers.create({
      email: stripeCustomerEmail(f),
      name: `AAO Sandbox ${f.id}`,
      metadata: { [SANDBOX_TAG]: f.id, aao_sandbox_fixture: 'true' },
    });
    console.log(`  created Stripe customer ${customer.id}`);
  } else {
    console.log(`  reused Stripe customer ${customer.id}`);
  }

  const subscriptionIds: string[] = [];

  // Existing subs for this customer
  const existingSubs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 20 });
  const existingByLookupKey = new Map<string, Stripe.Subscription>();
  for (const s of existingSubs.data) {
    const lk = s.items.data[0]?.price?.lookup_key;
    if (lk && (s.status === 'active' || s.status === 'trialing')) {
      existingByLookupKey.set(lk, s);
    }
  }

  const lookupKeys = [f.primary_price_lookup_key, f.secondary_price_lookup_key].filter((k): k is string => !!k);
  for (const lookupKey of lookupKeys) {
    const existing = existingByLookupKey.get(lookupKey);
    if (existing) {
      console.log(`    reused sub ${existing.id} (${lookupKey})`);
      subscriptionIds.push(existing.id);
      continue;
    }
    const priceList = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    const price = priceList.data[0];
    if (!price) {
      throw new Error(`Stripe test mode is missing price with lookup_key=${lookupKey}. Cannot continue.`);
    }
    // trial_period_days lets us create active-class subs without payment method
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      trial_period_days: 365,
      metadata: { [SANDBOX_TAG]: f.id, aao_sandbox_fixture: 'true' },
    });
    console.log(`    created sub ${sub.id} (${lookupKey}, status=${sub.status})`);
    subscriptionIds.push(sub.id);
  }

  return { customer, subscriptionIds };
}

async function seedDbFixture(
  pool: pg.Pool,
  f: FixtureSpec,
  stripeCustomerId: string,
): Promise<void> {
  const orgId = workosOrgId(f);
  const userId = ownerWorkosUserId(f);
  const email = ownerEmail(f);

  if (!f.link_customer_to_org) {
    // Orphan fixture — no DB org links to this Stripe customer.
    // Still ensure no stale row exists from a previous run.
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id = $1`,
      [orgId],
    );
    console.log(`    no DB org (orphan)`);
    return;
  }

  // upsert user
  await pool.query(
    `INSERT INTO users (workos_user_id, email, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workos_user_id) DO UPDATE SET email = EXCLUDED.email`,
    [userId, email, 'Sandbox', f.id],
  );

  // upsert org
  await pool.query(
    `INSERT INTO organizations (
        workos_organization_id, name, stripe_customer_id, subscription_status, is_personal,
        email_domain, prospect_status
     ) VALUES ($1, $2, $3, $4, $5, $6, NULL)
     ON CONFLICT (workos_organization_id) DO UPDATE SET
       name = EXCLUDED.name,
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       subscription_status = EXCLUDED.subscription_status,
       is_personal = EXCLUDED.is_personal,
       email_domain = EXCLUDED.email_domain,
       updated_at = NOW()`,
    [orgId, orgName(f), stripeCustomerId, f.org_subscription_status, f.is_personal, SANDBOX_EMAIL_DOMAIN],
  );

  if (f.insert_org_membership) {
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, 'owner')
       ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING`,
      [userId, orgId, email, 'Sandbox', f.id],
    );
    console.log(`    DB org=${orgId}, user=${userId}, membership=owner`);
  } else {
    // Ensure no stale membership row exists (some fixtures intentionally
    // simulate "user not in org" in dev-mode WorkOS bypass).
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [userId, orgId],
    );
    console.log(`    DB org=${orgId}, no membership row (simulates WorkOS resolution failure)`);
  }
}

async function teardownStripe(stripe: Stripe): Promise<void> {
  const customers = await stripe.customers.search({
    query: `metadata['aao_sandbox_fixture']:'true'`,
    limit: 100,
  });
  for (const c of customers.data) {
    await stripe.customers.del(c.id);
    console.log(`  deleted Stripe customer ${c.id} (${c.metadata?.[SANDBOX_TAG] ?? 'untagged'})`);
  }
}

async function teardownDb(pool: pg.Pool): Promise<void> {
  const orgIds = FIXTURES.map(workosOrgId);
  const userIds = FIXTURES.map(ownerWorkosUserId);
  await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1::text[])`, [orgIds]);
  await pool.query(`DELETE FROM organizations WHERE workos_organization_id = ANY($1::text[])`, [orgIds]);
  await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1::text[])`, [userIds]);
  console.log('  cleared sandbox rows from organizations, organization_memberships, users');
}

async function main(): Promise<void> {
  const teardown = process.argv.includes('--teardown');

  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  if (!stripeKey.startsWith('sk_test_')) {
    console.error('REFUSING TO RUN: STRIPE_SECRET_KEY is not sk_test_*. The sandbox is for test mode only.');
    process.exit(1);
  }
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });

  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbHost = (() => { try { return new URL(dbUrl).hostname; } catch { return ''; } })();
  if (dbHost && (dbHost.endsWith('.fly.dev') || dbHost.endsWith('.flycast') || dbHost.endsWith('.internal'))) {
    console.error(`REFUSING TO RUN: DATABASE_URL points at ${dbHost}. The sandbox is for local DB only.`);
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    if (teardown) {
      console.log('Tearing down Stripe sandbox customers...');
      await teardownStripe(stripe);
      console.log('Tearing down DB sandbox rows...');
      await teardownDb(pool);
      console.log('Done.');
      return;
    }

    console.log('Setting up sandbox in Stripe TEST mode + local DB...');
    await ensureNonMembershipPrice(stripe);
    for (const f of FIXTURES) {
      console.log(`\nFixture: ${f.id}`);
      console.log(`  ${f.description}`);
      const { customer } = await ensureStripeFixture(stripe, f);
      await seedDbFixture(pool, f, customer.id);
    }
    console.log('\nDone. Inspect with:');
    console.log(`  PGPASSWORD=localdev psql -h localhost -p 58433 -U adcp -d adcp_registry -c "SELECT workos_organization_id, name, subscription_status, stripe_customer_id FROM organizations WHERE name LIKE '${SANDBOX_ORG_PREFIX}%' ORDER BY name;"`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
