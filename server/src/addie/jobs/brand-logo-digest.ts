/**
 * Brand Logo Pending-Review Digest
 *
 * Daily summary of brand logos sitting in the moderation queue, posted to
 * the configured admin Slack channel.
 *
 * As of #2568, all new uploads auto-approve at insert time, so the pending
 * queue is permanently empty for any logo uploaded after that change ships.
 * This job remains useful only as a drain for logos that queued before the
 * deploy. It will silently no-op once those historical items clear.
 */

import { logger } from '../../logger.js';
import { BrandLogoDatabase } from '../../db/brand-logo-db.js';
import { getAdminChannel } from '../../db/system-settings-db.js';
import { sendChannelMessage } from '../../slack/client.js';

const DIGEST_PAGE_SIZE = 25;
const STALE_THRESHOLD_HOURS = 12;
const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

function ageLabel(createdAt: Date | string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export interface BrandLogoDigestResult {
  pendingCount: number;
  staleCount: number;
  posted: boolean;
}

export async function runBrandLogoDigestJob(): Promise<BrandLogoDigestResult> {
  const brandLogoDb = new BrandLogoDatabase();
  const pending = await brandLogoDb.getPendingLogos(DIGEST_PAGE_SIZE, 0);

  if (pending.length === 0) {
    return { pendingCount: 0, staleCount: 0, posted: false };
  }

  const cutoff = Date.now() - STALE_THRESHOLD_HOURS * 3_600_000;
  const stale = pending.filter(l => new Date(l.created_at).getTime() <= cutoff);

  if (stale.length === 0) {
    return { pendingCount: pending.length, staleCount: 0, posted: false };
  }

  const adminChan = await getAdminChannel();
  if (!adminChan.channel_id) {
    logger.info({ pendingCount: pending.length, staleCount: stale.length }, 'Brand logo digest: admin Slack channel not configured, skipping post');
    return { pendingCount: pending.length, staleCount: stale.length, posted: false };
  }

  const lines: string[] = [
    `*${stale.length} brand logo${stale.length === 1 ? '' : 's'} pending review* (older than ${STALE_THRESHOLD_HOURS}h)`,
    '',
  ];

  // Cap visible items so a backlog doesn't produce an enormous Slack message
  const VISIBLE = 10;
  const visible = stale.slice(0, VISIBLE);
  for (const logo of visible) {
    const brand = logo.brand_name || logo.domain;
    const uploader = logo.uploaded_by_email || 'unknown uploader';
    const previewUrl = `${BASE_URL}/logos/brands/${logo.domain}/${logo.id}`;
    lines.push(`• *<${previewUrl}|${brand}>* — ${logo.domain} · uploaded by ${uploader} · ${ageLabel(logo.created_at)} ago`);
  }
  if (stale.length > VISIBLE) {
    lines.push(`_…and ${stale.length - VISIBLE} more_`);
  }
  lines.push('', `<${BASE_URL}/admin/brands|Open the moderation queue>`);

  const text = `${stale.length} brand logo${stale.length === 1 ? '' : 's'} pending review`;
  await sendChannelMessage(adminChan.channel_id, {
    text,
    blocks: [{
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: lines.join('\n') },
    }],
  });

  logger.info({ pendingCount: pending.length, staleCount: stale.length, channelId: adminChan.channel_id }, 'Posted brand logo pending-review digest');
  return { pendingCount: pending.length, staleCount: stale.length, posted: true };
}
