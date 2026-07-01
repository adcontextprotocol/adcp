/**
 * Daily audit of orphaned prospect organizations.
 *
 * "Orphaned" = a non-personal org with no email_domain, no subscription, no
 * members, but evidence of having gone through a sales/discovery path (Stripe
 * customer, prospect_source, prospect_status, or prospect_contact_email). Real-
 * world driver: Voise Tech Ltd was created 2026-02-13 with a Stripe customer
 * and zero email_domain, sat invisible for 80 days while @voisetech.com
 * employees signed up to personal workspaces because findPayingOrgForDomain
 * (org-filters.ts:438-454) couldn't auto-link them.
 *
 * Migration 468 backfilled the existing population; the at-INSERT hardening
 * stops new ones being created. This audit is the durable safety net: if a
 * future code path reintroduces the leak, this job surfaces it within a day
 * instead of months later when a customer emails about a "broken Stripe link."
 */

import { getPool } from '../../db/client.js';
import { getProspectChannel, getAdminChannel } from '../../db/system-settings-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('orphan-org-audit');

export interface OrphanOrg {
  workos_organization_id: string;
  name: string;
  created_at: Date;
  has_stripe_customer: boolean;
  prospect_source: string | null;
  prospect_status: string | null;
  prospect_contact_email: string | null;
}

export interface OrphanOrgAuditResult {
  total: number;
  newSinceLastAudit: number;
  oldestCreatedAt: Date | null;
  examples: OrphanOrg[];
  summaryPosted: boolean;
}

/**
 * Find non-personal orgs that are missing the auto-link prerequisites yet show
 * signs of a sales/discovery touch. Limited to a representative sample so we
 * can show admins something actionable without flooding the channel.
 */
async function findOrphans(limit = 25): Promise<OrphanOrg[]> {
  const pool = getPool();
  const result = await pool.query<{
    workos_organization_id: string;
    name: string;
    created_at: Date;
    has_stripe_customer: boolean;
    prospect_source: string | null;
    prospect_status: string | null;
    prospect_contact_email: string | null;
  }>(
    `SELECT
       o.workos_organization_id,
       o.name,
       o.created_at,
       (o.stripe_customer_id IS NOT NULL) AS has_stripe_customer,
       o.prospect_source,
       o.prospect_status,
       o.prospect_contact_email
     FROM organizations o
     LEFT JOIN organization_memberships m
       ON m.workos_organization_id = o.workos_organization_id
     WHERE o.is_personal = FALSE
       AND (o.email_domain IS NULL OR o.email_domain = '')
       AND o.subscription_status IS NULL
       AND m.workos_user_id IS NULL
       AND (o.stripe_customer_id IS NOT NULL
            OR o.prospect_source IS NOT NULL
            OR o.prospect_status IS NOT NULL
            OR o.prospect_contact_email IS NOT NULL)
     GROUP BY o.workos_organization_id
     ORDER BY o.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function countAll(): Promise<{ total: number; oldest: Date | null }> {
  const pool = getPool();
  const result = await pool.query<{ total: string; oldest: Date | null }>(
    `SELECT COUNT(DISTINCT o.workos_organization_id)::text AS total,
            MIN(o.created_at) AS oldest
     FROM organizations o
     LEFT JOIN organization_memberships m
       ON m.workos_organization_id = o.workos_organization_id
     WHERE o.is_personal = FALSE
       AND (o.email_domain IS NULL OR o.email_domain = '')
       AND o.subscription_status IS NULL
       AND m.workos_user_id IS NULL
       AND (o.stripe_customer_id IS NOT NULL
            OR o.prospect_source IS NOT NULL
            OR o.prospect_status IS NOT NULL
            OR o.prospect_contact_email IS NOT NULL)`,
  );
  const row = result.rows[0];
  return { total: Number(row?.total ?? 0), oldest: row?.oldest ?? null };
}

async function countNewSince(since: Date): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(DISTINCT o.workos_organization_id)::text AS n
     FROM organizations o
     LEFT JOIN organization_memberships m
       ON m.workos_organization_id = o.workos_organization_id
     WHERE o.is_personal = FALSE
       AND (o.email_domain IS NULL OR o.email_domain = '')
       AND o.subscription_status IS NULL
       AND m.workos_user_id IS NULL
       AND o.created_at >= $1
       AND (o.stripe_customer_id IS NOT NULL
            OR o.prospect_source IS NOT NULL
            OR o.prospect_status IS NOT NULL
            OR o.prospect_contact_email IS NOT NULL)`,
    [since],
  );
  return Number(result.rows[0]?.n ?? 0);
}

function formatExamples(examples: OrphanOrg[]): string[] {
  return examples.slice(0, 10).map((o) => {
    const sourceBits = [
      o.has_stripe_customer ? 'stripe' : null,
      o.prospect_source,
      o.prospect_contact_email ? 'has-contact' : null,
    ].filter(Boolean);
    const ageDays = Math.floor((Date.now() - o.created_at.getTime()) / 86400000);
    return `• \`${o.workos_organization_id}\` "${o.name}" — ${ageDays}d old, ${sourceBits.join(', ')}`;
  });
}

export async function runOrphanOrgAudit(): Promise<OrphanOrgAuditResult> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [counts, examples, newSinceLastAudit] = await Promise.all([
    countAll(),
    findOrphans(),
    countNewSince(since),
  ]);

  const result: OrphanOrgAuditResult = {
    total: counts.total,
    newSinceLastAudit,
    oldestCreatedAt: counts.oldest,
    examples,
    summaryPosted: false,
  };

  logger.info(
    {
      event: 'orphan_org_audit',
      total: result.total,
      newSinceLastAudit: result.newSinceLastAudit,
      oldestCreatedAt: result.oldestCreatedAt,
    },
    `Orphan org audit: ${result.total} total, ${result.newSinceLastAudit} new in last 24h`,
  );

  if (result.total === 0) {
    return result;
  }

  // Slack alert when there are any orphans, OR specifically when fresh ones
  // appeared in the last 24 hours (a regression signal — at-INSERT hardening
  // is supposed to prevent this entirely).
  const prospect = await getProspectChannel();
  const admin = await getAdminChannel();
  const channelId = prospect.channel_id || admin.channel_id;
  if (!channelId) return result;

  const lines: string[] = [
    `:warning: *Orphan org audit* — ${result.total} prospect org(s) cannot auto-link signups`,
  ];
  if (result.newSinceLastAudit > 0) {
    lines.push(
      `*${result.newSinceLastAudit} appeared in the last 24h* — likely a regression in at-INSERT hardening (admin/domains.ts or createOrganization).`,
    );
  }
  if (result.oldestCreatedAt) {
    const ageDays = Math.floor((Date.now() - result.oldestCreatedAt.getTime()) / 86400000);
    lines.push(`Oldest: ${ageDays}d old.`);
  }
  if (result.examples.length > 0) {
    lines.push('', '*Sample* (oldest first):');
    lines.push(...formatExamples(result.examples));
  }
  lines.push(
    '',
    'These rows have a Stripe customer / prospect_source but no email_domain — `findPayingOrgForDomain` cannot link future @domain signups. Backfill `email_domain` and a verified `organization_domains` row to unblock.',
  );

  const sendResult = await sendChannelMessage(channelId, { text: lines.join('\n') });
  result.summaryPosted = sendResult.ok;
  return result;
}
