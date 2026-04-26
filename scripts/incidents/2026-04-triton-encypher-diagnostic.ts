/**
 * Read-only diagnostic for the Triton/Encypher cross-contamination incident
 * (Apr 2026). One-off; preserved for audit / reference. Output contains PII
 * (Stripe customer emails, names, metadata) — do not paste into shared
 * issues, docs, or Slack channels without redaction.
 *
 * Background: Triton Digital paid $10K but is on Builder ($3K) tier; the
 * subscription was created using `erik.svilich@encypher.com` (a different
 * org's contact). Encypher's prospect_contact_email is set to
 * `benjamin.masse@tritondigital.com`. We need a clean view of state before
 * deciding how to unwind.
 *
 * This script writes nothing. It prints a markdown summary.
 *
 * What it queries:
 *   - Stripe (always): customer cus_TaW7BurSnlPAOy plus customers found by
 *     each suspect email; subscriptions, invoices, charges for each.
 *   - Admin API (if ADMIN_BASE_URL + ADMIN_API_KEY): per-org row, members,
 *     payment history. This is the prod-safe path — no DB connection needed.
 *   - Direct DB (if DATABASE_URL is set AND admin API isn't): fallback for
 *     local development.
 *   - WorkOS (if WORKOS_API_KEY): org memberships for cross-checks.
 *
 * Usage (prod, the typical path):
 *   STRIPE_SECRET_KEY=sk_live_... \
 *   ADMIN_BASE_URL=https://agenticadvertising.org \
 *   ADMIN_API_KEY=... \
 *   npx tsx scripts/diagnose-triton-encypher.ts
 *
 * Usage (Stripe only — fastest, sees the money):
 *   STRIPE_SECRET_KEY=sk_live_... \
 *   npx tsx scripts/diagnose-triton-encypher.ts
 *
 * Optional env:
 *   TRITON_ORG_ID        - default: org_01KC80TYK2QPPWQ7A8SGGGNHE7
 *   TRITON_STRIPE_CUST   - default: cus_TaW7BurSnlPAOy
 *   ENCYPHER_QUERY       - name search for Encypher (default: "Encypher")
 */

import Stripe from 'stripe';
import { Pool } from 'pg';
import { WorkOS } from '@workos-inc/node';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL?.replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const WORKOS_API_KEY = process.env.WORKOS_API_KEY;
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID;

const TRITON_ORG_ID = process.env.TRITON_ORG_ID || 'org_01KC80TYK2QPPWQ7A8SGGGNHE7';
const TRITON_STRIPE_CUST = process.env.TRITON_STRIPE_CUST || 'cus_TaW7BurSnlPAOy';
const ENCYPHER_QUERY = process.env.ENCYPHER_QUERY || 'Encypher';

if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY not set');
  process.exit(1);
}

const useAdminApi = !!(ADMIN_BASE_URL && ADMIN_API_KEY);
const useDb = !useAdminApi && !!DATABASE_URL;
const useWorkos = !!(WORKOS_API_KEY && WORKOS_CLIENT_ID);

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
});
const pool = useDb ? new Pool({ connectionString: DATABASE_URL }) : null;
const workos = useWorkos
  ? new WorkOS(WORKOS_API_KEY!, { clientId: WORKOS_CLIENT_ID! })
  : null;

async function adminFetch<T = unknown>(path: string): Promise<T | { error: string }> {
  try {
    const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${ADMIN_API_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return { error: `${res.status} ${res.statusText} on ${path}` };
    }
    return (await res.json()) as T;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function fmtCents(cents: number | null | undefined, currency = 'usd'): string {
  if (cents == null) return 'null';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function fmtDate(unix: number | null | undefined): string {
  if (!unix) return 'null';
  return new Date(unix * 1000).toISOString();
}

interface OrgSnapshot {
  workos_organization_id: string;
  name: string;
  membership_tier: string | null;
  subscription_status: string | null;
  subscription_amount: number | null;
  subscription_interval: string | null;
  subscription_current_period_end: string | Date | null;
  subscription_canceled_at: string | Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_coupon_id: string | null;
  stripe_promotion_code: string | null;
  prospect_contact_email: string | null;
  prospect_contact_name: string | null;
  pending_agreement_user_id: string | null;
  pending_agreement_version: string | null;
  is_personal: boolean;
  members?: Array<{ id: string; email: string | null; firstName: string | null; lastName: string | null; role?: string }>;
}

async function loadOrgById(orgId: string): Promise<OrgSnapshot | null> {
  if (useAdminApi) {
    const json = await adminFetch<Record<string, unknown> & { error?: string }>(`/api/admin/accounts/${orgId}`);
    if ('error' in json && json.error) return null;
    const o = json as Record<string, unknown>;
    return {
      workos_organization_id: String(o.workos_organization_id ?? orgId),
      name: String(o.name ?? ''),
      membership_tier: (o.membership_tier as string | null) ?? null,
      subscription_status: (o.subscription_status as string | null) ?? null,
      subscription_amount: (o.subscription_amount as number | null) ?? null,
      subscription_interval: (o.subscription_interval as string | null) ?? null,
      subscription_current_period_end: (o.subscription_current_period_end as string | null) ?? null,
      subscription_canceled_at: (o.subscription_canceled_at as string | null) ?? null,
      stripe_customer_id: (o.stripe_customer_id as string | null) ?? null,
      stripe_subscription_id: (o.stripe_subscription_id as string | null) ?? null,
      stripe_coupon_id: (o.stripe_coupon_id as string | null) ?? null,
      stripe_promotion_code: (o.stripe_promotion_code as string | null) ?? null,
      prospect_contact_email: (o.prospect_contact_email as string | null) ?? null,
      prospect_contact_name: (o.prospect_contact_name as string | null) ?? null,
      pending_agreement_user_id: (o.pending_agreement_user_id as string | null) ?? null,
      pending_agreement_version: (o.pending_agreement_version as string | null) ?? null,
      is_personal: Boolean(o.is_personal),
      members: (o.members as OrgSnapshot['members']) ?? undefined,
    };
  }
  if (pool) {
    const result = await pool.query<OrgSnapshot>(
      `SELECT workos_organization_id, name, membership_tier, subscription_status,
              subscription_amount, subscription_interval,
              subscription_current_period_end, subscription_canceled_at,
              stripe_customer_id, stripe_subscription_id,
              stripe_coupon_id, stripe_promotion_code,
              prospect_contact_email, prospect_contact_name,
              pending_agreement_user_id, pending_agreement_version,
              is_personal
         FROM organizations WHERE workos_organization_id = $1`,
      [orgId],
    );
    return result.rows[0] || null;
  }
  return null;
}

async function findOrgByName(query: string): Promise<Array<{ workos_organization_id: string; name: string }>> {
  if (useAdminApi) {
    const json = await adminFetch<{ accounts?: Array<{ workos_organization_id: string; name: string }> }>(
      `/api/admin/accounts?view=all&search=${encodeURIComponent(query)}&limit=10`,
    );
    if ('error' in json) return [];
    return json.accounts ?? [];
  }
  if (pool) {
    const result = await pool.query<{ workos_organization_id: string; name: string }>(
      `SELECT workos_organization_id, name FROM organizations
         WHERE LOWER(name) LIKE LOWER($1)
         ORDER BY name LIMIT 10`,
      [`%${query}%`],
    );
    return result.rows;
  }
  return [];
}

async function findOrgsByProspectEmail(email: string): Promise<Array<{ workos_organization_id: string; name: string; prospect_contact_email: string | null }>> {
  if (useDb && pool) {
    const result = await pool.query<{ workos_organization_id: string; name: string; prospect_contact_email: string | null }>(
      `SELECT workos_organization_id, name, prospect_contact_email
         FROM organizations
         WHERE LOWER(prospect_contact_email) = LOWER($1)`,
      [email],
    );
    return result.rows;
  }
  // No equivalent admin endpoint for this query; skip.
  return [];
}

async function loadWorkosMemberships(orgId: string) {
  if (!workos) return [];
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId: orgId,
    });
    return memberships.data.map((m) => ({
      user_id: m.userId,
      role: m.role?.slug || 'member',
      status: m.status,
    }));
  } catch (err) {
    return [{ error: (err as Error).message }];
  }
}

async function loadStripeCustomerById(customerId: string) {
  try {
    const cust = await stripe.customers.retrieve(customerId);
    if ('deleted' in cust && cust.deleted) {
      return { id: customerId, deleted: true };
    }
    return cust as Stripe.Customer;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function loadStripeCustomersByEmail(email: string) {
  try {
    const result = await stripe.customers.list({ email, limit: 10 });
    return result.data;
  } catch (err) {
    return [{ error: (err as Error).message } as unknown as Stripe.Customer];
  }
}

async function loadStripeSubscriptions(customerId: string) {
  try {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    });
    return subs.data;
  } catch (err) {
    return [{ error: (err as Error).message } as unknown as Stripe.Subscription];
  }
}

async function loadStripeInvoices(customerId: string) {
  try {
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 20,
    });
    return invoices.data;
  } catch (err) {
    return [{ error: (err as Error).message } as unknown as Stripe.Invoice];
  }
}

async function loadStripeCharges(customerId: string) {
  try {
    const charges = await stripe.charges.list({
      customer: customerId,
      limit: 20,
    });
    return charges.data;
  } catch (err) {
    return [{ error: (err as Error).message } as unknown as Stripe.Charge];
  }
}

function fmtMaybeDate(value: string | Date | null | undefined): string {
  if (!value) return 'null';
  if (value instanceof Date) return value.toISOString();
  return value;
}

function reportOrgRow(label: string, org: OrgSnapshot | null) {
  console.log(`\n## ${label}\n`);
  if (!org) {
    console.log('_Not found (no admin API or DB available, or org not in source)._\n');
    return;
  }
  console.log('### Org row');
  console.log(`- workos_organization_id: \`${org.workos_organization_id}\``);
  console.log(`- name: \`${org.name}\``);
  console.log(`- membership_tier: \`${org.membership_tier ?? 'null'}\``);
  console.log(`- subscription_status: \`${org.subscription_status ?? 'null'}\``);
  console.log(`- subscription_amount: ${fmtCents(org.subscription_amount)}`);
  console.log(`- subscription_interval: \`${org.subscription_interval ?? 'null'}\``);
  console.log(`- subscription_current_period_end: ${fmtMaybeDate(org.subscription_current_period_end)}`);
  console.log(`- subscription_canceled_at: ${fmtMaybeDate(org.subscription_canceled_at)}`);
  console.log(`- stripe_customer_id: \`${org.stripe_customer_id ?? 'null'}\``);
  console.log(`- stripe_subscription_id: \`${org.stripe_subscription_id ?? 'null'}\``);
  console.log(`- stripe_coupon_id: \`${org.stripe_coupon_id ?? 'null'}\``);
  console.log(`- stripe_promotion_code: \`${org.stripe_promotion_code ?? 'null'}\``);
  console.log(`- prospect_contact_email: \`${org.prospect_contact_email ?? 'null'}\``);
  console.log(`- prospect_contact_name: \`${org.prospect_contact_name ?? 'null'}\``);
  console.log(`- pending_agreement_user_id: \`${org.pending_agreement_user_id ?? 'null'}\``);
  console.log(`- pending_agreement_version: \`${org.pending_agreement_version ?? 'null'}\``);
  console.log(`- is_personal: ${org.is_personal}`);
}

async function reportMembers(org: OrgSnapshot) {
  const members = org.members ?? [];
  const workosMembers = await loadWorkosMemberships(org.workos_organization_id);

  console.log(`\n### Members (Org: ${members.length}${useWorkos ? `; WorkOS: ${workosMembers.length}` : ''})`);
  for (const m of members) {
    const name = [m.firstName, m.lastName].filter(Boolean).join(' ') || '(no name)';
    console.log(`- ${name} <${m.email ?? 'no email'}> (\`${m.id}\`) role=${m.role ?? 'member'}`);
  }
  if (useWorkos && workosMembers.length !== members.length) {
    console.log(`\n_Org-row ↔ WorkOS membership count mismatch._`);
    for (const wm of workosMembers) {
      console.log(`  - WorkOS: ${JSON.stringify(wm)}`);
    }
  }
}

async function reportStripeCustomer(customerId: string | null) {
  if (!customerId) {
    console.log('\n### Stripe customer\n_No stripe_customer_id on the org._');
    return;
  }
  console.log(`\n### Stripe customer \`${customerId}\``);
  const cust = await loadStripeCustomerById(customerId);
  if ('error' in cust) {
    console.log(`_Error: ${cust.error}_`);
    return;
  }
  if ('deleted' in cust && cust.deleted) {
    console.log('_Customer is deleted._');
    return;
  }
  const c = cust as Stripe.Customer;
  console.log(`- email: \`${c.email ?? 'null'}\``);
  console.log(`- name: \`${c.name ?? 'null'}\``);
  console.log(`- balance: ${fmtCents(c.balance, c.currency || 'usd')}`);
  console.log(`- metadata: ${JSON.stringify(c.metadata)}`);
  console.log(`- created: ${fmtDate(c.created)}`);
}

async function reportSubscriptions(customerId: string) {
  const subs = await loadStripeSubscriptions(customerId);
  console.log(`\n### Stripe subscriptions (${subs.length})`);
  for (const sub of subs) {
    if ('error' in sub) {
      console.log(`- _error: ${(sub as unknown as { error: string }).error}_`);
      continue;
    }
    const item = sub.items.data[0];
    const price = item?.price;
    console.log(`- \`${sub.id}\``);
    console.log(`  - status: \`${sub.status}\``);
    console.log(`  - price.lookup_key: \`${price?.lookup_key ?? 'null'}\``);
    console.log(`  - price.unit_amount: ${fmtCents(price?.unit_amount, price?.currency || 'usd')}`);
    console.log(`  - price.recurring.interval: \`${price?.recurring?.interval ?? 'null'}\``);
    console.log(`  - current_period_end: ${fmtDate(sub.current_period_end)}`);
    console.log(`  - canceled_at: ${fmtDate(sub.canceled_at)}`);
    console.log(`  - cancel_at_period_end: ${sub.cancel_at_period_end}`);
    console.log(`  - metadata: ${JSON.stringify(sub.metadata)}`);
  }
}

async function reportInvoices(customerId: string) {
  const invoices = await loadStripeInvoices(customerId);
  console.log(`\n### Stripe invoices (${invoices.length})`);
  for (const inv of invoices) {
    if ('error' in inv) {
      console.log(`- _error: ${(inv as unknown as { error: string }).error}_`);
      continue;
    }
    const lineItem = inv.lines.data[0];
    const lookup = (lineItem?.price as { lookup_key?: string } | undefined)?.lookup_key;
    console.log(`- \`${inv.id}\` (${inv.number ?? 'no number'})`);
    console.log(`  - status: \`${inv.status}\``);
    console.log(`  - amount_due: ${fmtCents(inv.amount_due, inv.currency)}`);
    console.log(`  - amount_paid: ${fmtCents(inv.amount_paid, inv.currency)}`);
    console.log(`  - subscription: \`${(inv.subscription as string) ?? 'none'}\``);
    console.log(`  - line lookup_key: \`${lookup ?? 'null'}\``);
    console.log(`  - created: ${fmtDate(inv.created)}`);
    console.log(`  - period: ${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}`);
    console.log(`  - paid_at: ${fmtDate(inv.status_transitions.paid_at)}`);
  }
}

async function reportCharges(customerId: string) {
  const charges = await loadStripeCharges(customerId);
  // Filter to charges not tied to an invoice/subscription (the "one-time" $10K hypothesis).
  console.log(`\n### Stripe charges (${charges.length})`);
  for (const ch of charges) {
    if ('error' in ch) {
      console.log(`- _error: ${(ch as unknown as { error: string }).error}_`);
      continue;
    }
    console.log(`- \`${ch.id}\``);
    console.log(`  - status: \`${ch.status}\``);
    console.log(`  - amount: ${fmtCents(ch.amount, ch.currency)}`);
    console.log(`  - amount_refunded: ${fmtCents(ch.amount_refunded, ch.currency)}`);
    console.log(`  - invoice: \`${(ch.invoice as string) ?? 'none'}\``);
    console.log(`  - description: \`${ch.description ?? 'null'}\``);
    console.log(`  - created: ${fmtDate(ch.created)}`);
  }
}

async function reportOrg(label: string, org: OrgSnapshot | null) {
  reportOrgRow(label, org);
  if (!org) return;
  await reportMembers(org);

  // Try the configured stripe_customer_id first
  if (org.stripe_customer_id) {
    await reportStripeCustomer(org.stripe_customer_id);
    await reportSubscriptions(org.stripe_customer_id);
    await reportInvoices(org.stripe_customer_id);
    await reportCharges(org.stripe_customer_id);
  } else {
    console.log('\n### Stripe customer\n_No stripe_customer_id on org row._');
  }

  // Also look up by prospect contact email — finds ghost customers created
  // under the wrong identity.
  if (org.prospect_contact_email) {
    console.log(`\n### Stripe customers found by prospect_contact_email \`${org.prospect_contact_email}\``);
    const byEmail = await loadStripeCustomersByEmail(org.prospect_contact_email);
    if (byEmail.length === 0) {
      console.log('_None._');
    } else {
      for (const c of byEmail) {
        if ('error' in c) {
          console.log(`- _error: ${(c as unknown as { error: string }).error}_`);
          continue;
        }
        console.log(`- \`${c.id}\` email=\`${c.email}\` name=\`${c.name ?? 'null'}\` metadata=${JSON.stringify(c.metadata)}`);
      }
    }
  }
}

async function reportStripeOnlyForCustomer(label: string, customerId: string) {
  console.log(`\n## ${label}`);
  await reportStripeCustomer(customerId);
  await reportSubscriptions(customerId);
  await reportInvoices(customerId);
  await reportCharges(customerId);
}

async function reportStripeForEmail(email: string) {
  console.log(`\n## Stripe customers for \`${email}\``);
  const byEmail = await loadStripeCustomersByEmail(email);
  if (byEmail.length === 0) {
    console.log('_None._');
    return;
  }
  for (const c of byEmail) {
    if ('error' in c) {
      console.log(`- _error: ${(c as unknown as { error: string }).error}_`);
      continue;
    }
    console.log(`\n### \`${c.id}\``);
    console.log(`- email: \`${c.email ?? 'null'}\``);
    console.log(`- name: \`${c.name ?? 'null'}\``);
    console.log(`- metadata: ${JSON.stringify(c.metadata)}`);
    console.log(`- created: ${fmtDate(c.created)}`);
    await reportSubscriptions(c.id);
    await reportInvoices(c.id);
    await reportCharges(c.id);
  }
}

async function main() {
  console.log(`# Triton/Encypher diagnostic — ${new Date().toISOString()}`);
  console.log(`\n_Read-only. No writes performed._`);
  console.log(`\nSources: Stripe ✓` +
    (useAdminApi ? `; Admin API \`${ADMIN_BASE_URL}\` ✓` : '') +
    (useDb ? '; direct DB ✓' : '') +
    (useWorkos ? '; WorkOS ✓' : ''));

  // ─── Stripe-first Triton probe ─────────────────────────────────────────
  // Money state is the most decision-relevant. Run this even when we have
  // no DB / admin API.
  await reportStripeOnlyForCustomer(
    `Triton Stripe customer \`${TRITON_STRIPE_CUST}\` (from incident report)`,
    TRITON_STRIPE_CUST,
  );

  // Probe Stripe customers under each suspect email — these are the ghost
  // customers the broken admin path could have created.
  await reportStripeForEmail('erik.svilich@encypher.com');
  await reportStripeForEmail('benjamin.masse@tritondigital.com');

  // ─── Org-level state (admin API or DB) ──────────────────────────────────
  if (useAdminApi || useDb) {
    let tritonOrg = await loadOrgById(TRITON_ORG_ID);
    if (!tritonOrg) {
      const candidates = await findOrgByName('Triton');
      console.log(`\n## Triton — could not load org by id \`${TRITON_ORG_ID}\``);
      console.log(`Found ${candidates.length} orgs by name search:`);
      for (const c of candidates) {
        console.log(`- \`${c.workos_organization_id}\` ${c.name}`);
      }
      if (candidates.length === 1) {
        tritonOrg = await loadOrgById(candidates[0].workos_organization_id);
      }
    }
    if (tritonOrg) {
      await reportOrg(`Triton org — \`${tritonOrg.workos_organization_id}\``, tritonOrg);
      // If the org row points to a *different* Stripe customer than the one in
      // the incident report, the disconnect is itself the smoking gun.
      if (tritonOrg.stripe_customer_id && tritonOrg.stripe_customer_id !== TRITON_STRIPE_CUST) {
        console.log(`\n_⚠ Org row stripe_customer_id (\`${tritonOrg.stripe_customer_id}\`) ≠ incident-report customer (\`${TRITON_STRIPE_CUST}\`)._`);
      }
    }

    const encypherCandidates = await findOrgByName(ENCYPHER_QUERY);
    console.log(`\n## Encypher — name search \`${ENCYPHER_QUERY}\` found ${encypherCandidates.length} org(s)`);
    for (const c of encypherCandidates) {
      console.log(`- \`${c.workos_organization_id}\` ${c.name}`);
    }
    for (const ec of encypherCandidates) {
      const full = await loadOrgById(ec.workos_organization_id);
      await reportOrg(`Encypher org — \`${ec.workos_organization_id}\``, full);
    }

    // Cross-org contamination probe — only meaningful with DB access today.
    if (useDb) {
      console.log(`\n## Cross-org contamination probe`);
      for (const email of ['benjamin.masse@tritondigital.com', 'erik.svilich@encypher.com']) {
        const orgs = await findOrgsByProspectEmail(email);
        console.log(`\n### Orgs with prospect_contact_email = \`${email}\``);
        if (orgs.length === 0) {
          console.log('_None._');
        } else {
          for (const o of orgs) {
            console.log(`- \`${o.workos_organization_id}\` ${o.name} (${o.prospect_contact_email})`);
          }
        }
      }
    }
  } else {
    console.log(`\n## Org-level state\n_Skipped — no ADMIN_BASE_URL+ADMIN_API_KEY and no DATABASE_URL. Stripe data above is what we have._`);
  }

  if (pool) await pool.end();
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
