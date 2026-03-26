/**
 * Posts tool errors and other actionable Addie errors to the configured error Slack channel.
 *
 * Fire-and-forget: callers should not await this — errors in notification
 * delivery are logged but never propagated.
 */

import { createLogger } from '../logger.js';
import { getErrorChannel } from '../db/system-settings-db.js';
import { sendChannelMessage } from '../slack/client.js';

const logger = createLogger('addie-error-notifier');

/** Minimum interval between posts for the same tool (prevents floods). */
const THROTTLE_MS = 60_000;
const recentErrors = new Map<string, number>();

interface ToolErrorContext {
  toolName: string;
  errorMessage: string;
  /** Slack user ID of the person who triggered the conversation */
  slackUserId?: string;
  /** Addie thread ID for linking to admin view */
  threadId?: string;
  /** Whether the tool threw (true) vs returned an error string (false) */
  threw: boolean;
}

/**
 * Notify the error channel about a tool failure.
 * Safe to call without awaiting — never throws.
 */
export function notifyToolError(ctx: ToolErrorContext): void {
  // Fire-and-forget; catch everything so callers are never affected.
  void _postToolError(ctx).catch((err) => {
    logger.debug({ err, toolName: ctx.toolName }, 'Failed to post tool error notification');
  });
}

async function _postToolError(ctx: ToolErrorContext): Promise<void> {
  // Throttle: skip if we posted about this tool recently
  const now = Date.now();
  const lastPosted = recentErrors.get(ctx.toolName) ?? 0;
  if (now - lastPosted < THROTTLE_MS) return;

  // Prune stale entries
  for (const [key, ts] of recentErrors) {
    if (now - ts >= THROTTLE_MS) recentErrors.delete(key);
  }

  const setting = await getErrorChannel();
  if (!setting.channel_id) return;

  recentErrors.set(ctx.toolName, now);

  const userLine = ctx.slackUserId ? `*User:* <@${ctx.slackUserId}>` : '*User:* unknown';
  const threadLine = ctx.threadId
    ? `<https://agenticadvertising.org/admin/addie?thread=${ctx.threadId}|View thread>`
    : '';
  const kind = ctx.threw ? 'Tool exception' : 'Tool error';

  const lines = [
    `:warning: *${kind}: ${ctx.toolName}*`,
    '',
    `> ${ctx.errorMessage.substring(0, 500)}`,
    '',
    userLine,
    threadLine,
  ].filter(Boolean);

  await sendChannelMessage(setting.channel_id, { text: lines.join('\n') });
}
