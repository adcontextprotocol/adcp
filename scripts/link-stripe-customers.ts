/**
 * Script to link Stripe customers to WorkOS organizations
 *
 * Usage:
 *   npx tsx scripts/link-stripe-customers.ts --dry-run    # Preview matches
 *   npx tsx scripts/link-stripe-customers.ts --apply      # Apply the links
 */

import Stripe from 'stripe';
import { Pool } from 'pg';
import 'dotenv/config';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is required');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const pool = new Pool({ connectionString: DATABASE_URL });

interface StripeCustomerInfo {
  id: string;
  name: string | null;
  email: string | null;
  metadata: Record<string, string>;
  created: number;
  subscriptions?: { total_count: number };
}

interface OrgInfo {
  workos_organization_id: string;
  name: string;
  email_domain: string | null;
  stripe_customer_id: string | null;
}

interface ProposedLink {
  stripe_customer_id: string;
  stripe_name: string | null;
  stripe_email: string | null;
  org_id: string;
  org_name: string;
  match_type: 'exact_name' | 'fuzzy_name' | 'email_domain' | 'manual';
  confidence: 'high' | 'medium' | 'low';
}

function normalizeString(s: string | null): string {
  if (!s) return '';
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '') // Remove special chars
    .replace(/inc$|llc$|ltd$|corp$|corporation$|company$|co$/g, ''); // Remove suffixes
}

function extractDomain(email: string | null): string | null {
  if (!email) return null;
  const match = email.match(/@([^@]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function fuzzyMatch(a: string, b: string): number {
  const normA = normalizeString(a);
  const normB = normalizeString(b);

  if (normA === normB) return 1.0;
  if (normA.includes(normB) || normB.includes(normA)) return 0.8;

  // Simple Levenshtein-based similarity for short strings
  if (normA.length < 3 || normB.length < 3) return 0;

  const longer = normA.length > normB.length ? normA : normB;
  const shorter = normA.length > normB.length ? normB : normA;

  if (longer.startsWith(shorter) || longer.endsWith(shorter)) return 0.7;

  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || !args.includes('--apply');

  console.log(`\n🔗 Stripe Customer Linker ${dryRun ? '(DRY RUN)' : '(APPLYING CHANGES)'}\n`);

  // Fetch all orgs without stripe_customer_id
  const orgsResult = await pool.query<OrgInfo>(`
    SELECT workos_organization_id, name, email_domain, stripe_customer_id
    FROM organizations
    WHERE is_personal = false
    ORDER BY name
  `);

  const orgs = orgsResult.rows;
  const unlinkedOrgs = orgs.filter(o => !o.stripe_customer_id);
  const linkedOrgs = orgs.filter(o => o.stripe_customer_id);

  console.log(`📊 Organizations: ${orgs.length} total, ${linkedOrgs.length} already linked, ${unlinkedOrgs.length} unlinked\n`);

  // Fetch all Stripe customers
  const stripeCustomers: StripeCustomerInfo[] = [];
  console.log('📥 Fetching Stripe customers...');

  for await (const customer of stripe.customers.list({ limit: 100, expand: ['data.subscriptions'] })) {
    stripeCustomers.push({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      metadata: customer.metadata || {},
      created: customer.created,
      subscriptions: customer.subscriptions ? { total_count: customer.subscriptions.data.length } : undefined,
    });
  }

  console.log(`📥 Found ${stripeCustomers.length} Stripe customers\n`);

  // Find customers that are already linked
  const alreadyLinkedCustomerIds = new Set(linkedOrgs.map(o => o.stripe_customer_id).filter(Boolean));
  const unlinkedCustomers = stripeCustomers.filter(c => !alreadyLinkedCustomerIds.has(c.id));

  console.log(`🔍 ${unlinkedCustomers.length} Stripe customers need linking\n`);

  // Try to match unlinked customers to unlinked orgs
  const proposedLinks: ProposedLink[] = [];
  const unmatchedCustomers: StripeCustomerInfo[] = [];

  for (const customer of unlinkedCustomers) {
    let bestMatch: { org: OrgInfo; type: ProposedLink['match_type']; confidence: ProposedLink['confidence'] } | null = null;

    // Try exact name match first
    for (const org of unlinkedOrgs) {
      const score = fuzzyMatch(customer.name || '', org.name);

      if (score === 1.0) {
        bestMatch = { org, type: 'exact_name', confidence: 'high' };
        break;
      } else if (score >= 0.7 && (!bestMatch || bestMatch.confidence !== 'high')) {
        bestMatch = { org, type: 'fuzzy_name', confidence: 'medium' };
      }
    }

    // Try email domain match if no name match
    if (!bestMatch || bestMatch.confidence !== 'high') {
      const customerDomain = extractDomain(customer.email);
      if (customerDomain) {
        for (const org of unlinkedOrgs) {
          if (org.email_domain && org.email_domain.toLowerCase() === customerDomain) {
            if (!bestMatch || bestMatch.confidence === 'low') {
              bestMatch = { org, type: 'email_domain', confidence: 'medium' };
            }
          }
        }
      }
    }

    if (bestMatch) {
      proposedLinks.push({
        stripe_customer_id: customer.id,
        stripe_name: customer.name,
        stripe_email: customer.email,
        org_id: bestMatch.org.workos_organization_id,
        org_name: bestMatch.org.name,
        match_type: bestMatch.type,
        confidence: bestMatch.confidence,
      });
      // Remove from unlinked to prevent duplicate matches
      const idx = unlinkedOrgs.findIndex(o => o.workos_organization_id === bestMatch!.org.workos_organization_id);
      if (idx !== -1) unlinkedOrgs.splice(idx, 1);
    } else {
      unmatchedCustomers.push(customer);
    }
  }

  // Print proposed links
  if (proposedLinks.length > 0) {
    console.log('✅ PROPOSED LINKS:\n');
    console.log('| Stripe Customer | Stripe Name | Org Name | Match Type | Confidence |');
    console.log('|-----------------|-------------|----------|------------|------------|');

    for (const link of proposedLinks) {
      const custId = link.stripe_customer_id.slice(0, 15) + '...';
      const stripeName = (link.stripe_name || 'N/A').slice(0, 20);
      const orgName = link.org_name.slice(0, 20);
      console.log(`| ${custId} | ${stripeName.padEnd(20)} | ${orgName.padEnd(20)} | ${link.match_type.padEnd(12)} | ${link.confidence.padEnd(10)} |`);
    }
    console.log('');
  }

  // Print unmatched customers
  if (unmatchedCustomers.length > 0) {
    console.log(`\n⚠️  UNMATCHED STRIPE CUSTOMERS (${unmatchedCustomers.length}):\n`);
    for (const c of unmatchedCustomers) {
      const hasSubs = c.subscriptions && c.subscriptions.total_count > 0;
      console.log(`  ${c.id}: "${c.name || 'No name'}" <${c.email || 'no email'}> ${hasSubs ? '(HAS SUBSCRIPTIONS)' : ''}`);
    }
    console.log('');
  }

  // Print remaining unlinked orgs
  if (unlinkedOrgs.length > 0) {
    console.log(`\n📋 REMAINING UNLINKED ORGS (${unlinkedOrgs.length}):\n`);
    for (const o of unlinkedOrgs.slice(0, 20)) {
      console.log(`  ${o.workos_organization_id}: "${o.name}" (domain: ${o.email_domain || 'none'})`);
    }
    if (unlinkedOrgs.length > 20) {
      console.log(`  ... and ${unlinkedOrgs.length - 20} more`);
    }
    console.log('');
  }

  // Apply changes if not dry run
  if (!dryRun && proposedLinks.length > 0) {
    console.log('\n🚀 Applying links...\n');

    let applied = 0;
    let failed = 0;

    for (const link of proposedLinks) {
      try {
        await pool.query(
          'UPDATE organizations SET stripe_customer_id = $1 WHERE workos_organization_id = $2',
          [link.stripe_customer_id, link.org_id]
        );
        console.log(`  ✅ Linked ${link.stripe_customer_id} → ${link.org_name}`);
        applied++;
      } catch (err) {
        console.log(`  ❌ Failed to link ${link.stripe_customer_id}: ${err}`);
        failed++;
      }
    }

    console.log(`\n📊 Applied ${applied} links, ${failed} failed\n`);
    console.log('Run "Sync from Stripe" in the admin panel to pull revenue data.\n');
  } else if (proposedLinks.length > 0) {
    console.log('\n💡 Run with --apply to apply these links\n');
  }

  await pool.end();
}

main().catch(console.error);
