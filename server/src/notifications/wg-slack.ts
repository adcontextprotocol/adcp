/**
 * Working-group-aware Slack posting.
 *
 * Automation that posts on behalf of a working group should use these helpers
 * instead of reading `slack_channel_id` directly. They walk up the parent
 * chain when a subgroup has no channel of its own, and prefix messages with
 * `[Subgroup Name]` so members know which group originated the post.
 *
 * Human-facing surfaces (the "Join Slack Channel" button on the public page,
 * admin UI channel display) should keep reading `slack_channel_id` directly —
 * we don't implicitly tell users to join the parent's channel.
 */

import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { sendChannelMessage } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('wg-slack');

const workingGroupDb = new WorkingGroupDatabase();

export interface PostToGroupChannelResult {
  ok: boolean;
  ts?: string;
  error?: string;
  via_parent?: boolean;
  resolved_channel_id?: string;
}

/**
 * Post a message to a working group's Slack channel. If the group has no
 * channel, walk up the parent chain. When posting via a parent, prefix the
 * message text with `[Subgroup Name]`.
 *
 * Returns `{ ok: false, error: 'no-channel' }` if no channel exists in the chain.
 */
export async function postToGroupChannel(
  groupId: string,
  options: SlackBlockMessage,
): Promise<PostToGroupChannelResult> {
  const { channelId, viaParent, group } = await workingGroupDb.resolveNotificationChannel(groupId);

  if (!channelId || !group) {
    logger.warn({ groupId }, 'No Slack channel resolvable for working group');
    return { ok: false, error: 'no-channel' };
  }

  // If a private subgroup is falling back to a public parent's channel, flag it —
  // posting private content to a public channel is almost certainly a leak.
  if (viaParent && group.is_private) {
    logger.warn(
      { groupId, groupSlug: group.slug, parentChannelId: channelId },
      'Private subgroup posting via parent channel — configure its own channel to keep content private',
    );
  }

  const text = viaParent && options.text
    ? `[${group.name}] ${options.text}`
    : options.text;

  const result = await sendChannelMessage(channelId, { ...options, text });
  return { ...result, via_parent: viaParent, resolved_channel_id: channelId };
}
