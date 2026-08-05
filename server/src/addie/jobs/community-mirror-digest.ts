/** Daily reminder for community-mirror proposals waiting on expert review. */
import { CommunityMirrorDatabase } from '../../db/community-mirror-db.js';
import { getAdminChannel } from '../../db/system-settings-db.js';
import { createLogger } from '../../logger.js';
import { sendChannelMessage } from '../../slack/client.js';

const logger = createLogger('community-mirror-digest');
const STALE_THRESHOLD_HOURS = 12;
const PAGE_SIZE = 50;
const VISIBLE_ITEMS = 10;
const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

function ageLabel(createdAt: string): string {
  const hours = Math.floor((Date.now() - new Date(createdAt).getTime()) / 3_600_000);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
export interface CommunityMirrorDigestResult {
  pendingCount: number;
  staleCount: number;
  posted: boolean;
}

export async function runCommunityMirrorDigestJob(): Promise<CommunityMirrorDigestResult> {
  const mirrorDb = new CommunityMirrorDatabase();
  const result = await mirrorDb.listProposals({ status: 'pending', limit: PAGE_SIZE });
  if (result.total === 0) return { pendingCount: 0, staleCount: 0, posted: false };

  const cutoff = Date.now() - STALE_THRESHOLD_HOURS * 3_600_000;
  const stale = result.proposals.filter(
    (proposal) => new Date(proposal.proposed_at).getTime() <= cutoff,
  );
  if (stale.length === 0) {
    return { pendingCount: result.total, staleCount: 0, posted: false };
  }

  const adminChannel = await getAdminChannel();
  if (!adminChannel.channel_id) {
    logger.info(
      { pendingCount: result.total, staleCount: stale.length },
      'Community-mirror digest: admin Slack channel not configured, skipping post',
    );
    return { pendingCount: result.total, staleCount: stale.length, posted: false };
  }

  const visible = stale.slice(0, VISIBLE_ITEMS);
  const lines = [
    `*${stale.length} community mirror proposal${stale.length === 1 ? '' : 's'} pending review* (older than ${STALE_THRESHOLD_HOURS}h)`,
    '',
    ...visible.map((proposal) => `• *${proposal.platform}* · ${ageLabel(proposal.proposed_at)} ago`),
  ];
  if (stale.length > VISIBLE_ITEMS) lines.push(`_…and ${stale.length - VISIBLE_ITEMS} more_`);
  lines.push('', `<${BASE_URL}/admin/community-mirrors|Open the moderation queue>`);

  await sendChannelMessage(adminChannel.channel_id, {
    text: `${stale.length} community mirror proposal${stale.length === 1 ? '' : 's'} pending review`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  });
  logger.info(
    { pendingCount: result.total, staleCount: stale.length, channelId: adminChannel.channel_id },
    'Posted community-mirror pending-review digest',
  );
  return { pendingCount: result.total, staleCount: stale.length, posted: true };
}
