/**
 * Posts tool errors and system-level errors to the configured error Slack channel.
 *
 * Fire-and-forget: callers should not await this — errors in notification
 * delivery are logged but never propagated.
 */

import { createLogger, processRole } from '../logger.js';
import { getErrorChannel } from '../db/system-settings-db.js';
import { sendChannelMessage } from '../slack/client.js';

const logger = createLogger('addie-error-notifier');

/** Minimum interval between posts for the same key (prevents floods). */
const THROTTLE_MS = 60_000;
/** Longer throttle for system errors — one alert per 5 minutes per source. */
const SYSTEM_THROTTLE_MS = 5 * 60_000;
const recentErrors = new Map<string, number>();

/** Cached error channel to avoid hitting DB during DB outages. */
let cachedErrorChannel: { channel_id: string | null; channel_name: string | null } | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60_000;

async function getCachedErrorChannel() {
  const now = Date.now();
  if (cachedErrorChannel && now < cacheExpiry) return cachedErrorChannel;
  try {
    cachedErrorChannel = await getErrorChannel();
    cacheExpiry = now + CACHE_TTL_MS;
  } catch {
    // DB is down — use whatever we cached last
  }
  return cachedErrorChannel;
}

interface ToolErrorContext {
  toolName: string;
  errorMessage: string;
  /** Slack user ID of the person who triggered the conversation */
  slackUserId?: string;
  /** Fallback display name when slackUserId is unavailable (e.g. web chat users) */
  userDisplayName?: string;
  /** Addie thread ID for linking to admin view */
  threadId?: string;
  /** Whether the tool threw (true) vs returned an error string (false) */
  threw: boolean;
  /** Tool input parameters — included in notification for debugging */
  toolInput?: Record<string, unknown>;
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

interface SystemErrorContext {
  source: string;
  errorMessage: string;
}

/**
 * Notify the error channel about a system-level failure
 * (DB pool errors, job failures, health check degradation).
 * Safe to call without awaiting — never throws.
 */
export function notifySystemError(ctx: SystemErrorContext): void {
  void _postSystemError(ctx).catch((err) => {
    logger.debug({ err, source: ctx.source }, 'Failed to post system error notification');
  });
}

function pruneStaleEntries(now: number): void {
  for (const [key, ts] of recentErrors) {
    const threshold = key.startsWith('system:') ? SYSTEM_THROTTLE_MS : THROTTLE_MS;
    if (now - ts >= threshold) recentErrors.delete(key);
  }
}

async function _postToolError(ctx: ToolErrorContext): Promise<void> {
  const now = Date.now();
  const throttleKey = `tool:${ctx.toolName}`;
  const lastPosted = recentErrors.get(throttleKey) ?? 0;
  if (now - lastPosted < THROTTLE_MS) return;
  pruneStaleEntries(now);

  const setting = await getCachedErrorChannel();
  if (!setting?.channel_id) {
    logger.warn({ toolName: ctx.toolName, error: ctx.errorMessage.substring(0, 200) },
      'Tool error occurred but no error_slack_channel configured — alert dropped');
    return;
  }

  recentErrors.set(throttleKey, now);

  const userLine = ctx.slackUserId
    ? `*User:* <@${ctx.slackUserId}>`
    : ctx.userDisplayName
      ? `*User:* ${ctx.userDisplayName.replace(/[<>&*_~`]/g, '')} (web)`
      : '*User:* unknown';
  const threadLine = ctx.threadId
    ? `<https://agenticadvertising.org/admin/addie?thread=${ctx.threadId}|View thread>`
    : '';
  const kind = ctx.threw ? 'Tool exception' : 'Tool error';

  const sensitivePattern = /password|token|secret|key|auth|credential/i;
  const inputLine = ctx.toolInput
    ? `*Input:* \`${(() => {
        const raw = JSON.stringify(ctx.toolInput, (key, val) =>
          key && sensitivePattern.test(key) ? '[redacted]' : val
        );
        return raw.length > 300 ? raw.substring(0, 300) + '...' : raw;
      })()}\``
    : '';

  const lines = [
    `:warning: *${kind}: ${ctx.toolName}*`,
    '',
    `> ${ctx.errorMessage.substring(0, 500)}`,
    '',
    inputLine,
    userLine,
    threadLine,
  ].filter(Boolean);

  await sendChannelMessage(setting.channel_id, { text: lines.join('\n') }, { requirePrivate: true });
}

async function _postSystemError(ctx: SystemErrorContext): Promise<void> {
  const now = Date.now();
  const throttleKey = `system:${ctx.source}`;
  const lastPosted = recentErrors.get(throttleKey) ?? 0;
  if (now - lastPosted < SYSTEM_THROTTLE_MS) return;
  pruneStaleEntries(now);

  const setting = await getCachedErrorChannel();
  if (!setting?.channel_id) {
    logger.warn({ source: ctx.source, error: ctx.errorMessage.substring(0, 200) },
      'System error occurred but no error_slack_channel configured — alert dropped');
    return;
  }

  recentErrors.set(throttleKey, now);

  const quoted = ctx.errorMessage.substring(0, 500).split('\n').map(line => `> ${line}`).join('\n');
  const lines = [
    `:rotating_light: *System error: ${ctx.source}* [${processRole}]`,
    '',
    quoted,
  ];

  await sendChannelMessage(setting.channel_id, { text: lines.join('\n') }, { requirePrivate: true });
}
