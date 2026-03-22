/**
 * Credential Digest Job
 *
 * Posts a weekly summary of credential awards to the certification Slack channel.
 * Tier 3 (Specialist) credentials are posted immediately at award time.
 * This job aggregates all awards from the past 7 days for the weekly digest.
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import { sendChannelMessage } from '../../slack/client.js';
import { getChannelByName } from '../../db/notification-channels-db.js';

interface CredentialAward {
  first_name: string;
  last_name: string;
  credential_name: string;
  tier: number;
  awarded_at: string;
}

/**
 * Get credential awards from the last 7 days.
 */
async function getRecentAwards(): Promise<CredentialAward[]> {
  const result = await query<CredentialAward>(
    `SELECT u.first_name, u.last_name, cc.name AS credential_name, cc.tier, uc.awarded_at
     FROM user_credentials uc
     JOIN users u ON u.workos_user_id = uc.workos_user_id
     JOIN certification_credentials cc ON cc.id = uc.credential_id
     WHERE uc.awarded_at >= NOW() - INTERVAL '7 days'
     ORDER BY cc.tier DESC, uc.awarded_at DESC`,
  );
  return result.rows;
}

/**
 * Format a Slack message for the weekly credential digest.
 */
function formatDigestMessage(awards: CredentialAward[]) {
  const byCredential = new Map<string, { tier: number; names: string[] }>();
  for (const award of awards) {
    const name = ((award.first_name || '') + ' ' + (award.last_name || '')).trim() || 'A member';
    if (!byCredential.has(award.credential_name)) {
      byCredential.set(award.credential_name, { tier: award.tier, names: [] });
    }
    byCredential.get(award.credential_name)!.names.push(name);
  }

  const text = `This week in the Academy: ${awards.length} credential${awards.length !== 1 ? 's' : ''} earned`;
  const lines: string[] = [`*${text}*`];

  // Sort by tier descending (Specialist first)
  const sorted = [...byCredential.entries()].sort((a, b) => b[1].tier - a[1].tier);
  for (const [credName, { names }] of sorted) {
    lines.push(`\n*${credName}* (${names.length})\n${names.join(', ')}`);
  }

  lines.push('\n<https://agenticadvertising.org/certification|View the Academy>');

  return {
    text,
    blocks: [{
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: lines.join('\n') },
    }],
  };
}

/**
 * Post an immediate celebration for a Specialist (tier 3) credential.
 */
export async function notifySpecialistCredential(
  userName: string,
  credentialName: string,
): Promise<void> {
  try {
    const channel = await getChannelByName('certification');
    if (!channel || channel.slack_channel_id.startsWith('CERT_CHANNEL_')) return;

    await sendChannelMessage(channel.slack_channel_id, {
      text: `${userName} just earned ${credentialName}!`,
      blocks: [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: `*${userName}* just earned *${credentialName}*! :trophy:\nSpecialist credentials require deep protocol mastery through a capstone project. <https://agenticadvertising.org/certification|Learn more>`,
          },
        },
      ],
    });
  } catch (error) {
    logger.error({ error }, 'Failed to post specialist credential notification');
  }
}

/**
 * Run the weekly credential digest job.
 */
export async function runCredentialDigestJob(): Promise<{ awardsFound: number; posted: boolean }> {
  const awards = await getRecentAwards();
  if (awards.length === 0) {
    return { awardsFound: 0, posted: false };
  }

  const channel = await getChannelByName('certification');
  if (!channel || channel.slack_channel_id.startsWith('CERT_CHANNEL_')) {
    logger.info('Certification notification channel not configured, skipping digest');
    return { awardsFound: awards.length, posted: false };
  }

  const message = formatDigestMessage(awards);
  await sendChannelMessage(channel.slack_channel_id, message);

  logger.info({ awardsFound: awards.length }, 'Posted credential digest');
  return { awardsFound: awards.length, posted: true };
}
