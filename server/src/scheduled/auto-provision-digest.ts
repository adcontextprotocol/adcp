/**
 * Daily digest of new auto-provisioned members for org owners/admins.
 *
 * Why this exists: with `auto_provision_verified_domain` defaulting to ON,
 * the policy quietly grows org membership when a verified-domain email signs
 * in. Without a notification, owners have no signal that their seat list is
 * changing — exactly the SOC2-flavored finding the adtech-product reviewer
 * flagged on the original PR. This is the consent receipt: every org that had
 * auto-joined members since its last digest gets a Slack message listing
 * them, with a link to the team page where the owner can review or flip the
 * toggle off.
 *
 * Mechanics:
 *  - Watermark per org (`organizations.last_auto_provision_digest_sent_at`).
 *  - Once a day, find orgs with at least one verified-domain membership
 *    created since the watermark. Skip silently if zero.
 *  - Send a Slack DM/group-DM to the org's admin/owner cluster (matches the
 *    existing seat-request reminder dispatch pattern).
 *  - Mark the org as digested only after a successful send so failures retry.
 */

import { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import {
  findOrgsWithNewAutoProvisionedMembers,
  listNewAutoProvisionedMembers,
  markAutoProvisionDigestSent,
  type NewAutoProvisionedMember,
} from '../db/membership-db.js';
import { sendToOrgAdmins, escapeSlackMrkdwn } from '../slack/org-group-dm.js';
import { getOrgAdminEmails } from '../utils/org-admins.js';

const logger = createLogger('auto-provision-digest');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';
// Run once a day. The watermark column is the per-org cooldown — a fresh
// candidate set with non-zero new members triggers a send for that org.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Initial delay so the job doesn't fire during boot's noisy window.
const INITIAL_DELAY_MS = 5 * 60 * 1000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let initialTimeoutId: ReturnType<typeof setTimeout> | null = null;

export function startAutoProvisionDigest(workos: WorkOS): void {
  if (intervalId || initialTimeoutId) return;

  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    runDigest(workos).catch(err =>
      logger.error({ err }, 'Auto-provision digest failed'),
    );
    intervalId = setInterval(() => {
      runDigest(workos).catch(err =>
        logger.error({ err }, 'Auto-provision digest failed'),
      );
    }, CHECK_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info('Auto-provision digest scheduler started');
}

export function stopAutoProvisionDigest(): void {
  if (initialTimeoutId) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * One pass: find candidate orgs, send a digest to each, mark sent.
 * Exported for tests + manual invocation from incident scripts.
 */
export async function runDigest(workos: WorkOS): Promise<{
  candidateOrgs: number;
  delivered: number;
  skipped: number;
  failed: number;
}> {
  const candidates = await findOrgsWithNewAutoProvisionedMembers();
  let delivered = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const members = await listNewAutoProvisionedMembers(
        candidate.workos_organization_id,
        candidate.last_sent_at,
      );
      if (members.length === 0) {
        // Race: members were removed between findOrgs and list. Skip silently.
        skipped++;
        continue;
      }

      const adminEmails = await getOrgAdminEmails(workos, candidate.workos_organization_id);
      if (adminEmails.length === 0) {
        // No admins/owners to notify. Don't update watermark — try again next
        // run, in case an admin gets added.
        logger.info(
          { orgId: candidate.workos_organization_id, memberCount: members.length },
          'Auto-provision digest: no admins to notify, deferring',
        );
        skipped++;
        continue;
      }

      const message = buildSlackMessage(candidate.org_name, candidate.workos_organization_id, members);
      const sent = await sendToOrgAdmins(
        candidate.workos_organization_id,
        adminEmails,
        message,
      );

      if (sent) {
        await markAutoProvisionDigestSent(candidate.workos_organization_id);
        delivered++;
        logger.info(
          {
            orgId: candidate.workos_organization_id,
            memberCount: members.length,
            adminEmailCount: adminEmails.length,
          },
          'Auto-provision digest delivered',
        );
      } else {
        // Slack delivery failed (no admins on Slack, channel issue, etc.). Don't
        // mark watermark so the next run retries; future Slack-mapped admins
        // will pick it up.
        skipped++;
        logger.info(
          { orgId: candidate.workos_organization_id, memberCount: members.length },
          'Auto-provision digest: slack delivery skipped',
        );
      }
    } catch (err) {
      failed++;
      logger.warn(
        { err, orgId: candidate.workos_organization_id },
        'Auto-provision digest failed for org',
      );
    }
  }

  if (candidates.length > 0) {
    logger.info(
      { candidateOrgs: candidates.length, delivered, skipped, failed },
      'Auto-provision digest pass complete',
    );
  }

  return { candidateOrgs: candidates.length, delivered, skipped, failed };
}

function buildSlackMessage(
  orgName: string,
  orgId: string,
  members: NewAutoProvisionedMember[],
): { text: string; blocks: any[] } {
  const teamUrl = `${APP_URL}/team?org=${orgId}`;
  const memberLines = members.map(m => {
    const displayName = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
    const namePart = displayName ? `${escapeSlackMrkdwn(displayName)} (${escapeSlackMrkdwn(m.email)})` : escapeSlackMrkdwn(m.email);
    const date = m.joined_at instanceof Date
      ? m.joined_at.toISOString().slice(0, 10)
      : String(m.joined_at).slice(0, 10);
    return `• ${namePart} — joined ${date}`;
  });

  const summary = members.length === 1
    ? `1 person joined *${escapeSlackMrkdwn(orgName)}* via verified-domain auto-add since the last digest.`
    : `${members.length} people joined *${escapeSlackMrkdwn(orgName)}* via verified-domain auto-add since the last digest.`;

  return {
    text: `${members.length} new auto-joined member${members.length === 1 ? '' : 's'} in ${orgName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${summary}\n\n${memberLines.join('\n')}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${teamUrl}|Review or change roles> · turn auto-add off in the *Verified Domains* card on the same page if you'd rather invite explicitly.`,
        },
      },
    ],
  };
}
